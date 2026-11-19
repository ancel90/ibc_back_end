const crypto = require('crypto');

// Compare deux textes sans révéler leur contenu par le temps de réponse
function memeTexte(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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

module.exports = { acces };