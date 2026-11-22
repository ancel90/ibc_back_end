const { MongoClient } = require('mongodb');
const { acces } = require('../lib/securite');

const uri = process.env.MONGODB_URI;
let cachedDb = null;

// Nombre de jours conservés (le dernier jour terminé et les 29 précédents)
const JOURS_CONSERVES = 30;

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

// Date limite (aaaammjj) : les collections datées avant ce jour sont effacées
function dateLimite() {
  const fini = dateJourFini();
  const annee = Number(fini.slice(0, 4));
  const mois = Number(fini.slice(4, 6));
  const jour = Number(fini.slice(6, 8));
  const limite = new Date(Date.UTC(annee, mois - 1, jour - (JOURS_CONSERVES - 1)));
  return limite.toISOString().slice(0, 10).replace(/-/g, '');
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

  // Accès réservé : le code secret est obligatoire (cette route efface des données)
  if (!acces(req, res)) return;

  try {
    // Mode essai (?essai=1) : on liste ce qui serait effacé, sans rien supprimer
    const essai = req.query.essai === '1';

    const database = await connectDB();
    const limite = dateLimite();

    // 1. Collections datées trop anciennes (seuls les noms au format aaaammjj_rss... sont concernés)
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const modele = /^(\d{8})_(rssbrut|rssfiltremotscles|rssfiltreia)$/;
    const aEffacer = collections
      .map((c) => c.name)
      .filter((nom) => {
        const trouve = modele.exec(nom);
        return trouve && trouve[1] < limite;
      })
      .sort();

    // 2. Lignes du journal du cron de plus de 30 jours
    const dateJournal = new Date(Date.now() - JOURS_CONSERVES * 24 * 60 * 60 * 1000);
    const journal = database.collection('journal_cron');
    const lignesJournal = await journal.countDocuments({ lance_le: { $lt: dateJournal } });

    // 3. Effacement (sauf en mode essai)
    if (!essai) {
      for (const nom of aEffacer) {
        await database.collection(nom).drop();
      }
      if (lignesJournal > 0) {
        await journal.deleteMany({ lance_le: { $lt: dateJournal } });
      }
    }

    return res.status(200).json({
      success: true,
      essai,
      message: `${essai ? 'À effacer' : 'Effacé'} : ${aEffacer.length} collection(s) et ${lignesJournal} ligne(s) de journal de plus de ${JOURS_CONSERVES} jours`,
      collections: aEffacer,
      lignes_journal: lignesJournal
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};