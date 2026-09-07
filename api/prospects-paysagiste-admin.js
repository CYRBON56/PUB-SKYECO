// /api/prospects-paysagiste-admin.js
//
// Remplace les lectures/écritures directes en clé anonyme que faisait
// public/prospects-paysagiste.html sur la table prospects_paysagiste.
//
// Pourquoi ce fichier existe (06/09/2026) : audit de sécurité a trouvé que
// prospects_paysagiste (19 000+ entreprises avec nom, téléphone, email —
// la liste de prospection achetée par Cyrille) était intégralement lisible
// ET modifiable (SELECT/INSERT/UPDATE) par n'importe qui disposant de la
// clé anonyme publique, sans le moindre mot de passe. La politique RLS en
// place ("Accès anon complet (page interne protégée par mot de passe)")
// supposait à tort que le mot de passe affiché dans la page HTML suffisait
// à protéger l'accès — en réalité la clé anonyme permet d'appeler l'API
// Supabase directement, en contournant entièrement la page.
//
// Ce endpoint réutilise le mot de passe interne (INTERNAL_ACCESS_PASSWORD)
// déjà utilisé pour l'envoi des emails de prospection sur cette même page.
// Une fois ce fichier déployé et prospects-paysagiste.html basculé dessus,
// il faut retirer les droits anon/authenticated sur la table côté base
// (sinon la faille reste ouverte en parallèle du correctif applicatif).
//
// Requête attendue : POST { motDePasseInterne, action, ...params }
//   action = 'compteurs' -> { success, compteurs: { tous, a_contacter, envoyes, ouverts, cliques, desabonnes, obsoletes } }
//   action = 'liste'     -> { motDePasseInterne, action:'liste', filtre, searchNom, searchMetier, page, pageSize }
//                         -> { success, rows: [...], total }
//   action = 'import_lot'-> { motDePasseInterne, action:'import_lot', contacts: [{...}] }
//                         -> upsert par email ; { success, count }
//   action = 'ajouter'   -> { motDePasseInterne, action:'ajouter', contact: {...} }
//                         -> upsert d'un seul contact ; { success }
//
// Variables d'environnement requises : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// INTERNAL_ACCESS_PASSWORD

const COLONNES_LISTE = 'id,nom_entreprise,metier,famille_metier,ville,departement,telephone,email,email_envoye,email_ouvert,lien_clique,opt_out,bounced';

const FILTRES = {
  tous: {},
  a_contacter: { email_envoye: false, opt_out: false, bounced: false },
  envoyes: { email_envoye: true },
  ouverts: { email_ouvert: true },
  cliques: { lien_clique: true },
  desabonnes: { opt_out: true },
  obsoletes: { bounced: true },
};

function qsEqFilters(eqFilters) {
  return Object.entries(eqFilters)
    .map(([col, val]) => `${col}=eq.${val}`)
    .join('&');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée' });
  }

  const { motDePasseInterne, action } = req.body || {};

  if (!process.env.INTERNAL_ACCESS_PASSWORD || motDePasseInterne !== process.env.INTERNAL_ACCESS_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Mot de passe interne incorrect.' });
  }

  const supaHeaders = {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    if (action === 'compteurs') {
      const resultats = await Promise.all(
        Object.entries(FILTRES).map(async ([key, eqFilters]) => {
          const qs = qsEqFilters(eqFilters);
          const url = `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?select=id${qs ? '&' + qs : ''}`;
          const resp = await fetch(url, { headers: { ...supaHeaders, Prefer: 'count=exact', Range: '0-0' } });
          if (!resp.ok) throw new Error('Comptage impossible (' + key + ') : ' + (await resp.text()));
          const contentRange = resp.headers.get('content-range') || '';
          const total = parseInt(contentRange.split('/')[1], 10) || 0;
          return [key, total];
        })
      );
      return res.status(200).json({ success: true, compteurs: Object.fromEntries(resultats) });
    }

    if (action === 'liste') {
      const { filtre, searchNom, searchMetier, searchFamille, page, pageSize } = req.body || {};
      const eqFilters = FILTRES[filtre] || {};
      const taille = Math.min(Math.max(parseInt(pageSize, 10) || 100, 1), 200);
      const p = Math.max(parseInt(page, 10) || 0, 0);

      const params = new URLSearchParams();
      params.set('select', COLONNES_LISTE);
      params.set('order', 'created_at.desc');
      Object.entries(eqFilters).forEach(([col, val]) => params.append(col, `eq.${val}`));
      if (searchNom) params.set('or', `(nom_entreprise.ilike.%${searchNom}%,ville.ilike.%${searchNom}%)`);
      if (searchMetier) params.set('metier', `ilike.%${searchMetier}%`);
      if (searchFamille) params.set('famille_metier', `eq.${searchFamille}`);

      const url = `${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?${params.toString()}`;
      const resp = await fetch(url, {
        headers: { ...supaHeaders, Prefer: 'count=exact', Range: `${p * taille}-${p * taille + taille - 1}` },
      });
      if (!resp.ok) throw new Error('Lecture impossible : ' + (await resp.text()));
      const rows = await resp.json();
      const contentRange = resp.headers.get('content-range') || '';
      const total = parseInt(contentRange.split('/')[1], 10) || rows.length;

      return res.status(200).json({ success: true, rows, total });
    }

    if (action === 'import_lot') {
      const { contacts } = req.body || {};
      if (!Array.isArray(contacts) || !contacts.length) {
        return res.status(400).json({ success: false, error: 'contacts manquant ou vide' });
      }
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?on_conflict=email`, {
        method: 'POST',
        headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(contacts),
      });
      if (!resp.ok) throw new Error('Import impossible : ' + (await resp.text()));
      return res.status(200).json({ success: true, count: contacts.length });
    }

    if (action === 'ajouter') {
      const { contact } = req.body || {};
      if (!contact || !contact.email) {
        return res.status(400).json({ success: false, error: 'contact (avec email) manquant' });
      }
      const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/prospects_paysagiste?on_conflict=email`, {
        method: 'POST',
        headers: { ...supaHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([contact]),
      });
      if (!resp.ok) throw new Error('Ajout impossible : ' + (await resp.text()));
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'action inconnue' });
  } catch (err) {
    console.error('Erreur prospects-paysagiste-admin :', err);
    return res.status(500).json({ success: false, error: 'Impossible de traiter la demande pour le moment.' });
  }
}
