const { MongoClient } = require('mongodb');
const { acces } = require('../lib/securite');

const uri = process.env.MONGODB_URI;
let cachedDb = null;

// Adresse principale du back-end (si le domaine change, modifier cette ligne)
const BASE = 'https://ibcbackend.vercel.app';

// Étapes de la chaîne quotidienne : récupération des articles, puis filtre par mots clés.
// La notation par l'IA et le résumé sont lancés depuis le site (route mise-a-jour).
const ETAPES = ['fetch-rss', 'filtremotscles'];

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
  // Accès réservé : le code secret est obligatoire
  if (!acces(req, res)) return;

  const debut = Date.now();
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

  for (const etape of ETAPES) {
    const t0 = Date.now();
    try {
      const reponse = await fetch(`${BASE}/api/${etape}`, {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
      });
      const texte = await reponse.text();

      let data = null;
      try {
        data = JSON.parse(texte);
      } catch (e) {
        data = null;
      }

      if (!data) {
        rapport.push({
          etape,
          ok: false,
          duree_ms: Date.now() - t0,
          message: `Réponse non JSON (HTTP ${reponse.status}) : ${texte.slice(0, 200)}`
        });
        break;
      }

      const ok = reponse.ok && data.success === true;
      rapport.push({
        etape,
        ok,
        duree_ms: Date.now() - t0,
        message: data.message || data.error
      });
      if (!ok) break;
    } catch (e) {
      rapport.push({ etape, ok: false, duree_ms: Date.now() - t0, message: e.message });
      break;
    }
  }

  // Statut final : succes si toutes les étapes ont réussi, sinon echec
  const succes = rapport.length === ETAPES.length && rapport.every(r => r.ok);
  const statut = succes ? 'succes' : 'echec';

  // Journal : mise à jour finale
  if (journal && idJournal) {
    try {
      await journal.updateOne(
        { _id: idJournal },
        { $set: { statut, duree_ms: Date.now() - debut, rapport } }
      );
    } catch (e) {
      console.error('Mise à jour du journal impossible :', e.message);
    }
  }

  return res.status(200).json({ success: succes, statut, rapport });
};