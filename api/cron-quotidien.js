const { MongoClient } = require('mongodb');
const { acces } = require('../lib/securite');

const uri = process.env.MONGODB_URI;
let cachedDb = null;

// Adresse principale du back-end (si le domaine change, modifier cette ligne)
const BASE = 'https://ibcbackend.vercel.app';

// Étapes de la chaîne quotidienne : récupération des articles (déjà filtrés par Inoreader), puis nettoyage.
// La notation par l'IA et le résumé sont lancés depuis le site (route mise-a-jour).
// "critique : false" = si l'étape échoue, la nuit n'est pas considérée comme échouée.
const ETAPES = [
  { nom: 'fetch-rss', critique: true },
  { nom: 'nettoyage', critique: false }
];

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
    let ok = false;

    try {
      const reponse = await fetch(`${BASE}/api/${etape.nom}`, {
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
          etape: etape.nom,
          ok: false,
          duree_ms: Date.now() - t0,
          message: `Réponse non JSON (HTTP ${reponse.status}) : ${texte.slice(0, 200)}`
        });
      } else {
        ok = reponse.ok && data.success === true;
        rapport.push({
          etape: etape.nom,
          ok,
          duree_ms: Date.now() - t0,
          message: data.message || data.error
        });
      }
    } catch (e) {
      rapport.push({ etape: etape.nom, ok: false, duree_ms: Date.now() - t0, message: e.message });
    }

    // Une étape critique en échec arrête la chaîne ; les autres, non
    if (!ok && etape.critique) break;
  }

  // Statut final : succes, partiel (seul le nettoyage a échoué) ou echec
  const echecs = rapport.filter((r) => !r.ok).map((r) => r.etape);
  const complet = rapport.length === ETAPES.length;
  let statut;
  if (complet && echecs.length === 0) statut = 'succes';
  else if (complet && echecs.every((nom) => nom === 'nettoyage')) statut = 'partiel';
  else statut = 'echec';

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

  return res.status(200).json({ success: statut === 'succes', statut, rapport });
};