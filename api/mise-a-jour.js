const { MongoClient } = require('mongodb');
const crypto = require('crypto'); // BIBLIOTHÈQUE : pour calculer l'empreinte d'un article
const { accesUtilisateur, cors } = require('../lib/securite');
const { calculerResume } = require('../lib/calcul-resume');

const uri = process.env.MONGODB_URI;
const geminiKey = process.env.GEMINI_API_KEY;
const MODELE = 'gemini-3.5-flash';

// Adresse principale du back-end (si le domaine change, modifier cette ligne)
const BASE = 'https://ibcbackend.vercel.app';

// Réglages
const TAILLE_LOT = 10;            // articles notés ou traduits par requête Gemini
const MAX_PAR_APPEL = 30;         // articles notés par appel de cette route (3 requêtes en parallèle)
const DELAI_APPEL_MS = 25000;     // durée maximale d'une requête Gemini
const BUDGET_TOTAL_MS = 40000;    // durée maximale pour noter un paquet
const BUDGET_TRADUCTION_MS = 20000; // durée maximale pour traduire les articles du paquet
const ESSAIS_MAX = 3;             // essais par lot (erreurs passagères seulement)
const LONGUEUR_EXTRAIT = 600;     // caractères de l'article envoyés à Gemini pour la notation
const LONGUEUR_TRADUCTION = 400;  // caractères de l'article envoyés à Gemini pour la traduction
const LONGUEUR_EXTRAIT_FR = 300;  // caractères conservés pour l'extrait traduit
const DUREE_VERROU_MS = 60000;    // durée du verrou (libéré dès la fin du travail)
const LONGUEUR_BIBLIO_NEUTRE = 300;  // BIBLIOTHÈQUE : extrait conservé pour un article neutre
const LONGUEUR_BIBLIO_RETENU = 1500; // BIBLIOTHÈQUE : texte conservé pour un article favorable ou défavorable

let cachedDb = null;

async function connectDB() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(uri);
  await client.connect();
  cachedDb = client.db('ibc_db');
  return cachedDb;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function couper(texte, max) {
  const t = String(texte || '').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// Identifiant d'un article pour savoir s'il a déjà été noté
function cleArticle(art) {
  return `${art.lien || ''}|${art.titre || ''}`;
}

// BIBLIOTHÈQUE : prépare le document d'un article pour la bibliothèque permanente.
// L'identifiant est l'empreinte du lien : un même article n'existe qu'une seule fois.
function versBibliotheque(art, jour) {
  const empreinte = crypto
    .createHash('sha1')
    .update(art.lien ? String(art.lien) : cleArticle(art))
    .digest('hex');

  const retenu = art.favorable === 1 || art.favorable === -1;
  const texte = couper(art.article, retenu ? LONGUEUR_BIBLIO_RETENU : LONGUEUR_BIBLIO_NEUTRE);

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

// Prend le verrou de mise à jour : renvoie false si quelqu'un d'autre travaille déjà
async function prendreVerrou(database) {
  const maintenant = new Date();
  try {
    await database.collection('verrous').findOneAndUpdate(
      { _id: 'mise-a-jour', expire_le: { $lt: maintenant } },
      {
        $set: {
          pris_le: maintenant,
          expire_le: new Date(maintenant.getTime() + DUREE_VERROU_MS)
        }
      },
      { upsert: true }
    );
    return true;
  } catch (e) {
    if (e.code === 11000) return false; // verrou déjà pris et pas encore expiré
    throw e;
  }
}

// Libère le verrou
async function libererVerrou(database) {
  await database.collection('verrous').updateOne(
    { _id: 'mise-a-jour' },
    { $set: { expire_le: new Date(0) } }
  );
}

// Un appel à Gemini, avec une durée maximale (json = true : réponse demandée en JSON)
async function appelGemini(prompt, delaiMs, reflexionBasse, json) {
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), delaiMs);

  const config = { temperature: 0 };
  if (reflexionBasse) config.thinkingConfig = { thinkingLevel: 'low' };
  if (json) config.responseMimeType = 'application/json';

  try {
    const reponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELE}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: config
        }),
        signal: controleur.signal
      }
    );

    const data = await reponse.json();
    if (!reponse.ok) {
      const erreur = new Error((data.error && data.error.message) || `Erreur Gemini ${reponse.status}`);
      erreur.statut = reponse.status;
      // Erreur passagère (surcharge, lenteur) : on peut réessayer. Quota (429) : inutile.
      erreur.passager = [500, 502, 503, 504].includes(reponse.status);
      throw erreur;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const erreur = new Error(`Gemini trop lent (plus de ${Math.round(delaiMs / 1000)} s)`);
      erreur.statut = 0;
      erreur.passager = true;
      throw erreur;
    }
    throw e;
  } finally {
    clearTimeout(minuteur);
  }
}

