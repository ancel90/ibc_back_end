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

// Date et heure actuelles à Paris, lisibles
function heureParis() {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(new Date());
}

module.exports = async (req, res) => {
  const debut = Date.now();
  const base = `https://${req.headers.host}`;
  const etapes = ['fetch-rss', 'filtremotscles', 'filtreia', 'resume'];
  const rapport = [];

  // Journal : une ligne "en_cours" écrite dès le départ
  let journal = null;
  let idJournal = null;
  try {
    const database = await connectDB();
    journal = database.collection('journal_cron');
    const agent = String(req.headers['user-agent'] || '');
    const resultat = await journal.insertOne({
      lance_le: new Date(),
      heure_paris: heureParis(),
      declencheur: agent.includes('vercel-cron') ? 'cron' : 'manuel',
      statut: 'en_cours'
    });
    idJournal = resultat.insertedId;
  } catch (e) {
    console.error('Journal indisponible :', e.message);
  }

  for (const etape of etapes) {
    try {
      const reponse = await fetch(`${base}/api/${etape}`);
      const data = await reponse.json();
      const ok = reponse.ok && data.success === true;
      rapport.push({ etape, ok, message: data.message || data.error });
      if (!ok) break;
    } catch (e) {
      rapport.push({ etape, ok: false, message: e.message });
      break;
    }
  }

  const succes = rapport.length === etapes.length && rapport.every(r => r.ok);

  // Journal : mise à jour finale
  if (journal && idJournal) {
    try {
      await journal.updateOne(
        { _id: idJournal },
        { $set: { statut: succes ? 'succes' : 'echec', duree_ms: Date.now() - debut, rapport } }
      );
    } catch (e) {
      console.error('Mise à jour du journal impossible :', e.message);
    }
  }

  return res.status(200).json({ success: succes, rapport });
};