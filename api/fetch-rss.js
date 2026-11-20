const Parser = require('rss-parser');
const parser = new Parser({
  customFields: {
    item: [['dc:date', 'dcDate']]
  }
});
const { MongoClient } = require('mongodb');
const { acces } = require('../lib/securite');

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

// Identifiant de la source d'un article, déduit de son lien
// (et de son titre pour Google Actualités, qui ajoute " - Éditeur" à la fin du titre)
// Retourne { cle, titre } ; "titre" est nettoyé du nom de l'éditeur pour Google Actualités
function identifierSource(item) {
  const titre = item.title || '';
  try {
    const url = new URL(item.link || '');
    const hote = url.hostname.replace(/^www\./, '').toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);

    if (hote === 'news.google.com') {
      const coupure = titre.lastIndexOf(' - ');
      if (coupure > 0) {
        return {
          cle: `google/${titre.slice(coupure + 3).trim().toLowerCase()}`,
          titre: titre.slice(0, coupure).trim()
        };
      }
      return { cle: 'google/inconnu', titre };
    }
    if (hote === 'bsky.app' && segments[0] === 'profile' && segments[1]) {
      return { cle: `bsky.app/profile/${segments[1].toLowerCase()}`, titre };
    }
    if (hote === 't.me') {
      const canal = segments[0] === 's' ? segments[1] : segments[0];
      if (canal) return { cle: `t.me/${canal.toLowerCase()}`, titre };
    }
    if (hote === 'facebook.com' && segments[0]) {
      return { cle: `facebook.com/${segments[0].toLowerCase()}`, titre };
    }
    return { cle: hote, titre };
  } catch (e) {
    return { cle: 'inconnu', titre };
  }
}

// Type de média déduit de la clé, quand la source n'est pas encore dans la table
function typeParDefaut(cle) {
  if (cle.startsWith('bsky.app/')) return 'bluesky';
  if (cle.startsWith('t.me/')) return 'telegram';
  if (cle.startsWith('facebook.com/')) return 'facebook';
  return 'flux_rss';
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

  // Accès réservé : le code secret est obligatoire
  if (!acces(req, res)) return;

  try {
    const database = await connectDB();

    const dateStr = dateJourFini();
    const maintenant = Date.now();

    let articles = [];
    let lus = 0;

    // 1) Flux en dur (anciens flux)
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

    // 2) Flux Inoreader (adresse secrète stockée dans les variables Vercel)
    const adresseInoreader = process.env.INOREADER_FEED_URL;
    let inoreaderRetenus = 0;
    let erreurInoreader = null;
    const inconnues = new Map(); // sources absentes de la table "sources"
    const connues = new Set(); // sources présentes dans la table "sources"

    if (adresseInoreader) {
      try {
        const table = await database.collection('sources').find({}).toArray();
        const sources = new Map(table.map(s => [s.cle, s]));
        const feed = await parser.parseURL(adresseInoreader);

        for (const item of feed.items) {
          lus++;
          if (!estRecent(item, maintenant)) continue;

          const { cle, titre } = identifierSource(item);
          const fiche = sources.get(cle);

          if (fiche) {
            connues.add(cle);
          } else {
            const inconnue = inconnues.get(cle) || {
              cle,
              type: typeParDefaut(cle),
              nombre: 0,
              exemple_titre: titre,
              exemple_lien: item.link || ''
            };
            inconnue.nombre++;
            inconnues.set(cle, inconnue);
          }

          articles.push({
            date: dateStr,
            source: fiche ? fiche.nom : cle,
            pays: fiche ? fiche.pays : 'inconnu',
            type: fiche ? fiche.type : typeParDefaut(cle),
            titre,
            lien: item.link || '',
            article: item.contentSnippet || item.content || '',
            publie_le: datePublication(item).toISOString(),
            favorable: 0
          });
          inoreaderRetenus++;
        }
      } catch (e) {
        // Une panne d'Inoreader ne doit pas bloquer les autres flux ; l'adresse est masquée
        erreurInoreader = String(e.message || e).split(adresseInoreader).join('[adresse masquée]');
        console.error('Inoreader :', erreurInoreader);
      }
    }

    const collectionName = `${dateStr}_rssbrut`;
    const collection = database.collection(collectionName);

    // On remplace le contenu du jour (pas de doublons), même s'il n'y a aucun article récent
    await collection.deleteMany({});
    if (articles.length > 0) {
      await collection.insertMany(articles);
    }

    // Liste des sources à classer : on note les inconnues, on retire celles désormais connues
    const aClasser = database.collection('sources_a_classer');
    if (inconnues.size > 0) {
      const vuLe = new Date();
      await aClasser.bulkWrite(
        [...inconnues.values()].map(s => ({
          updateOne: {
            filter: { cle: s.cle },
            update: {
              $set: {
                type: s.type,
                dernier_nombre: s.nombre,
                exemple_titre: s.exemple_titre,
                exemple_lien: s.exemple_lien,
                derniere_vue: vuLe
              },
              $setOnInsert: { premiere_vue: vuLe }
            },
            upsert: true
          }
        }))
      );
    }
    if (connues.size > 0) {
      await aClasser.deleteMany({ cle: { $in: [...connues] } });
    }

    let message = `${articles.length} articles de moins de 24 h enregistrés (sur ${lus} lus)`;
    if (adresseInoreader) message += `, dont ${inoreaderRetenus} via Inoreader`;
    if (inconnues.size > 0) message += `, ${inconnues.size} source(s) à classer`;
    if (erreurInoreader) message += ` ; ERREUR Inoreader : ${erreurInoreader}`;

    return res.status(200).json({
      success: true,
      message,
      collection: collectionName
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};