// Note un groupe d'articles en une seule requête : renvoie une liste de -1, 0 ou 1
async function noterLot(lot, fin) {
  const lignes = lot
    .map((art, i) => `${i + 1}. Titre : ${art.titre}\nTexte : ${couper(art.article, LONGUEUR_EXTRAIT)}`)
    .join('\n\n');

  const prompt =
    "Tu es un analyste de veille médiatique. Pour chacun des articles numérotés ci-dessous, " +
    "détermine l'attitude de l'article envers quatre sujets : " +
    "les armées françaises, " +
    "la coalition européenne (par exemple la coalition des volontaires qui soutient l'Ukraine), " +
    "la France (y compris son président et son gouvernement), " +
    "et les intérêts français. " +
    "Donne une seule note par article : " +
    "favorable (1) si l'article présente au moins l'un de ces sujets de façon positive ou le défend, " +
    "sans en attaquer un autre ; " +
    "défavorable (-1) si l'article critique, dénigre ou est hostile à au moins l'un de ces sujets ; " +
    "neutre (0) si l'article ne parle pas de ces sujets, n'en parle que de façon factuelle ou incidente, " +
    "ou si les points de vue se compensent. " +
    "Les articles peuvent être écrits en français, en anglais, en roumain ou en russe. " +
    "Réponds uniquement par une liste JSON de nombres, dans l'ordre des articles, " +
    "par exemple [0,1,-1]. Aucun autre texte.\n\n" +
    lignes;

  let reflexionBasse = true;
  let derniereErreur = null;

  for (let essai = 1; essai <= ESSAIS_MAX; essai++) {
    const reste = fin - Date.now();
    if (reste < 3000) break;

    try {
      const data = await appelGemini(prompt, Math.min(DELAI_APPEL_MS, reste), reflexionBasse, false);

      const parts =
        (data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts) || [];
      const texte = parts.map((p) => p.text || '').join('');

      const liste = texte.match(/\[[^\]]*\]/);
      if (!liste) throw new Error(`Réponse inattendue : ${texte}`);

      let notes;
      try {
        notes = JSON.parse(liste[0]);
      } catch (e) {
        throw new Error(`Réponse inattendue : ${texte}`);
      }
      if (!Array.isArray(notes) || notes.length !== lot.length ||
          !notes.every((n) => [-1, 0, 1].includes(n))) {
        throw new Error(`Réponse inattendue : ${texte}`);
      }
      return notes;
    } catch (e) {
      derniereErreur = e;
      // Si le réglage de réflexion est refusé, on réessaie sans lui
      if (e.statut === 400 && /think/i.test(e.message) && reflexionBasse) {
        reflexionBasse = false;
        continue;
      }
      if (!e.passager || essai === ESSAIS_MAX) break;
      await pause(2000 * essai);
    }
  }

  throw derniereErreur || new Error('Temps imparti épuisé avant la fin des notations');
}

