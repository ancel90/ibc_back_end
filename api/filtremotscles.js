const { MongoClient } = require('mongodb');
const { acces } = require('../lib/securite');

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

// Met en minuscules et retire les accents (armée -> armee)
function normaliser(texte) {
  return String(texte || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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
    const database = await connectDB();

    const dateStr = dateJourFini();

    // 1. Lire les mots clés
    const docMots = await database.collection('mots_cles').findOne({});
    const motsCles = ((docMots && docMots.mots_cles) || [])
      .map(normaliser)
      .filter(m => m.length > 0);

    if (motsCles.length === 0) {
      return res.status(200).json({ success: false, message: 'Aucun mot clé trouvé dans mots_cles' });
    }

    // 2. Lire les articles du jour
    const sourceName = `${dateStr}_rssbrut`;
    const articles = await database.collection(sourceName).find({}).toArray();

    // 3. Filtrer
    const retenus = [];
    for (const art of articles) {
      const texte = normaliser(art.titre) + ' ' + normaliser(art.article);
      const trouves = motsCles.filter(m => texte.includes(m));
      if (trouves.length > 0) {
        const { _id, ...reste } = art;
        retenus.push({ ...reste, mots_cles_trouves: trouves });
      }
    }

    // 4. Enregistrer (on repart d'une collection vide pour éviter les doublons)
    const destName = `${dateStr}_rssfiltremotscles`;
    const destCollection = database.collection(destName);
    await destCollection.deleteMany({});
    if (retenus.length > 0) {
      await destCollection.insertMany(retenus);
    }

    return res.status(200).json({
      success: true,
      message: `${retenus.length} articles retenus sur ${articles.length}`,
      collection: destName
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};