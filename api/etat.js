const { MongoClient } = require('mongodb');
const { accesUtilisateur } = require('../lib/securite');

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

// Liste des n derniers jours terminés (aaaammjj), du plus récent au plus ancien
function listeJours(n) {
  const fini = dateJourFini();
  const annee = Number(fini.slice(0, 4));
  const mois = Number(fini.slice(4, 6));
  const jour = Number(fini.slice(6, 8));
  const jours = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(annee, mois - 1, jour - i));
    jours.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return jours;
}

module.exports = async (req, res) => {
  // Gestion CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With, Accept, Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Accès réservé : jeton de connexion obligatoire
  if (!accesUtilisateur(req, res)) return;

  try {
    // Nombre de jours demandés (30 par défaut, 60 au maximum)
    const n = Math.min(Math.max(parseInt(req.query.jours, 10) || 30, 1), 60);

    const database = await connectDB();
    const jours = listeJours(n);

    // Collections existantes et résumés déjà enregistrés
    const collections = await database.listCollections({}, { nameOnly: true }).toArray();
    const noms = new Set(collections.map(c => c.name));

    const resumesTrouves = await database
      .collection('resumes')
      .find({ _id: { $in: [...jours, ...jours.map(Number)] } }, { projection: { _id: 1 } })
      .toArray();
    const resumes = new Set(resumesTrouves.map(r => String(r._id)));

    const compter = (nom) => (noms.has(nom) ? database.collection(nom).estimatedDocumentCount() : 0);

    const detail = await Promise.all(
      jours.map(async (date) => {
        const [brut, motsCles, ia] = await Promise.all([
          compter(`${date}_rssbrut`),
          compter(`${date}_rssfiltremotscles`),
          compter(`${date}_rssfiltreia`)
        ]);
        const resume = resumes.has(date);

        // Statut du jour et prochaine étape à faire
        let statut;
        let etape;
        if (brut === 0 && !resume) {
          statut = 'sans_donnees';
          etape = 'rien';
        } else if (brut > 0 && motsCles === 0 && !resume) {
          statut = 'a_traiter';
          etape = 'mots_cles';
        } else if (ia < motsCles) {
          statut = 'a_traiter';
          etape = 'ia';
        } else if (!resume) {
          statut = 'a_traiter';
          etape = 'resume';
        } else {
          statut = 'a_jour';
          etape = 'rien';
        }

        return {
          date,
          brut,
          mots_cles: motsCles,
          ia,
          restant_a_noter: Math.max(0, motsCles - ia),
          resume,
          statut,
          etape
        };
      })
    );

    const aTraiter = detail.filter(j => j.statut === 'a_traiter').length;

    return res.status(200).json({
      success: true,
      a_jour: aTraiter === 0,
      a_traiter: aTraiter,
      jours: detail
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};