// Détecte la langue d'un groupe d'articles et les traduit en français
// quand ils ne sont ni en français ni en anglais.
// Renvoie une liste d'objets { langue, titre_fr, extrait_fr } dans l'ordre des articles.
async function traduireLot(lot, fin) {
  const lignes = lot
    .map((art, i) => `${i + 1}. Titre : ${art.titre}\nTexte : ${couper(art.article, LONGUEUR_TRADUCTION)}`)
    .join('\n\n');

  const prompt =
    "Pour chacun des articles numérotés ci-dessous : " +
    "1) donne le code ISO 639-1 de la langue de l'article (par exemple fr, en, ro, ru, hu, sr, bg, uk, tr) ; " +
    "2) si la langue n'est ni le français (fr) ni l'anglais (en), traduis en français le titre et le texte " +
    `(le texte traduit ne dépasse pas ${LONGUEUR_EXTRAIT_FR} caractères) ; ` +
    "sinon, mets null pour titre_fr et pour extrait_fr. " +
    "Réponds uniquement par un tableau JSON d'objets, dans l'ordre des articles, " +
    'de la forme {"langue":"ro","titre_fr":"...","extrait_fr":"..."}. Aucun autre texte.\n\n' +
    lignes;

  let reflexionBasse = true;
  let derniereErreur = null;

  for (let essai = 1; essai <= ESSAIS_MAX; essai++) {
    const reste = fin - Date.now();
    if (reste < 3000) break;

    try {
      const data = await appelGemini(prompt, Math.min(DELAI_APPEL_MS, reste), reflexionBasse, true);

      const parts =
        (data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts) || [];
      const texte = parts.map((p) => p.text || '').join('');

      let traductions;
      try {
        traductions = JSON.parse(texte);
      } catch (e) {
        const liste = texte.match(/\[[\s\S]*\]/);
        if (!liste) throw new Error(`Réponse inattendue : ${texte}`);
        traductions = JSON.parse(liste[0]);
      }

      if (!Array.isArray(traductions) || traductions.length !== lot.length ||
          !traductions.every((t) => t && typeof t.langue === 'string')) {
        throw new Error(`Réponse inattendue : ${texte}`);
      }
      return traductions;
    } catch (e) {
      derniereErreur = e;
      // Si le réglage de réflexion est refusé, on réessaie sans lui
      if (e.statut === 400 && /think/i.test(e.message) && reflexionBasse) {
        reflexionBasse = false;
        continue;
      }
      if (!e.passager || essai === ESSAIS_MAX) break;
      await pause(2000 * essai);
    }
  }

  throw derniereErreur || new Error('Temps imparti épuisé avant la fin des traductions');
}

// Ajoute langue, titre_fr et extrait_fr aux articles notés +1 ou -1.
// Un échec de traduction ne bloque rien : l'article est simplement enregistré sans traduction.
async function ajouterTraductions(resultats, fin) {
  const aTraduire = resultats.filter((art) => art.favorable === 1 || art.favorable === -1);
  if (aTraduire.length === 0) return { traduits: 0, erreur: null };

  const lots = [];
  for (let i = 0; i < aTraduire.length; i += TAILLE_LOT) {
    lots.push(aTraduire.slice(i, i + TAILLE_LOT));
  }
  const reponses = await Promise.allSettled(lots.map((lot) => traduireLot(lot, fin)));

  let traduits = 0;
  let erreur = null;
  reponses.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      lots[i].forEach((art, k) => {
        const t = r.value[k];
        art.langue = t.langue.toLowerCase();
        if (typeof t.titre_fr === 'string' && t.titre_fr.trim() !== '') {
          art.titre_fr = t.titre_fr.trim();
          if (typeof t.extrait_fr === 'string' && t.extrait_fr.trim() !== '') {
            art.extrait_fr = couper(t.extrait_fr, LONGUEUR_EXTRAIT_FR);
          }
          traduits++;
        }
      });
    } else if (!erreur) {
      erreur = r.reason && r.reason.message ? r.reason.message : String(r.reason);
    }
  });

  return { traduits, erreur };
}

