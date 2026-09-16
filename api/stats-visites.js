// api/stats-visites.js
//
// Agrège les données de visites_tunnel pour la page statistiques-visites.html.
// Requête : GET ?motDePasseInterne=...&jours=30 (par défaut 30)

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, jours } = req.query || {};
  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  const fenetreJours = Math.min(parseInt(jours, 10) || 30, 90);
  const depuis = new Date(Date.now() - fenetreJours * 24 * 60 * 60 * 1000).toISOString();

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  };

  try {
    const resp = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/visites_tunnel?entree_le=gte.${encodeURIComponent(depuis)}&select=*&order=entree_le.desc&limit=5000`,
      { headers: supaHeaders }
    );
    if (!resp.ok) throw new Error('Lecture visites_tunnel impossible : ' + (await resp.text()));
    const lignes = await resp.json();

    // Identités connues (pid -> nom d'entreprise / email), pour ne pas
    // laisser les sessions identifiées affichées comme "anonyme".
    const pids = [...new Set(lignes.map((l) => l.pid).filter(Boolean))];
    let identites = {};
    if (pids.length) {
      const filtrePid = pids.map((p) => encodeURIComponent(p)).join(',');
      const identResp = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?clic_token=in.(${filtrePid})&select=clic_token,nom_entreprise,email,ville,metier`,
        { headers: supaHeaders }
      );
      if (identResp.ok) {
        const rows = await identResp.json();
        rows.forEach((r) => { identites[r.clic_token] = r; });
      }
    }

    // Regroupement par session.
    const sessions = {};
    for (const l of lignes) {
      if (!sessions[l.session_id]) {
        sessions[l.session_id] = {
          session_id: l.session_id,
          pid: l.pid || null,
          identite: l.pid ? (identites[l.pid] || null) : null,
          premiere_visite: l.entree_le,
          derniere_visite: l.entree_le,
          pages: [],
        };
      }
      const s = sessions[l.session_id];
      if (l.pid && !s.pid) { s.pid = l.pid; s.identite = identites[l.pid] || null; }
      if (l.entree_le < s.premiere_visite) s.premiere_visite = l.entree_le;
      if (l.entree_le > s.derniere_visite) s.derniere_visite = l.entree_le;
      s.pages.push({ page: l.page, entree_le: l.entree_le, duree_secondes: l.duree_secondes });
    }
    const sessionsListe = Object.values(sessions)
      .map((s) => { s.pages.sort((a, b) => new Date(a.entree_le) - new Date(b.entree_le)); return s; })
      .sort((a, b) => new Date(b.derniere_visite) - new Date(a.derniere_visite));

    // Agrégats par page : nb de vues, durée moyenne.
    const parPage = {};
    for (const l of lignes) {
      if (!parPage[l.page]) parPage[l.page] = { page: l.page, vues: 0, sommeSecondes: 0, avecDuree: 0 };
      parPage[l.page].vues += 1;
      if (typeof l.duree_secondes === 'number') { parPage[l.page].sommeSecondes += l.duree_secondes; parPage[l.page].avecDuree += 1; }
    }
    const pagesListe = Object.values(parPage)
      .map((p) => ({ page: p.page, vues: p.vues, dureeMoyenneSecondes: p.avecDuree ? Math.round(p.sommeSecondes / p.avecDuree) : null }))
      .sort((a, b) => b.vues - a.vues);

    // Dernière page vue par session = où les gens "décrochent" le plus souvent.
    const dernierePageParSession = {};
    for (const s of sessionsListe) {
      const derniere = s.pages[s.pages.length - 1];
      if (derniere) dernierePageParSession[derniere.page] = (dernierePageParSession[derniere.page] || 0) + 1;
    }
    const sortiesListe = Object.entries(dernierePageParSession)
      .map(([page, n]) => ({ page, sessionsTerminantIci: n }))
      .sort((a, b) => b.sessionsTerminantIci - a.sessionsTerminantIci);

    return res.status(200).json({
      success: true,
      fenetreJours,
      totalSessions: sessionsListe.length,
      totalVues: lignes.length,
      sessionsIdentifiees: sessionsListe.filter((s) => s.identite).length,
      sessions: sessionsListe.slice(0, 300),
      pages: pagesListe,
      sorties: sortiesListe,
    });
  } catch (err) {
    console.error('stats-visites error:', err);
    return res.status(500).json({ success: false, error: err.message || 'Lecture impossible.' });
  }
}
