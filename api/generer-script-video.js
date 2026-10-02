// /api/generer-script-video.js
// Onglet "Mes vidéos" du dashboard artisan (02/10/2026) — étape 1 : scripts
// seulement, sans génération vidéo (HeyGen viendra plus tard).
//
// Chaque artisan a SON agent IA : même modèle Claude pour tous, mais une
// fiche propre à l'artisan (entreprise, métier, ville) + un prénom d'agent
// généré automatiquement à la première utilisation et stocké dans
// skyeco_pro_vitrine_drafts.agent_ia_prenom (décision de Cyrille du 02/10 :
// une IA générée systématiquement par artisan).
//
// POST { draftId, token, action: 'lister' }
//   -> { success, agentPrenom, scripts: [...] }
// POST { draftId, token, action: 'generer', theme?, idee? }
//   -> { success, agentPrenom, script }
//
// Garde-fous :
//   - Jeton de session dashboard obligatoire (même vérification que
//     coach-ads.js) : le draftId seul n'est pas un secret.
//   - 10 scripts maximum par vitrine et par 24 h (coût Claude maîtrisé).
//   - L'agent se présente toujours comme une IA (transparence + règles TikTok
//     sur les contenus générés par IA), n'invente ni chiffre, ni avis client,
//     ni prix, ni promesse de résultat.
//
// Variables d'environnement requises (toutes déjà présentes sur le projet) :
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   DASHBOARD_SESSION_SECRET

import crypto from 'crypto';

const MODELE_CLAUDE = 'claude-sonnet-4-6';
const MAX_SCRIPTS_PAR_24H = 10;
const PRENOMS_AGENT = ['Max', 'Léo', 'Nina', 'Hugo', 'Jade', 'Tom', 'Lina', 'Noé', 'Zoé', 'Sacha', 'Eva', 'Malo'];

const THEMES = {
  presentation: "Présenter l'entreprise et ce qu'elle fait, à qui elle s'adresse et dans quelle zone.",
  conseil: "Donner un conseil utile et concret aux particuliers sur le métier de l'artisan (entretien, erreur à éviter, bon moment pour faire les travaux).",
  avant_apres: "Raconter un chantier type en avant/après, pour montrer le savoir-faire (sans inventer de client réel).",
  prix: "Expliquer de quoi dépend le prix de ce type de travaux et pourquoi demander un devis, sans donner de prix chiffré.",
  saison: "Une vidéo de saison : ce qu'il faut prévoir en ce moment de l'année pour ce type de travaux.",
  coulisses: "Montrer les coulisses du métier : le matériel, la préparation, le sérieux du travail.",
};

const supaHeaders = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});

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
        { headers: supaHeaders() }
      );
      const rows = await resp.json();
      const draft = rows[0];
      return !!(draft && draft.email && draft.email.toLowerCase() === email.toLowerCase());
    }
    return false;
  } catch (e) {
    return false;
  }
}

// Récupère la fiche de l'artisan et lui attribue un prénom d'agent s'il n'en
// a pas encore (une seule fois, ensuite c'est toujours le même).
async function chargerFicheAgent(draftId) {
  const resp = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}&select=entreprise,metier,adresse_ville,agent_ia_prenom`,
    { headers: supaHeaders() }
  );
  const rows = await resp.json();
  const fiche = rows[0];
  if (!fiche) return null;
  if (!fiche.agent_ia_prenom) {
    const prenom = PRENOMS_AGENT[Math.floor(Math.random() * PRENOMS_AGENT.length)];
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_vitrine_drafts?id=eq.${draftId}`, {
      method: 'PATCH',
      headers: supaHeaders(),
      body: JSON.stringify({ agent_ia_prenom: prenom }),
    });
    fiche.agent_ia_prenom = prenom;
  }
  return fiche;
}

function libelleMetier(metier) {
  if (Array.isArray(metier)) return metier.join(', ');
  return metier || 'artisan du bâtiment';
}