module.exports = async (req, res) => {
  // Gestion CORS : seul le site de la Chouette est autorisé
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;

  // Accès réservé : jeton de connexion obligatoire (cette route coûte de l'argent)
  if (!accesUtilisateur(req, res)) return;

  let database = null;
  let verrouPris = false;

  try {
    if (!geminiKey) {
      return res.status(500).json({ success: false, error: 'GEMINI_API_KEY manquante dans Vercel' });
    }

    database = await connectDB();

    // 1. État des 30 derniers jours (route etat, appelée avec le secret interne du serveur) :
    //    on cherche le jour le plus récent à traiter
    const reponseEtat = await fetch(`${BASE}/api/etat?jours=30`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
    });
    const etat = await reponseEtat.json();
    if (!etat.success) {
      throw new Error('La route etat a échoué');
    }

    const aFaire = etat.jours.filter((j) => j.statut === 'a_traiter');
    const traitables = aFaire.filter((j) => j.etape === 'ia' || j.etape === 'resume');
    const bloques = aFaire.length - traitables.length; // jours qui attendent le filtre par mots clés

    if (traitables.length === 0) {
      return res.status(200).json({
        success: true,
        termine: true,
        jours_a_traiter: 0,
        jours_bloques: bloques,
        message: 'Base de donnée à jour'
      });
    }

    const jour = traitables[0]; // la route etat trie du plus récent au plus ancien

    // 2. Verrou : un seul visiteur travaille à la fois
    verrouPris = await prendreVerrou(database);
    if (!verrouPris) {
      return res.status(200).json({
        success: true,
        termine: false,
        occupe: true,
        jour: jour.date,
        message: 'Mise à jour déjà en cours'
      });
    }

    // 3. Articles retenus par les mots clés mais pas encore notés
    const retenus = await database.collection(`${jour.date}_rssfiltremotscles`).find({}).toArray();
    const dejaNotes = await database
      .collection(`${jour.date}_rssfiltreia`)
      .find({}, { projection: { lien: 1, titre: 1 } })
      .toArray();
    const dejaNotesCles = new Set(dejaNotes.map(cleArticle));
    const manquants = retenus.filter((art) => !dejaNotesCles.has(cleArticle(art)));
    const aNoter = manquants.slice(0, MAX_PAR_APPEL);

    // 4. Notation par lots, en parallèle
    const fin = Date.now() + BUDGET_TOTAL_MS;
    const lots = [];
    for (let i = 0; i < aNoter.length; i += TAILLE_LOT) {
      lots.push(aNoter.slice(i, i + TAILLE_LOT));
    }
    const reponses = await Promise.allSettled(lots.map((lot) => noterLot(lot, fin)));

    const resultats = [];
    let premiereErreur = null;
    reponses.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        lots[i].forEach((art, k) => {
          const { _id, ...reste } = art;
          resultats.push({ ...reste, favorable: r.value[k] });
        });
      } else if (!premiereErreur) {
        premiereErreur = r.reason && r.reason.message ? r.reason.message : String(r.reason);
      }
    });

    // Échec total : on le signale, sans rien enregistrer
    if (aNoter.length > 0 && resultats.length === 0) {
      return res.status(502).json({
        success: false,
        jour: jour.date,
        message: `Aucun article noté. Première erreur : ${premiereErreur}`
      });
    }

    // 5. Traduction en français des articles favorables et défavorables (hors français et anglais)
    const traduction = await ajouterTraductions(resultats, Date.now() + BUDGET_TRADUCTION_MS);

    // 6. Ajouter les notes (sans effacer les articles déjà notés), puis recalculer le résumé du jour
    if (resultats.length > 0) {
      await database.collection(`${jour.date}_rssfiltreia`).insertMany(resultats, { ordered: false });
    }

    // 6 bis. BIBLIOTHÈQUE : copie des articles notés dans la collection permanente.
    // Un seul exemplaire par article (identifiant = empreinte du lien) ; un échec ne bloque rien.
    let bibliothequeAjoutes = 0;
    let erreurBibliotheque = null;
    if (resultats.length > 0) {
      try {
        const operations = resultats.map((art) => {
          const doc = versBibliotheque(art, jour.date);
          return {
            updateOne: {
              filter: { _id: doc._id },
              update: { $setOnInsert: doc },
              upsert: true
            }
          };
        });
        const ecriture = await database.collection('bibliotheque').bulkWrite(operations, { ordered: false });
        bibliothequeAjoutes = ecriture.upsertedCount || 0;
      } catch (e) {
        erreurBibliotheque = e.message;
        console.error('Bibliothèque non mise à jour :', e.message);
      }
    }

    await calculerResume(database, jour.date);

    const restantJour = manquants.length - resultats.length;
    const joursRestants = traitables.length - (restantJour === 0 ? 1 : 0);

    return res.status(200).json({
      success: true,
      termine: joursRestants === 0,
      jour: jour.date,
      notes_ajoutes: resultats.length,
      traduits: traduction.traduits,
      erreur_traduction: traduction.erreur,
      bibliotheque_ajoutes: bibliothequeAjoutes,
      erreur_bibliotheque: erreurBibliotheque,
      restant_jour: restantJour,
      jours_a_traiter: joursRestants,
      jours_bloques: bloques,
      premiereErreur: premiereErreur
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    // Le verrou est toujours libéré, même en cas d'erreur
    if (verrouPris && database) {
      try {
        await libererVerrou(database);
      } catch (e) {
        console.error('Verrou non libéré :', e.message);
      }
    }
  }
};