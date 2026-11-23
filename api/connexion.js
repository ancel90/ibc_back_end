const { memeTexte, creerJeton, cors } = require('../lib/securite');

const PAUSE_ECHEC_MS = 1000; // attente avant de répondre à un mauvais mot de passe

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (req, res) => {
  // Gestion CORS : seul le site de la Chouette est autorisé
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  try {
    const code = process.env.CODE_ACCES;
    if (!code) {
      return res.status(500).json({ success: false, error: 'CODE_ACCES non configuré sur le serveur' });
    }

    // Le corps de la demande est normalement déjà lu par Vercel ; on gère aussi le cas du texte brut
    let corps = req.body || {};
    if (typeof corps === 'string') {
      try {
        corps = JSON.parse(corps);
      } catch (e) {
        corps = {};
      }
    }
    const saisi = String(corps.code || '');

    if (!saisi || !memeTexte(saisi, code)) {
      await pause(PAUSE_ECHEC_MS);
      return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
    }

    const { jeton, expire_le } = creerJeton();
    return res.status(200).json({ success: true, jeton, expire_le });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};