module.exports = async (req, res) => {
  const base = `https://${req.headers.host}`;
  const etapes = ['fetch-rss', 'filtremotscles', 'filtreia', 'resume'];
  const rapport = [];

  for (const etape of etapes) {
    try {
      const reponse = await fetch(`${base}/api/${etape}`);
      const data = await reponse.json();
      const ok = reponse.ok && data.success === true;
      rapport.push({ etape, ok, message: data.message || data.error });
      if (!ok) break;
    } catch (e) {
      rapport.push({ etape, ok: false, message: e.message });
      break;
    }
  }

  const succes = rapport.length === etapes.length && rapport.every(r => r.ok);
  return res.status(200).json({ success: succes, rapport });
};