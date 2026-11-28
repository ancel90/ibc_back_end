// Route temporaire : copie dans la bibliothèque les articles déjà notés des jours en base.
// Elle peut être relancée sans risque (un article déjà présent n'est jamais modifié).
// À supprimer une fois la reprise terminée.
const { MongoClient } = require('mongodb');
const { accesUtilisateur, cors } = require('../lib/securite');
const { copierDansBibliotheque } = require('../lib/bibliotheque');

const uri = process.env.MONGODB_URI;
const BUDGET_MS = 40000; // au-delà, on s'arrête proprement et on indique où reprendre

let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(uri);
  await client.connect();
  cachedDb = client.db('ibc_db');
  return cachedDb;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;
  if (!accesUtilisateur(req, res)) return;

  const debut = Date.now();

  try {
    const database = await connectDB();

    // Jours disponibles : collections aaaammjj_rssfiltreia, du plus récent au plus ancien
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    let jours = collections
      .map((c) => c.name.match(/^(\d{8})_rssfiltreia$/))
      .filter(Boolean)
      .map((m) => m[1])
      .sort()
      .reverse();

    // Paramètre facultatif : a_partir_de=aaaammjj (reprend à ce jour, puis les plus anciens)
    const depuis = req.query && req.query.a_partir_de ? String(req.query.a_partir_de) : null;
    if (depuis) jours = jours.filter((j) => j <= depuis);

    let ajoutes = 0;
    let prochain = null;
    const traites = [];

    for (let i = 0; i < jours.length; i++) {
      if (Date.now() - debut > BUDGET_MS) {
        prochain = jours[i];
        break;
      }
      const docs = await database.collection(`${jours[i]}_rssfiltreia`).find({}).toArray();
      const n = await copierDansBibliotheque(database, docs, jours[i]);
      ajoutes += n;
      traites.push({ jour: jours[i], lus: docs.length, ajoutes: n });
    }

    return res.status(200).json({
      success: true,
      termine: prochain === null,
      prochain,
      total_ajoutes: ajoutes,
      jours: traites
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};