async function genererScript(fiche, theme, idee) {
  const entreprise = fiche.entreprise || "l'entreprise";
  const metier = libelleMetier(fiche.metier);
  const ville = fiche.adresse_ville || '';
  const prenom = fiche.agent_ia_prenom;

  const systemPrompt = `Tu écris des scripts de vidéos courtes (TikTok, Instagram Reels, Facebook) pour un artisan français.
La vidéo est dite par un avatar IA nommé ${prenom}, l'assistant IA de l'entreprise "${entreprise}" (${metier}${ville ? ', basée à ' + ville : ''}).
Le public : des particuliers de la zone qui pourraient avoir besoin de ces travaux.

Règles strictes :
- ${prenom} dit clairement dans les 5 premières secondes qu'il est l'assistant IA de ${entreprise}. Ton détendu, un peu d'humour sur le fait d'être une IA, jamais moqueur.
- Tutoiement ou vouvoiement : vouvoiement (public de particuliers).
- 60 à 90 mots pour le texte de l'avatar (25 à 35 secondes à l'oral). Phrases courtes, à l'oral, sans jargon.
- N'invente AUCUN chiffre, prix, statistique, avis client, nom de client, certification, garantie ou délai. Si une information n'est pas fournie, n'en parle pas.
- Aucune promesse de résultat. Pas de superlatifs du type "le meilleur", "n°1".
- Termine par un appel à l'action simple : demander un devis gratuit via le lien en bio, ou écrire "DEVIS" en commentaire.
- Hashtags : 5 ou 6, en minuscules, pertinents pour le métier et la ville si connue.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour ni balises Markdown, de la forme :
{"titre": "...", "accroche_ecran": "...", "texte_avatar": "...", "textes_ecran": ["...", "...", "..."], "legende": "...", "hashtags": ["#...", "#..."]}
- accroche_ecran : 4 à 9 mots, en majuscules, affichés pendant les 3 premières secondes.
- textes_ecran : 3 ou 4 textes courts (moins de 8 mots chacun) à afficher pendant la vidéo.
- legende : 1 à 2 phrases.`;

  const consigneTheme = THEMES[theme] || THEMES.presentation;
  const message = `Thème de la vidéo : ${consigneTheme}${idee ? `\nIdée ou précision de l'artisan : ${idee}` : ''}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODELE_CLAUDE,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || 'Erreur Claude');
  const texte = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const propre = texte.replace(/```json|```/g, '').trim();
  const script = JSON.parse(propre);
  if (!script.texte_avatar) throw new Error('Script incomplet');
  return script;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Méthode non autorisée.' });
  }
  const { draftId, token, action, theme, idee } = req.body || {};
  if (!draftId || !token) {
    return res.status(400).json({ success: false, error: 'Paramètres manquants.' });
  }
  if (!(await verifierToken(token, draftId))) {
    return res.status(401).json({ success: false, error: 'Session expirée. Reconnectez-vous à votre tableau de bord.' });
  }

  try {
    const fiche = await chargerFicheAgent(draftId);
    if (!fiche) return res.status(404).json({ success: false, error: 'Vitrine introuvable.' });

    if (action === 'lister') {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_video_scripts?draft_id=eq.${draftId}&select=*&order=created_at.desc&limit=30`,
        { headers: supaHeaders() }
      );
      const scripts = r.ok ? await r.json() : [];
      return res.status(200).json({ success: true, agentPrenom: fiche.agent_ia_prenom, scripts });
    }

    if (action === 'generer') {
      const depuis = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const rc = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_video_scripts?draft_id=eq.${draftId}&created_at=gte.${encodeURIComponent(depuis)}&select=id`,
        { headers: supaHeaders() }
      );
      const recents = rc.ok ? await rc.json() : [];
      if (recents.length >= MAX_SCRIPTS_PAR_24H) {
        return res.status(429).json({ success: false, error: `Limite de ${MAX_SCRIPTS_PAR_24H} scripts par jour atteinte. Réessayez demain.` });
      }

      const ideePropre = typeof idee === 'string' ? idee.slice(0, 500) : '';
      const themePropre = THEMES[theme] ? theme : 'presentation';
      const script = await genererScript(fiche, themePropre, ideePropre);

      const ins = await fetch(`${process.env.SUPABASE_URL}/rest/v1/skyeco_pro_video_scripts`, {
        method: 'POST',
        headers: { ...supaHeaders(), Prefer: 'return=representation' },
        body: JSON.stringify({
          draft_id: draftId,
          theme: themePropre,
          idee: ideePropre || null,
          titre: script.titre || null,
          accroche_ecran: script.accroche_ecran || null,
          texte_avatar: script.texte_avatar,
          textes_ecran: Array.isArray(script.textes_ecran) ? script.textes_ecran : [],
          legende: script.legende || null,
          hashtags: Array.isArray(script.hashtags) ? script.hashtags : [],
        }),
      });
      const lignes = await ins.json();
      if (!ins.ok) throw new Error('Enregistrement impossible');
      return res.status(200).json({ success: true, agentPrenom: fiche.agent_ia_prenom, script: lignes[0] });
    }

    return res.status(400).json({ success: false, error: 'Action inconnue.' });
  } catch (e) {
    console.error('Erreur generer-script-video:', e);
    return res.status(500).json({ success: false, error: "L'agent n'a pas pu écrire le script. Réessayez dans un instant." });
  }
}
