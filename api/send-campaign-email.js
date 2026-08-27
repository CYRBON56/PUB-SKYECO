// /api/send-campaign-email.js
// Envoie un email de prospection à une liste de prospects via l'API Resend.
// Variables d'environnement requises : RESEND_API_KEY, RESEND_FROM_EMAIL (ex: "Cyrille <infos@ecosky.fr>")

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { prospects, subject, html } = req.body || {};
  if (!Array.isArray(prospects) || !prospects.length || !subject || !html) {
    return res.status(400).json({ success: false, error: 'Prospects, sujet ou contenu manquant.' });
  }
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    return res.status(500).json({ success: false, error: 'Configuration Resend incomplète côté serveur.' });
  }

  const results = { sent: [], failed: [] };

  for (const p of prospects) {
    if (!p.email) {
      results.failed.push({ id: p.id, error: 'Email manquant' });
      continue;
    }
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL,
          to: [p.email],
          subject,
          html: html.replaceAll('{{nom_entreprise}}', p.nom_entreprise || '').replaceAll('{{ville}}', p.ville || '')
        })
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.message || `Resend a répondu ${resp.status}`);
      }
      results.sent.push(p.id);
    } catch (err) {
      results.failed.push({ id: p.id, error: err.message });
    }
  }

  return res.status(200).json({ success: true, ...results });
}
