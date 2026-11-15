const Parser = require('rss-parser');
const parser = new Parser();
const { MongoClient } = require('mongodb');

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

// Liste des flux : adresse, nom du média, pays émetteur
const FEEDS = [
  { url: 'https://www.lemonde.fr/rss/une.xml', source: 'Le Monde', pays: 'france' },
  { url: 'https://www.lefigaro.fr/rss/figaro_actualites.xml', source: 'Le Figaro', pays: 'france' }
];

module.exports = async (req, res) => {
  // Gestion CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const database = await connectDB();

    const dateStr = dateJourFini();

    let articles = [];

    for (const flux of FEEDS) {
      const feed = await parser.parseURL(flux.url);

      for (const item of feed.items) {
        articles.push({
          date: dateStr,
          source: flux.source,
          pays: flux.pays,
          titre: item.title || '',
          article: item.contentSnippet || item.content || '',
          favorable: 0
        });
      }
    }

    const collectionName = `${dateStr}_rssbrut`;
    const collection = database.collection(collectionName);

    // On remplace le contenu du jour (pas de doublons)
    if (articles.length > 0) {
      await collection.deleteMany({});
      await collection.insertMany(articles);
    }

    return res.status(200).json({
      success: true,
      message: `${articles.length} articles enregistrés avec succès`,
      collection: collectionName
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};