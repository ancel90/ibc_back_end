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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});