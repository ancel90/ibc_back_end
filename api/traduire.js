const { MongoClient } = require('mongodb');
const { accesUtilisateur, cors } = require('../lib/securite');

const uri = process.env.MONGODB_URI;
const geminiKey = process.env.GEMINI_API_KEY;
const MODELE = 'gemini-3.5-flash';

// Réglages
const LIMITE_PAR_JOUR = 300;   // traductions à la demande autorisées par jour
const MAX_TITRE = 300;         // caractères de titre acceptés
const MAX_TEXTE = 600;         // caractères d'extrait acceptés
const DELAI_MS = 25000;        // durée maximale de l'appel à Gemini

let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(uri);
  await client.connect();
  cachedDb = client.db('ibc_db');
  return cachedDb;
}

// Date du jour (aaaammjj) à l'heure de Paris
function dateDuJour() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date()).replace(/-/g, '');
}

// Compte une traduction ; renvoie false si la limite du jour est atteinte
async function compterTraduction(database) {
  const collection = database.collection('compteurs');
  const jour = dateDuJour();
  const doc = await collection.findOne({ _id: 'traductions' });

  if (!doc || doc.jour !== jour) {
    await collection.replaceOne({ _id: 'traductions' }, { _id: 'traductions', jour, nb: 1 }, { upsert: true });
    return true;
  }
  if (doc.nb >= LIMITE_PAR_JOUR) return false;

  await collection.updateOne({ _id: 'traductions' }, { $inc: { nb: 1 } });
  return true;
}

async function appelGemini(prompt) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), DELAI_MS);

  try {
    const reponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELE}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: 'low' }
          }
        }),
        signal: controleur.signal
      }
    );

    const data = await reponse.json();
    if (!reponse.ok) {
      throw new Error((data.error && data.error.message) || `Erreur Gemini ${reponse.status}`);
    }
    return data;
  } finally {
    clearTimeout(minuteur);
  }
}

module.exports = async (req, res) => {
  // Gestion CORS : seul le site de la Chouette est autorisé
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  // Accès réservé : jeton de connexion obligatoire (cette route coûte de l'argent)
  if (!accesUtilisateur(req, res)) return;

  try {
    if (!geminiKey) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY manquante dans Vercel' });
    }

    const corps = req.body || {};
    const titre = String(corps.titre || '').trim().slice(0, MAX_TITRE);
    const texte = String(corps.texte || '').trim().slice(0, MAX_TEXTE);
    if (!titre && !texte) {
      return res.status(400).json({ success: false, error: 'Rien à traduire' });
    }

    const database = await connectDB();
    if (!(await compterTraduction(database))) {
      return res.status(429).json({
        success: false,
        error: 'Limite de traductions atteinte pour aujourd\'hui'
      });
    }

    const prompt =
      "Traduis en français le titre et le texte ci-dessous. Détecte aussi la langue d'origine. " +
      "Si le texte est déjà en français, recopie-le tel quel. " +
      "Réponds uniquement par un objet JSON de la forme " +
      '{"langue":"nom de la langue en français","titre":"...","texte":"..."}.\n\n' +
      `Titre : ${titre}\n\nTexte : ${texte}`;

    const data = await appelGemini(prompt);
    const parts =
      (data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts) || [];
    const brut = parts.map((p) => p.text || '').join('');

    let resultat;
    try {
      resultat = JSON.parse(brut);
    } catch (e) {
      throw new Error('Réponse inattendue de Gemini');
    }

    return res.status(200).json({
      success: true,
      langue: String(resultat.langue || ''),
      titre_fr: String(resultat.titre || ''),
      texte_fr: String(resultat.texte || '')
    });

  } catch (error) {
    console.error(error);
    const message = error.name === 'AbortError' ? 'Gemini trop lent, réessayez' : error.message;
    return res.status(500).json({ success: false, error: message });
  }
};