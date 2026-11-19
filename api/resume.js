const { MongoClient } = require('mongodb');
const { acces } = require('../lib/securite');

const uri = process.env.MONGODB_URI;
let cachedDb = null;

// Les sept types de médias prévus
const TYPES = ['flux_rss', 'site_web', 'newsletter', 'facebook', 'bluesky', 'telegram', 'vkontakte'];

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

// Compte séparément les favorables (1), défavorables (-1) et neutres (0)
function compter(liste) {
  const c = { favorables: 0, defavorables: 0, neutres: 0 };
  for (const art of liste) {
    if (art.favorable === 1) c.favorables++;
    else if (art.favorable === -1) c.defavorables++;
    else c.neutres++;
  }
  return c;
}

// Une ligne de tableau vide
function ligneVide() {
  return { integres: 0, retenus: 0, favorables: 0, neutres: 0, defavorables: 0 };
}

// Type d'un article (les anciens articles, sans type, venaient tous de flux RSS)
function typeDe(art) {
  return art.type || 'flux_rss';
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

    // 1. Lire les trois niveaux de collections du jour
    const brut = await database.collection(`${dateStr}_rssbrut`).find({}).toArray();
    const retenus = await database.collection(`${dateStr}_rssfiltremotscles`).find({}).toArray();
    const notes = await database.collection(`${dateStr}_rssfiltreia`).find({}).toArray();

    // 2. Regrouper par pays (articles notés par l'IA)
    const parPays = {};
    for (const art of notes) {
      const pays = art.pays || 'inconnu';
      if (!parPays[pays]) parPays[pays] = [];
      parPays[pays].push(art);
    }
    const resumePays = {};
    for (const pays of Object.keys(parPays)) {
      resumePays[pays] = compter(parPays[pays]);
    }

    // 3. Compter par type de média, avec le total
    const parType = {};
    for (const t of TYPES) parType[t] = ligneVide();
    const total = ligneVide();

    function ligne(type) {
      if (!parType[type]) parType[type] = ligneVide();
      return parType[type];
    }

    for (const art of brut) {
      ligne(typeDe(art)).integres++;
      total.integres++;
    }
    for (const art of retenus) {
      ligne(typeDe(art)).retenus++;
      total.retenus++;
    }
    for (const art of notes) {
      const cle = art.favorable === 1 ? 'favorables' : art.favorable === -1 ? 'defavorables' : 'neutres';
      ligne(typeDe(art))[cle]++;
      total[cle]++;
    }

    // 4. Construire le résumé du jour
    const resume = {
      _id: dateStr,
      date: dateStr,
      global: compter(notes),
      par_pays: resumePays,
      par_type: parType,
      total: total
    };

    // 5. Enregistrer (remplace le résumé du jour s'il existe déjà)
    await database.collection('resumes').replaceOne({ _id: dateStr }, resume, { upsert: true });

    return res.status(200).json({
      success: true,
      message: `Résumé du ${dateStr} enregistré (${brut.length} intégrés, ${retenus.length} retenus, ${notes.length} notés)`,
      collection: 'resumes'
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};