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

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;

    const feeds = [
      'https://www.lemonde.fr/rss/une.xml',
      'https://s1.rss.figaro.fr/rss/figaro_actualites.xml'
    ];

    let articles = [];

    for (const feedUrl of feeds) {
      const feed = await parser.parseURL(feedUrl);
      const sourceName = feedUrl.includes('lemonde') ? 'Le Monde' : 'Le Figaro';

      for (const item of feed.items) {
        articles.push({
          date: dateStr,
          source: sourceName,
          titre: item.title || '',
          article: item.contentSnippet || item.content || '',
          favorable: 0
        });
      }
    }

    const collectionName = `${dateStr}_rssbrut`;
    const collection = database.collection(collectionName);

    if (articles.length > 0) {
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