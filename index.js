const Parser = require('rss-parser');
const parser = new Parser();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let db;

async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db('ibc_db');
    console.log("Connecté à MongoDB avec succès");
  }
  return db;
}

// Route de statut
app.get('/api/status', async (req, res) => {
  try {
    await connectDB();
    res.json({ status: "OK", message: "Back-end connecté à MongoDB" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route pour écrire des données dans MongoDB (POST)
app.post('/api/data', async (req, res) => {
  try {
    const database = await connectDB();
    const collection = database.collection('entries');
    const result = await collection.insertOne(req.body);
    res.status(201).json({ message: "Donnée enregistrée avec succès", id: result.insertedId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route pour lire les données de MongoDB (GET)
app.get('/api/data', async (req, res) => {
  try {
    const database = await connectDB();
    const collection = database.collection('entries');
    const data = await collection.find({}).toArray();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route pour récupérer et enregistrer les flux RSS du jour
app.get('/api/fetch-rss', async (req, res) => {
  try {
    const database = await connectDB();

    // 1. Génération de la date au format aaaammdd
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}${month}${day}`;

    // 2. Liste des flux RSS (Le Monde et Le Figaro)
    const feeds = [
      'https://www.lemonde.fr/rss/une.xml',
      'https://s1.rss.figaro.fr/rss/figaro_actualites.xml'
    ];

    let articles = [];

    // 3. Lecture des flux
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

    // 4. Enregistrement dans la collection dynamique (ex: 20261113_rssbrut)
    const collectionName = `${dateStr}_rssbrut`;
    const collection = database.collection(collectionName);

    if (articles.length > 0) {
      await collection.insertMany(articles);
    }

    res.status(200).json({
      success: true,
      message: `${articles.length} articles enregistrés avec succès`,
      collection: collectionName
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
}); 