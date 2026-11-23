const crypto = require('crypto');

// Durée de validité d'un jeton de connexion : 12 heures
const DUREE_JETON_MS = 12 * 60 * 60 * 1000;

// Seul site autorisé à appeler l'API depuis un navigateur
const SITE_AUTORISE = 'https://ibcfrontend.vercel.app';

// Compare deux textes sans révéler leur contenu par le temps de réponse
function memeTexte(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Règles CORS : seul le site de la Chouette peut appeler l'API depuis un navigateur.
// Renvoie true si la requête était une pré-vérification (OPTIONS) : la réponse est alors déjà envoyée.
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', SITE_AUTORISE);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

// Vérifie que l'appel présente le code secret.
// Renvoie true si l'accès est autorisé ; sinon répond lui-même (401 ou 500) et renvoie false.
function acces(req, res) {
  const secret = process.env.CRON_SECRET;

  // Sans code configuré sur le serveur, on refuse tout (plus sûr que de laisser ouvert)
  if (!secret) {
    res.status(500).json({ success: false, error: 'CRON_SECRET non configurée sur le serveur' });
    return false;
  }

  // 1. En-tête "Authorization: Bearer <code>" (envoyé par le cron de Vercel et par notre chaîne)
  const entete = String((req.headers && req.headers.authorization) || '');
  if (entete.startsWith('Bearer ') && memeTexte(entete.slice(7), secret)) {
    return true;
  }

  // 2. Paramètre ?cle=<code> dans l'adresse (pour vos essais à la main)
  let cle = '';
  try {
    cle = new URL(req.url, 'http://localhost').searchParams.get('cle') || '';
  } catch (e) {
    cle = '';
  }
  if (cle && memeTexte(cle, secret)) {
    return true;
  }

  res.status(401).json({ success: false, error: 'Accès refusé' });
  return false;
}

// ---------- Jetons de connexion (mot de passe du site) ----------

// Clé qui signe les jetons : dérivée du mot de passe du site (changer le mot de passe invalide tous les jetons)
function cleDeSignature() {
  const code = process.env.CODE_ACCES;
  return code ? `jeton:${code}` : null;
}

function signer(texte, cle) {
  return crypto.createHmac('sha256', cle).update(texte).digest('hex');
}

// Crée un jeton valable 12 heures : "<date d'expiration>.<signature>"
function creerJeton() {
  const cle = cleDeSignature();
  if (!cle) return null;
  const expire = Date.now() + DUREE_JETON_MS;
  return { jeton: `${expire}.${signer(String(expire), cle)}`, expire_le: expire };
}

// Vrai si le jeton est authentique et pas expiré
function jetonValide(jeton) {
  const cle = cleDeSignature();
  if (!cle) return false;

  const morceaux = String(jeton || '').split('.');
  if (morceaux.length !== 2) return false;

  const [expire, signature] = morceaux;
  if (!/^\d+$/.test(expire) || Number(expire) < Date.now()) return false;

  return memeTexte(signature, signer(expire, cle));
}

// Accès pour les visiteurs du site : jeton de connexion valide.
// Le code secret du cron (CRON_SECRET) reste accepté, pour vos essais à la main.
function accesUtilisateur(req, res) {
  const entete = String((req.headers && req.headers.authorization) || '');
  if (entete.startsWith('Bearer ') && jetonValide(entete.slice(7))) {
    return true;
  }
  return acces(req, res);
}

module.exports = { acces, accesUtilisateur, creerJeton, memeTexte, cors };