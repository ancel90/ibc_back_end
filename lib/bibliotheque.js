// Bibliothèque permanente : un seul exemplaire de chaque article retenu, sans limite de durée.
// Ce fichier est utilisé par la mise à jour quotidienne (api/mise-a-jour.js)
// et par la reprise des jours déjà en base (api/reprise-bibliotheque.js).
const crypto = require('crypto');

const LONGUEUR_NEUTRE = 300;  // extrait conservé pour un article neutre
const LONGUEUR_RETENU = 1500; // texte conservé pour un article favorable ou défavorable

function couper(texte, max) {
  const t = String(texte || '').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// Identifiant d'un article (même règle que dans la mise à jour)
function cleArticle(art) {
  return `${art.lien || ''}|${art.titre || ''}`;
}

// Prépare le document d'un article pour la bibliothèque.
// L'identifiant est l'empreinte du lien : un même article n'existe qu'une seule fois.
function versBibliotheque(art, jour) {
  const empreinte = crypto
    .createHash('sha1')
    .update(art.lien ? String(art.lien) : cleArticle(art))
    .digest('hex');

  const retenu = art.favorable === 1 || art.favorable === -1;
  const texte = couper(art.article, retenu ? LONGUEUR_RETENU : LONGUEUR_NEUTRE);

  const doc = {
    _id: empreinte,
    genre: 'article',
    titre: art.titre || '',
    lien: art.lien || '',
    source: art.source || null,
    pays: art.pays || null,
    type: art.type || null,
    publie_le: art.publie_le || null,
    jour,
    ajoute_le: new Date(),
    favorable: art.favorable,
    texte
  };
  if (art.langue) doc.langue = art.langue;
  if (art.titre_fr) doc.titre_fr = art.titre_fr;
  if (art.extrait_fr) doc.extrait_fr = art.extrait_fr;

  // Texte transformé en vecteur par Atlas : titre et texte, avec leur version française s'ils existent
  doc.texte_recherche = [doc.titre, doc.titre_fr, doc.texte, doc.extrait_fr]
    .filter((t) => t && String(t).trim() !== '')
    .join('\n');

  return doc;
}

// Copie des articles notés dans la bibliothèque. Un article déjà présent n'est pas modifié.
// Renvoie le nombre d'articles réellement ajoutés.
async function copierDansBibliotheque(database, articles, jour) {
  if (!articles || articles.length === 0) return 0;

  const operations = articles.map((art) => {
    const doc = versBibliotheque(art, jour);
    return {
      updateOne: {
        filter: { _id: doc._id },
        update: { $setOnInsert: doc },
        upsert: true
      }
    };
  });

  const ecriture = await database.collection('bibliotheque').bulkWrite(operations, { ordered: false });
  return ecriture.upsertedCount || 0;
}

module.exports = { versBibliotheque, copierDansBibliotheque };