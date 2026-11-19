const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const app = express();
app.use(cors());

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

// Route de statut (lecture seule, ne révèle rien de sensible)
app.get('/api/status', async (req, res) => {
  try {
    await connectDB();
    res.json({ status: "OK", message: "Back-end connecté à MongoDB" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "ERREUR", message: "Connexion à MongoDB impossible" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});