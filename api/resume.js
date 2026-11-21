const { MongoClient } = require('mongodb');
const { acces } = require('../lib/securite');
const { calculerResume } = require('../lib/calcul-resume');

const uri = process.env.MONGODB_URI;
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

  // Accès réservé : le code secret est obligatoire
  if (!acces(req, res)) return;

  try {
    // Jour demandé (?date=aaaammjj), sinon le jour qui vient de finir
    const fini = dateJourFini();
    const dateStr = req.query.date || fini;
    if (!/^\d{8}$/.test(dateStr) || dateStr > fini) {
      return res.status(400).json({
        success: false,
        error: 'Date invalide : utiliser le format aaaammjj, au plus le dernier jour terminé'
      });
    }

    const database = await connectDB();
    const nombres = await calculerResume(database, dateStr);

    return res.status(200).json({
      success: true,
      message: `Résumé du ${dateStr} enregistré (${nombres.integres} intégrés, ${nombres.retenus} retenus, ${nombres.notes} notés)`,
      collection: 'resumes'
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};