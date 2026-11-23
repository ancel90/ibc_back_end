const { MongoClient } = require('mongodb');
const { accesUtilisateur, cors } = require('../lib/securite');

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
  // Gestion CORS : seul le site de la Chouette est autorisé
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;

  // Accès réservé : jeton de connexion obligatoire
  if (!accesUtilisateur(req, res)) return;

  try {
    const database = await connectDB();

    // Date demandée (aaaammjj) ; par défaut, le jour du résumé le plus récent
    let date = req.query && req.query.date;
    if (date && !/^\d{8}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'Date invalide (format aaaammjj)' });
    }
    if (!date) {
      const dernier = await database
        .collection('resumes')
        .find({})
        .sort({ _id: -1 })
        .limit(1)
        .toArray();
      if (dernier.length === 0) {
        return res.status(200).json({ success: true, date: null, favorables: [], defavorables: [] });
      }
      date = dernier[0]._id;
    }

    // Articles notés par l'IA pour ce jour
    const articles = await database
      .collection(`${date}_rssfiltreia`)
      .find({}, { projection: { _id: 0 } })
      .toArray();

    return res.status(200).json({
      success: true,
      date,
      favorables: articles.filter(a => a.favorable === 1),
      defavorables: articles.filter(a => a.favorable === -1)
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};