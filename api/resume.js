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

  try {
    const database = await connectDB();

    const dateStr = dateJourFini();

    // 1. Lire les articles notés par l'IA
    const sourceName = `${dateStr}_rssfiltreia`;
    const articles = await database.collection(sourceName).find({}).toArray();

    // 2. Regrouper par pays
    const parPays = {};
    for (const art of articles) {
      const pays = art.pays || 'inconnu';
      if (!parPays[pays]) parPays[pays] = [];
      parPays[pays].push(art);
    }
    const resumePays = {};
    for (const pays of Object.keys(parPays)) {
      resumePays[pays] = compter(parPays[pays]);
    }

    // 3. Construire le résumé du jour
    // Pour l'instant, tous les articles viennent des médias en ligne (flux RSS).
    const resume = {
      _id: dateStr,
      date: dateStr,
      global: compter(articles),
      par_pays: resumePays,
      par_type: { medias: compter(articles) }
    };

    // 4. Enregistrer (remplace le résumé du jour s'il existe déjà)
    await database.collection('resumes').replaceOne({ _id: dateStr }, resume, { upsert: true });

    return res.status(200).json({
      success: true,
      message: `Résumé du ${dateStr} enregistré (${articles.length} articles)`,
      collection: 'resumes'
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};