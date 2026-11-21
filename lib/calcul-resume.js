// Calcul du résumé d'un jour : comptes par pays, par type de média et au total

// Les sept types de médias prévus
const TYPES = ['flux_rss', 'site_web', 'newsletter', 'facebook', 'bluesky', 'telegram', 'vkontakte'];

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

// Calcule et enregistre le résumé du jour dateStr (aaaammjj)
// Retourne le nombre d'articles intégrés, retenus et notés
async function calculerResume(database, dateStr) {
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

  return { integres: brut.length, retenus: retenus.length, notes: notes.length };
}

module.exports = { calculerResume };