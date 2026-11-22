const { MongoClient } = require('mongodb');
const { accesUtilisateur } = require('../lib/securite');

const uri = process.env.MONGODB_URI;
let cachedDb = null;

// Nombre de caractères du texte de chaque article envoyés au site
const LONGUEUR_TEXTE = 400;

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

// Liste des n derniers jours terminés (aaaammjj), du plus récent au plus ancien
function listeJours(n) {
  const fini = dateJourFini();
  const annee = Number(fini.slice(0, 4));
  const mois = Number(fini.slice(4, 6));
  const jour = Number(fini.slice(6, 8));
  const jours = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(annee, mois - 1, jour - i));
    jours.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return jours;
}

// Raccourcit un texte trop long
function couper(texte, max) {
  const t = String(texte || '').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

module.exports = async (req, res) => {
  // Gestion CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Accept, Content-Type, Authorization');
  // Réponse gardée 10 minutes dans le navigateur du visiteur seulement (jamais dans un cache partagé,
  // sinon la connexion serait contournée)
  res.setHeader('Cache-Control', 'private, max-age=600');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Accès réservé : jeton de connexion obligatoire
  if (!accesUtilisateur(req, res)) return;

  try {
    // Nombre de jours demandés (7 par défaut, 14 au maximum)
    const n = Math.min(Math.max(parseInt(req.query.jours, 10) || 7, 1), 14);

    const database = await connectDB();
    const jours = listeJours(n);

    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const noms = new Set(collections.map((c) => c.name));

    // Articles retenus par le filtre de mots clés, jour par jour (champs utiles seulement)
    const listes = await Promise.all(
      jours.map(async (date) => {
        const nom = `${date}_rssfiltremotscles`;
        if (!noms.has(nom)) return [];
        const docs = await database
          .collection(nom)
          .find({}, {
            projection: { _id: 0, titre: 1, article: 1, lien: 1, source: 1, pays: 1, type: 1, publie_le: 1 }
          })
          .toArray();
        return docs.map((d) => ({
          date,
          titre: d.titre || '',
          texte: couper(d.article, LONGUEUR_TEXTE),
          lien: d.lien || '',
          source: d.source || '',
          pays: d.pays || '',
          type: d.type || '',
          publie_le: d.publie_le || ''
        }));
      })
    );

    // Chaque article une seule fois (même lien), les plus récents d'abord
    const vus = new Set();
    const articles = [];
    for (const liste of listes) {
      for (const a of liste) {
        const cle = a.lien || `${a.source}|${a.titre}`;
        if (vus.has(cle)) continue;
        vus.add(cle);
        articles.push(a);
      }
    }
    articles.sort((a, b) => String(b.publie_le).localeCompare(String(a.publie_le)));

    // Mots à ne pas retenir dans le nuage
    const doc = await database.collection('mots_ignores').findOne({});
    const motsIgnores = doc && Array.isArray(doc.mots) ? doc.mots : [];

    return res.status(200).json({
      success: true,
      nombre_articles: articles.length,
      nombre_mots_ignores: motsIgnores.length,
      jours,
      articles,
      mots_ignores: motsIgnores
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};