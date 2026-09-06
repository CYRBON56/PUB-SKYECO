// /api/lead-statut.js
// Met à jour le statut d'une demande (skyeco_pro_leads.statut) — endpoint
// authentifié. La table a été verrouillée côté base (RLS + revoke UPDATE
// pour anon/authenticated) car elle contient des coordonnées clients ;
// cet endpoint vérifie la session ET que la demande appartient bien au(x)
// site(s) de l'appelant avant d'écrire, en utilisant la clé service_role.
import crypto from 'crypto';

const STATUTS_VALIDES = ['nouveau', 'contacte', 'traite', 'perdu'];

async function verifierToken(token, draftIdAttendu) {
  try {
    const decode = Buffer.from(token, 'base64url').toString('utf8');
    const parties = decode.split('.');
    if (parties.length !== 4) return false;
    const [sujet, role, expStr, sig] = parties;
    const exp = parseInt(expStr, 10);
    if (!exp || Date.now() / 1000 > exp) return false;
    const payload = `${sujet}.${role}.${expStr}`;
    const attendu = crypto.createHmac('sha256', process.env.DASHBOARD_SESSION_SECRET).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'hex');
    const attenduBuf = Buffer.from(attendu, 'hex');
    if (sigBuf.length !== attenduBuf.length || !crypto.timingSafeEqual(sigBuf, attenduBuf)) return false;
    if (role === 'admin') return sujet === draftIdAttendu;
    if (role === 'artisan') {
      let email;
      try { email = Buffer.from(sujet, 'base64url').toString('utf8'); } catch (e) { return false; }
      if (!email) return false;
      const resp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftIdAttendu}&select=email`,
        { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      const rows = await resp.json();
      const draft = rows[0];
      return !!(draft && draft.email && draft.email.toLowerCase() === email.toLowerCase());
    }
    return false;
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  const { leadId, statut, token } = req.body || {};
  if (!leadId || !statut || !token) return res.status(400).json({ success: false, error: 'Paramètres manquants' });
  if (!STATUTS_VALIDES.includes(statut)) return res.status(400).json({ success: false, error: 'Statut invalide' });

  const supaHeaders = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };

  try {
    // On retrouve le draft_id de la demande, puis on vérifie que le jeton
    // fourni donne bien accès à CE site (admin lié à ce draftId précis, ou
    // artisan propriétaire du compte email associé).
    const leadResp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}&select=draft_id`, { headers: supaHeaders });
    if (!leadResp.ok) throw new Error('Lecture Supabase impossible : ' + (await leadResp.text()));
    const leadRows = await leadResp.json();
    const lead = leadRows[0];
    if (!lead) return res.status(404).json({ success: false, error: 'introuvable' });

    if (!(await verifierToken(token, lead.draft_id))) {
      return res.status(401).json({ success: false, error: 'session_invalide' });
    }

    const patch = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: { ...supaHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ statut, updated_at: new Date().toISOString() }),
    });
    if (!patch.ok) throw new Error('Écriture Supabase impossible : ' + (await patch.text()));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erreur lead-statut :', err);
    return res.status(500).json({ success: false, error: "Impossible de mettre à jour le statut pour le moment." });
  }
}
