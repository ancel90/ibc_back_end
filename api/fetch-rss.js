const Parser = require('rss-parser');
const parser = new Parser({
  customFields: {
    item: [['dc:date', 'dcDate']]
  }
});
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

// Date de publication d'un article (selon le format du flux), ou null
function datePublication(item) {
  const brut = item.isoDate || item.pubDate || item.dcDate;
  if (!brut) return null;
  const date = new Date(brut);
  return isNaN(date.getTime()) ? null : date;
}

// Vrai si l'article a été publié dans les dernières 24 heures
// (articles sans date, avec une date invalide ou datés du futur : refusés)
function estRecent(item, maintenant) {
  const date = datePublication(item);
  if (!date) return false;
  const age = maintenant - date.getTime();
  return age >= 0 && age <= 24 * 60 * 60 * 1000;
}

// Liste des flux : adresse, nom du média, pays émetteur, type de média
// Types possibles : flux_rss, site_web, newsletter, facebook, bluesky, telegram, vkontakte
const FEEDS = [
  { url: 'https://www.lemonde.fr/rss/une.xml', source: 'Le Monde', pays: 'france', type: 'flux_rss' },
  { url: 'https://www.lefigaro.fr/rss/figaro_actualites.xml', source: 'Le Figaro', pays: 'france', type: 'flux_rss' },
  { url: 'https://rss.rtbf.be/article/rss/highlight_rtbf_info.xml?source=internal', source: 'RTBF', pays: 'belgique', type: 'flux_rss' },
  { url: 'https://lanticapitaliste.org/rss.xml', source: "L'Anticapitaliste", pays: 'france', type: 'flux_rss' },
  { url: 'https://www.mvtpaix.org/wordpress/feed/', source: 'Mouvement de la Paix', pays: 'france', type: 'flux_rss' },
  { url: 'https://www.fnlp.fr/feed/', source: 'FNLP', pays: 'france', type: 'flux_rss' },
  { url: 'https://basta.media/spip.php?page=backend', source: 'Basta', pays: 'france', type: 'flux_rss' }
];

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

    const dateStr = dateJourFini();
    const maintenant = Date.now();

    let articles = [];
    let lus = 0;

    for (const flux of FEEDS) {
      const feed = await parser.parseURL(flux.url);

      for (const item of feed.items) {
        lus++;
        if (!estRecent(item, maintenant)) continue;

        articles.push({
          date: dateStr,
          source: flux.source,
          pays: flux.pays,
          type: flux.type,
          titre: item.title || '',
          lien: item.link || '',
          article: item.contentSnippet || item.content || '',
          publie_le: datePublication(item).toISOString(),
          favorable: 0
        });
      }
    }

    const collectionName = `${dateStr}_rssbrut`;
    const collection = database.collection(collectionName);

    // On remplace le contenu du jour (pas de doublons), même s'il n'y a aucun article récent
    await collection.deleteMany({});
    if (articles.length > 0) {
      await collection.insertMany(articles);
    }

    return res.status(200).json({
      success: true,
      message: `${articles.length} articles de moins de 24 h enregistrés (sur ${lus} lus)`,
      collection: collectionName
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};