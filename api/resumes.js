const { MongoClient } = require('mongodb');
const { accesUtilisateur } = require('../lib/securite');

const uri = process.env.MONGODB_URI;
let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(uri);
  await client.connect();
  cachedDb = client.db('ibc_db');
  return cachedDb;
}

module.exports = async (req, res) => {
  // Gestion CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Accept, Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Accès réservé : jeton de connexion obligatoire
  if (!accesUtilisateur(req, res)) return;

  try {
    const database = await connectDB();

    // Nombre de jours demandé (30 par défaut, 90 maximum)
    let jours = parseInt(req.query && req.query.jours, 10);
    if (!jours || jours < 1) jours = 30;
    if (jours > 90) jours = 90;

    // Les résumés les plus récents d'abord, puis on remet dans l'ordre chronologique
    const resumes = await database
      .collection('resumes')
      .find({})
      .sort({ _id: -1 })
      .limit(jours)
      .toArray();
    resumes.reverse();

    return res.status(200).json({ success: true, resumes });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};