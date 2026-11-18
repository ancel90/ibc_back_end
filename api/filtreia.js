const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const geminiKey = process.env.GEMINI_API_KEY;
const MODELE = 'gemini-3.5-flash';

// Réglages
const TAILLE_LOT = 10;          // articles notés par requête Gemini
const DELAI_APPEL_MS = 25000;   // durée maximale d'un appel
const BUDGET_TOTAL_MS = 45000;  // durée maximale pour tout noter
const ESPACEMENT_MS = 12000;    // palier gratuit : 5 requêtes par minute au maximum
const ESSAIS_MAX = 3;           // essais par groupe (erreurs passagères seulement)
const LONGUEUR_EXTRAIT = 600;   // caractères de l'article envoyés à Gemini

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

function couper(texte, max) {
  const t = String(texte || '').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// Un appel à Gemini, avec une durée maximale
async function appelGemini(prompt, delaiMs, reflexionBasse) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), delaiMs);

  const config = { temperature: 0 };
  if (reflexionBasse) config.thinkingConfig = { thinkingLevel: 'low' };

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
          generationConfig: config
        }),
        signal: controleur.signal
      }
    );

    const data = await reponse.json();
    if (!reponse.ok) {
      const erreur = new Error((data.error && data.error.message) || `Erreur Gemini ${reponse.status}`);
      erreur.statut = reponse.status;
      // Erreur passagère (surcharge, lenteur) : on peut réessayer. Quota (429) : inutile.
      erreur.passager = [500, 502, 503, 504].includes(reponse.status);
      throw erreur;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const erreur = new Error(`Gemini trop lent (plus de ${Math.round(delaiMs / 1000)} s)`);
      erreur.statut = 0;
      erreur.passager = true;
      throw erreur;
    }
    throw e;
  } finally {
    clearTimeout(minuteur);
  }
}

// Note un groupe d'articles en une seule requête : renvoie une liste de -1, 0 ou 1
async function noterLot(lot, fin) {
  const lignes = lot
    .map((art, i) => `${i + 1}. Titre : ${art.titre}\nTexte : ${couper(art.article, LONGUEUR_EXTRAIT)}`)
    .join('\n\n');

  const prompt =
    "Tu es un analyste de veille médiatique. Pour chacun des articles numérotés ci-dessous, " +
    "détermine s'il est défavorable (-1), neutre (0) ou favorable (1) pour les armées françaises. " +
    "Réponds uniquement par une liste JSON de nombres, dans l'ordre des articles, " +
    "par exemple [0,1,-1]. Aucun autre texte.\n\n" +
    lignes;

  let reflexionBasse = true;
  let derniereErreur = null;

  for (let essai = 1; essai <= ESSAIS_MAX; essai++) {
    const reste = fin - Date.now();
    if (reste < 3000) break;

    try {
      const data = await appelGemini(prompt, Math.min(DELAI_APPEL_MS, reste), reflexionBasse);

      const parts =
        (data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts) || [];
      const texte = parts.map((p) => p.text || '').join('');

      const liste = texte.match(/\[[^\]]*\]/);
      if (!liste) throw new Error(`Réponse inattendue : ${texte}`);

      let notes;
      try {
        notes = JSON.parse(liste[0]);
      } catch (e) {
        throw new Error(`Réponse inattendue : ${texte}`);
      }
      if (!Array.isArray(notes) || notes.length !== lot.length ||
          !notes.every((n) => [-1, 0, 1].includes(n))) {
        throw new Error(`Réponse inattendue : ${texte}`);
      }
      return notes;
    } catch (e) {
      derniereErreur = e;
      // Si le réglage de réflexion est refusé, on réessaie sans lui
      if (e.statut === 400 && /think/i.test(e.message) && reflexionBasse) {
        reflexionBasse = false;
        continue;
      }
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

    // 2. Noter les articles par groupes, l'un après l'autre
    const resultats = [];
    let nonNotes = 0;
    let premiereErreur = null;
    let dernierDepart = 0;

    for (let i = 0; i < articles.length; i += TAILLE_LOT) {
      const lot = articles.slice(i, i + TAILLE_LOT);

      // Respect de la limite de requêtes par minute
      if (dernierDepart) {
        const attente = ESPACEMENT_MS - (Date.now() - dernierDepart);
        if (attente > 0) {
          if (Date.now() + attente >= fin) {
            nonNotes += articles.length - i;
            if (!premiereErreur) premiereErreur = 'Temps imparti épuisé avant la fin des notations';
            break;
          }
          await pause(attente);
        }
      }
      dernierDepart = Date.now();

      try {
        const notes = await noterLot(lot, fin);
        lot.forEach((art, k) => {
          const { _id, ...reste } = art;
          resultats.push({ ...reste, favorable: notes[k] });
        });
      } catch (e) {
        console.error(e.message);
        nonNotes += lot.length;
        if (!premiereErreur) premiereErreur = e.message;
        // Quota dépassé : inutile de continuer
        if (e.statut === 429) {
          nonNotes += articles.length - (i + lot.length);
          break;
        }
      }
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
      message: `${resultats.length} articles notés sur ${articles.length} (${nonNotes} non notés)`,
      collection: destName,
      premiereErreur: premiereErreur
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};