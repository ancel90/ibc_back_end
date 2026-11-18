const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const geminiKey = process.env.GEMINI_API_KEY;
const MODELE = 'gemini-3.5-flash';

// Réglages de robustesse
const DELAI_APPEL_MS = 20000;   // durée maximale d'un appel à Gemini
const BUDGET_TOTAL_MS = 45000;  // durée maximale pour noter tous les articles
const ESSAIS_MAX = 3;           // nombre d'essais par article

let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(uri);
  await client.connect();
  cachedDb = client.db('ibc_db');
  return cachedDb;
}

// Date (aaaammjj) du jour qui vient de finir, à l'heure de Paris
function dateJourFini() {
  const aujourdhui = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date()); // ex : 2026-11-16
  const [annee, mois, jour] = aujourdhui.split('-').map(Number);
  const veille = new Date(Date.UTC(annee, mois - 1, jour - 1));
  return veille.toISOString().slice(0, 10).replace(/-/g, '');
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un appel à Gemini, avec une durée maximale. Les erreurs passagères sont marquées.
async function appelGemini(prompt, delaiMs) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), delaiMs);

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
          generationConfig: { temperature: 0 }
        }),
        signal: controleur.signal
      }
    );

    const data = await reponse.json();
    if (!reponse.ok) {
      const erreur = new Error((data.error && data.error.message) || `Erreur Gemini ${reponse.status}`);
      erreur.passager = [429, 500, 502, 503, 504].includes(reponse.status);
      throw erreur;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const erreur = new Error(`Gemini trop lent (plus de ${Math.round(delaiMs / 1000)} s)`);
      erreur.passager = true;
      throw erreur;
    }
    throw e;
  } finally {
    clearTimeout(minuteur);
  }
}

// Demande à Gemini : renvoie -1, 0 ou 1 (jusqu'à ESSAIS_MAX essais)
async function noterArticle(titre, article, fin) {
  const prompt =
    "Tu es un analyste de veille médiatique. Détermine si l'article ci-dessous est " +
    "défavorable, neutre ou favorable pour les armées françaises. " +
    "Réponds uniquement par un nombre : -1 (défavorable), 0 (neutre) ou 1 (favorable). " +
    "Aucun autre texte.\n\n" +
    `Titre : ${titre}\nArticle : ${article}`;

  let derniereErreur = null;

  for (let essai = 1; essai <= ESSAIS_MAX; essai++) {
    const reste = fin - Date.now();
    if (reste < 3000) break;

    try {
      const data = await appelGemini(prompt, Math.min(DELAI_APPEL_MS, reste));

      const parts =
        (data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts) || [];
      const texte = parts.map((p) => p.text || '').join('');
      const trouve = texte.match(/-1|0|1/);
      if (!trouve) throw new Error(`Réponse inattendue : ${texte}`);
      return parseInt(trouve[0], 10);
    } catch (e) {
      derniereErreur = e;
      if (!e.passager || essai === ESSAIS_MAX) break;
      await pause(2000 * essai);
    }
  }

  throw derniereErreur || new Error('Temps imparti épuisé avant la fin des notations');
}

module.exports = async (req, res) => {
  // Gestion CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Accept, Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    if (!geminiKey) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY manquante dans Vercel' });
    }

    const database = await connectDB();

    const dateStr = dateJourFini();
    const fin = Date.now() + BUDGET_TOTAL_MS;

    // 1. Lire les articles déjà filtrés par mots clés
    const sourceName = `${dateStr}_rssfiltremotscles`;
    const articles = await database.collection(sourceName).find({}).toArray();

    // 2. Noter chaque article (5 à la fois)
    const resultats = [];
    let erreurs = 0;
    let premiereErreur = null;
    for (let i = 0; i < articles.length; i += 5) {
      const lot = articles.slice(i, i + 5);
      const notes = await Promise.all(
        lot.map(async (art) => {
          try {
            const valeur = await noterArticle(art.titre, art.article, fin);
            const { _id, ...reste } = art;
            return { ...reste, favorable: valeur };
          } catch (e) {
            console.error(e.message);
            erreurs++;
            if (!premiereErreur) premiereErreur = e.message;
            return null;
          }
        })
      );
      resultats.push(...notes.filter((n) => n !== null));
    }

    // 3. Échec total : on le signale sans effacer la collection existante
    if (articles.length > 0 && resultats.length === 0) {
      return res.status(502).json({
        success: false,
        message: `Aucun article noté sur ${articles.length}. Première erreur : ${premiereErreur}`,
        premiereErreur: premiereErreur
      });
    }

    // 4. Enregistrer (collection vidée avant, pour éviter les doublons)
    const destName = `${dateStr}_rssfiltreia`;
    const destCollection = database.collection(destName);
    await destCollection.deleteMany({});
    if (resultats.length > 0) {
      await destCollection.insertMany(resultats);
    }

    return res.status(200).json({
      success: true,
      message: `${resultats.length} articles notés sur ${articles.length} (${erreurs} erreurs)`,
      collection: destName,
      premiereErreur: premiereErreur
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};