// api/standard-freelance.js
//
// STANDARD TÉLÉPHONIQUE DES COMMERCIAUX FREELANCES (Skyeco)
//
// Le freelance n'a jamais le numéro du prospect : il clique « Appeler » sur sa
// page (skyeco.fr/freelance/?c=SON_CODE). Twilio fait sonner SON portable et,
// dès qu'il décroche, appelle le prospect en affichant le numéro Skyeco.
// Pas d'enregistrement (choix de Cyrille, 28/11/2026) : on garde seulement
// le journal des appels (qui, quand, durée) sur skyeco.fr/admin/standard.html.
// Le code d'enregistrement/transcription reste en place mais n'est plus appelé.
//
// Actions (?action=) :
//   Freelance (code d'accès)   : liste (GET), appeler (POST), statut (POST)
//   Twilio (signature vérifiée): pont, annonce, transcription, enregistrement, fin
//   Admin (clé admin:code)     : admin_liste, admin_freelance, admin_actif, admin_import, audio (GET)
//
// Variables : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, ANTHROPIC_API_KEY ; optionnelle STANDARD_CALLER_ID
// (défaut : +33219121448, le numéro Skyeco qui s'affiche chez le prospect).

import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import crypto from 'crypto';

export const config = { maxDuration: 60 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const CALLER_ID = process.env.STANDARD_CALLER_ID || '+33219121448';
const VOIX = 'Polly.Lea-Neural';
const MODELE = 'claude-sonnet-4-6';
const STATUTS = ['a_appeler', 'a_rappeler', 'interesse', 'pas_interesse', 'client', 'injoignable', 'termine', 'archive'];

const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
const url = (req, action, extra = '') => `${base(req)}/api/standard-freelance?action=${action}${extra}`;

function e164(tel) {
  let d = String(tel || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (/^0\d{9}$/.test(d)) d = '+33' + d.slice(1);
  if (/^33\d{9}$/.test(d)) d = '+' + d;
  return /^\+\d{10,15}$/.test(d) ? d : null;
}
const masquer = (tel) => { const d = String(tel || '').replace(/\D/g, ''); return d ? '•• •• •• ' + d.slice(-4, -2) + ' ' + d.slice(-2) : ''; };

function twilioOk(req) {
  const sig = req.headers['x-twilio-signature'];
  if (!sig || !TOKEN) return false;
  return twilio.validateRequest(TOKEN, sig, base(req) + req.url, req.body && typeof req.body === 'object' ? req.body : {});
}
async function adminOk(cle) {
  if (!cle) return false;
  const { data } = await supabase.rpc('map_admin_ok', { p: String(cle) });
  return data === true;
}
async function freelanceParCode(code) {
  if (!code || String(code).length < 16) return null;
  const { data } = await supabase.from('freelances').select('*').eq('code_acces', String(code)).eq('actif', true).maybeSingle();
  return data;
}
// ---------- Code personnel du freelance (créé par lui à la 1re ouverture) ----------
const hacher = (pin, sel = crypto.randomBytes(12).toString('hex')) => sel + ':' + crypto.scryptSync(String(pin), sel, 32).toString('hex');
function pinOk(f, pin) {
  if (!f.pin_hash || !pin) return false;
  const [sel, h] = f.pin_hash.split(':');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(String(pin), sel, 32));
}
// Renvoie { f } si lien + code valides, sinon { refus } à renvoyer tel quel
async function freelanceAuth(code, pin) {
  const f = await freelanceParCode(code);
  if (!f) return { refus: { status: 403, corps: { erreur: 'Lien invalide ou désactivé.' } } };
  if (!f.pin_hash) return { refus: { status: 401, corps: { code_a_creer: true, prenom: f.prenom } } };
  if (f.pin_bloque_jusqua && new Date(f.pin_bloque_jusqua) > new Date()) return { refus: { status: 429, corps: { code_requis: true, prenom: f.prenom, erreur: 'Trop d’essais : réessayez dans 15 minutes.' } } };
  if (!pinOk(f, pin)) {
    if (pin) {
      const n = (f.pin_essais || 0) + 1;
      await supabase.from('freelances').update(n >= 5 ? { pin_essais: 0, pin_bloque_jusqua: new Date(Date.now() + 15 * 60000).toISOString() } : { pin_essais: n }).eq('id', f.id);
      return { refus: { status: 401, corps: { code_requis: true, prenom: f.prenom, erreur: 'Code incorrect.' } } };
    }
    return { refus: { status: 401, corps: { code_requis: true, prenom: f.prenom } } };
  }
  if (f.pin_essais) await supabase.from('freelances').update({ pin_essais: 0 }).eq('id', f.id);
  return { f };
}

const twiml = (res, corps) => { res.setHeader('Content-Type', 'text/xml; charset=utf-8'); return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${corps}</Response>`); };

// ---------- Fin d'appel : transcription propre + résumé IA ----------
async function finaliser(appelId) {
  const { data: a } = await supabase.from('freelance_appels').select('*').eq('id', appelId).maybeSingle();
  if (!a || a.resume) return;
  const morceaux = (a.morceaux || []).filter((m) => m && m.x);
  if (!morceaux.length) return;
  const texte = morceaux
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts)))
    .map((m) => `${m.t === 'inbound_track' ? 'Commercial' : 'Prospect'} : ${m.x}`)
    .join('\n');
  let resume = null, interet = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODELE, max_tokens: 500,
        messages: [{ role: 'user', content: `Voici la transcription automatique (elle peut contenir des erreurs) d'un appel de prospection d'un commercial Skyeco (applications pour artisans : Mon Assistant Pro, Contact Chantier, Estimateur BTP…) vers un prospect.\n\n${texte}\n\nRéponds UNIQUEMENT en JSON : {"interet":"fort|moyen|faible|aucun|inconnu","resume":"3 à 5 phrases courtes en français : qui est le prospect, son besoin, ses objections, ce qui a été convenu, la suite à donner, et un mot sur la qualité du discours du commercial"}` }],
      }),
    });
    const j = await r.json();
    const t = (j.content || []).map((c) => c.text || '').join('');
    const o = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    resume = o.resume || null; interet = o.interet || null;
  } catch (e) { console.error('standard-freelance résumé:', e.message); }
  await supabase.from('freelance_appels').update({ transcription: texte, resume, interet, updated_at: new Date().toISOString() }).eq('id', appelId);
}

export default async function handler(req, res) {
  const action = String(req.query.action || '');
  const q = req.query, b = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    // ================= FREELANCE =================
    if (action === 'definir_code' && req.method === 'POST') {
      const f = await freelanceParCode(b.c);
      if (!f) return res.status(403).json({ erreur: 'Lien invalide ou désactivé.' });
      if (f.pin_hash) return res.status(409).json({ erreur: 'Un code existe déjà. Demandez à Skyeco de le réinitialiser si vous l’avez oublié.' });
      if (!/^\d{4,8}$/.test(String(b.pin || ''))) return res.status(400).json({ erreur: 'Le code doit faire de 4 à 8 chiffres.' });
      await supabase.from('freelances').update({ pin_hash: hacher(b.pin), pin_essais: 0, pin_bloque_jusqua: null }).eq('id', f.id).is('pin_hash', null);
      return res.status(200).json({ ok: true });
    }
    if (action === 'liste') {
      // Le freelance ne voit QUE ses prospects (100 actifs maximum, attribués à sa demande)
      const au = await freelanceAuth(q.c, req.headers['x-code']);
      if (au.refus) return res.status(au.refus.status).json(au.refus.corps);
      const f = au.f;
      let r = supabase.from('freelance_prospects').select('id,nom,entreprise,telephone,ville,departement,region,metier,statut,note,siret,email,adresse,site_web', { count: 'exact' }).eq('freelance_id', f.id);
      if (q.statut && STATUTS.includes(q.statut)) r = r.eq('statut', q.statut);
      else r = r.neq('statut', 'archive');
      if (q.q) { const t = String(q.q).replace(/[%,()*]/g, ' ').trim(); if (t) r = r.or(`entreprise.ilike.*${t}*,ville.ilike.*${t}*,metier.ilike.*${t}*,departement.eq.${t}`); }
      const page = Math.max(0, Number(q.page || 0));
      const [{ data: pros, count }, { count: actifs }, { data: crit }] = await Promise.all([
        r.order('departement').order('ville').range(page * 50, page * 50 + 49),
        supabase.from('freelance_prospects').select('id', { count: 'exact', head: true }).eq('freelance_id', f.id).not('statut', 'in', '(termine,archive,pas_interesse,client)'),
        supabase.rpc('freelance_criteres'),
      ]);
      const ids = (pros || []).map((p) => p.id);
      const { data: appels } = ids.length ? await supabase.from('freelance_appels').select('prospect_id,created_at').in('prospect_id', ids).order('created_at', { ascending: false }) : { data: [] };
      return res.status(200).json({
        prenom: f.prenom, total: count || 0, page, actifs: actifs || 0, max: f.quota || 100, demande_le: f.demande_plus_le, criteres: crit || { regions: [], metiers: [] },
        prospects: (pros || []).map((p) => ({ ...p, dernier: (appels || []).find((a) => a.prospect_id === p.id) || null })),
      });
    }
    if (action === 'attribuer' && req.method === 'POST') {
      const au = await freelanceAuth(b.c, req.headers['x-code']);
      if (au.refus) return res.status(au.refus.status).json(au.refus.corps);
      const f = au.f;
      if (!b.region && !b.metier) return res.status(400).json({ erreur: 'Choisissez une région ou une activité.' });
      const { data: n, error } = await supabase.rpc('freelance_attribuer', { p_freelance: f.id, p_region: b.region || null, p_metier: b.metier || null, p_max: f.quota || 100 });
      if (error) throw error;
      if (!n) return res.status(200).json({ ok: false, message: `Vous avez déjà ${f.quota || 100} prospects en cours (ou plus aucun disponible pour ce choix). Demandez-en plus à Skyeco, ou terminez / archivez-en.` });
      return res.status(200).json({ ok: true, message: `${n} nouveaux prospects ajoutés à votre liste.` });
    }
    if (action === 'appeler' && req.method === 'POST') {
      const au = await freelanceAuth(b.c, req.headers['x-code']);
      if (au.refus) return res.status(au.refus.status).json(au.refus.corps);
      const f = au.f;
      const { data: p } = await supabase.from('freelance_prospects').select('id,nom,entreprise,telephone,freelance_id').eq('id', b.prospect_id).maybeSingle();
      if (p && p.freelance_id !== f.id) return res.status(403).json({ erreur: 'Ce prospect ne fait pas partie de votre liste.' });
      if (!p || !e164(p.telephone)) return res.status(400).json({ erreur: 'Prospect introuvable ou numéro invalide.' });
      const { data: appel, error } = await supabase.from('freelance_appels').insert({ freelance_id: f.id, prospect_id: p.id }).select('id').single();
      if (error) throw error;
      const call = await twilio(SID, TOKEN).calls.create({
        to: f.telephone, from: CALLER_ID, timeout: 30,
        url: url(req, 'pont', `&appel=${appel.id}`),
        statusCallback: url(req, 'fin', `&appel=${appel.id}`), statusCallbackEvent: ['completed'],
      });
      await supabase.from('freelance_appels').update({ call_sid: call.sid }).eq('id', appel.id);
      return res.status(200).json({ ok: true, message: 'Votre téléphone va sonner : décrochez, le prospect est appelé juste après.' });
    }
    if (action === 'demander_plus' && req.method === 'POST') {
      const au = await freelanceAuth(b.c, req.headers['x-code']);
      if (au.refus) return res.status(au.refus.status).json(au.refus.corps);
      const f = au.f;
      if (f.demande_plus_le && Date.now() - new Date(f.demande_plus_le).getTime() < 6 * 3600 * 1000) return res.status(200).json({ ok: true, message: 'Votre demande est déjà partie, Skyeco vous répond rapidement.' });
      const { count: actifs } = await supabase.from('freelance_prospects').select('id', { count: 'exact', head: true }).eq('freelance_id', f.id).not('statut', 'in', '(termine,archive,pas_interesse,client)');
      const to = e164(process.env.ADMIN_PHONE) || '+33645688394';
      await twilio(SID, TOKEN).messages.create({ to, from: process.env.TWILIO_FROM_NUMBER, body: `Skyeco : ${f.prenom}${f.nom ? ' ' + f.nom : ''} (freelance) a ${actifs || 0}/${f.quota || 100} prospects en cours et demande 100 prospects de plus. Pour accorder : ${base(req)}/admin/standard.html#freelances` });
      await supabase.from('freelances').update({ demande_plus_le: new Date().toISOString() }).eq('id', f.id);
      return res.status(200).json({ ok: true, message: 'Demande envoyée à Skyeco par SMS. Vous serez prévenu dès que c’est accordé.' });
    }
    if (action === 'appel_direct' && req.method === 'POST') {
      // Le freelance appelle depuis son propre téléphone : on note l'appel pour l'historique
      const au = await freelanceAuth(b.c, req.headers['x-code']);
      if (au.refus) return res.status(au.refus.status).json(au.refus.corps);
      const f = au.f;
      const { data: p } = await supabase.from('freelance_prospects').select('id,freelance_id').eq('id', b.prospect_id).maybeSingle();
      if (!p) return res.status(404).json({ erreur: 'Prospect introuvable.' });
      if (p.freelance_id !== f.id) return res.status(403).json({ erreur: 'Ce prospect ne fait pas partie de votre liste.' });
      await supabase.from('freelance_appels').insert({ freelance_id: f.id, prospect_id: p.id, statut: 'direct' });
      return res.status(200).json({ ok: true });
    }
    if (action === 'statut' && req.method === 'POST') {
      const au = await freelanceAuth(b.c, req.headers['x-code']);
      if (au.refus) return res.status(au.refus.status).json(au.refus.corps);
      const f = au.f;
      const maj = {};
      if (STATUTS.includes(b.statut)) maj.statut = b.statut;
      if (typeof b.note === 'string') maj.note = b.note.slice(0, 2000);
      await supabase.from('freelance_prospects').update(maj).eq('id', b.prospect_id).eq('freelance_id', f.id);
      return res.status(200).json({ ok: true });
    }

    // ================= TWILIO =================
    if (['pont', 'annonce', 'transcription', 'enregistrement', 'fin'].includes(action)) {
      if (!twilioOk(req)) return res.status(403).send('Signature invalide');
      const appelId = String(q.appel || '');
      if (action === 'annonce') {
        return twiml(res, `<Say voice="${VOIX}" language="fr-FR">Bonjour, vous allez être mis en relation avec un conseiller Skyeco. Cet appel peut être enregistré pour la qualité du service.</Say>`);
      }
      if (action === 'pont') {
        const { data: a } = await supabase.from('freelance_appels').select('id,prospect_id').eq('id', appelId).maybeSingle();
        const { data: p } = a ? await supabase.from('freelance_prospects').select('nom,entreprise,telephone').eq('id', a.prospect_id).maybeSingle() : { data: null };
        const numero = p && e164(p.telephone);
        if (!numero) return twiml(res, `<Say voice="${VOIX}" language="fr-FR">Désolé, le numéro du prospect est invalide.</Say><Hangup/>`);
        await supabase.from('freelance_appels').update({ statut: 'en_cours', updated_at: new Date().toISOString() }).eq('id', appelId);
        // Pas d'enregistrement ni d'annonce : dès que le freelance décroche, le prospect est appelé.
        return twiml(res, `<Dial callerId="${CALLER_ID}" timeout="30"><Number>${numero}</Number></Dial>`);
      }
      if (action === 'transcription') {
        const ev = b.TranscriptionEvent;
        if (ev === 'transcription-content' && b.CallSid) {
          let x = '';
          try { x = JSON.parse(b.TranscriptionData || '{}').transcript || ''; } catch { x = ''; }
          if (x.trim()) await supabase.rpc('freelance_ajout_morceau', { p_sid: b.CallSid, p_morceau: { t: b.Track, x: x.trim(), ts: b.Timestamp || new Date().toISOString(), n: Number(b.SequenceId || 0) } });
        }
        if (ev === 'transcription-stopped') await finaliser(appelId);
        return res.status(200).send('ok');
      }
      if (action === 'enregistrement') {
        await supabase.from('freelance_appels').update({ recording_sid: b.RecordingSid || null, duree: Number(b.RecordingDuration || 0) || null, updated_at: new Date().toISOString() }).eq('id', appelId);
        return res.status(200).send('ok');
      }
      if (action === 'fin') {
        const statut = b.CallStatus === 'completed' ? 'termine' : (b.CallStatus || 'termine');
        await supabase.from('freelance_appels').update({ statut, duree: Number(b.CallDuration || 0) || null, updated_at: new Date().toISOString() }).eq('id', appelId);
        return res.status(200).send('ok');
      }
    }

    // ================= ADMIN =================
    if (action === 'audio') {
      if (!(await adminOk(q.admin))) return res.status(403).send('Accès refusé');
      const { data: a } = await supabase.from('freelance_appels').select('recording_sid').eq('id', q.id).maybeSingle();
      if (!a?.recording_sid) return res.status(404).send('Pas d’enregistrement');
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${a.recording_sid}.mp3`, { headers: { Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64') } });
      if (!r.ok) return res.status(502).send('Enregistrement indisponible');
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.status(200).send(Buffer.from(await r.arrayBuffer()));
    }
    if (action.startsWith('admin_')) {
      if (req.method !== 'POST' || !(await adminOk(b.admin))) return res.status(403).json({ erreur: 'Accès refusé' });
      if (action === 'admin_liste') {
        const [{ data: fl }, { data: pros }, { data: appels }] = await Promise.all([
          supabase.from('freelances').select('id,prenom,nom,telephone,code_acces,actif,created_at,pin_hash,quota,demande_plus_le').order('created_at'),
          supabase.from('freelance_prospects').select('id,freelance_id,nom,entreprise,telephone,ville,region,statut').not('freelance_id', 'is', null).order('created_at').limit(3000),
          supabase.from('freelance_appels').select('id,freelance_id,prospect_id,statut,duree,recording_sid,transcription,resume,interet,created_at').order('created_at', { ascending: false }).limit(150),
        ]);
        return res.status(200).json({ freelances: (fl || []).map(({ pin_hash, ...f }) => ({ ...f, code_cree: !!pin_hash })), prospects: pros || [], appels: appels || [] });
      }
      if (action === 'admin_freelance') {
        const tel = e164(b.telephone);
        if (!b.prenom || !tel) return res.status(400).json({ erreur: 'Prénom et portable valides obligatoires.' });
        const { data, error } = await supabase.from('freelances').insert({ prenom: String(b.prenom).trim(), nom: b.nom ? String(b.nom).trim() : null, telephone: tel }).select('*').single();
        if (error) throw error;
        return res.status(200).json({ ok: true, freelance: data });
      }
      if (action === 'admin_quota') {
        const { data: f } = await supabase.from('freelances').select('quota').eq('id', b.id).maybeSingle();
        const quota = Math.max(0, (f?.quota || 100) + Number(b.ajout || 100));
        await supabase.from('freelances').update({ quota, demande_plus_le: null }).eq('id', b.id);
        return res.status(200).json({ ok: true, quota });
      }
      if (action === 'admin_reset_code') {
        await supabase.from('freelances').update({ pin_hash: null, pin_essais: 0, pin_bloque_jusqua: null }).eq('id', b.id);
        return res.status(200).json({ ok: true });
      }
      if (action === 'admin_actif') {
        await supabase.from('freelances').update({ actif: !!b.actif }).eq('id', b.id);
        return res.status(200).json({ ok: true });
      }
      if (action === 'admin_import') {
        // Une ligne par prospect : Nom ; Entreprise ; Téléphone ; Ville ; Métier
        const lignes = String(b.lignes || '').split(/\r?\n/).map((l) => l.split(/[;\t]/).map((s) => s.trim())).filter((c) => c.some(Boolean));
        const rows = [], rejets = [];
        for (const c of lignes) {
          const iTel = c.findIndex((x) => e164(x));
          if (iTel < 0) { rejets.push(c.join(' ; ')); continue; }
          const reste = c.filter((_, i) => i !== iTel);
          rows.push({ freelance_id: b.freelance_id || null, nom: reste[0] || null, entreprise: reste[1] || null, telephone: e164(c[iTel]), ville: reste[2] || null, metier: reste[3] || null });
        }
        if (rows.length) { const { error } = await supabase.from('freelance_prospects').insert(rows); if (error) throw error; }
        return res.status(200).json({ ok: true, ajoutes: rows.length, rejets });
      }
    }
    return res.status(400).json({ erreur: 'Action inconnue' });
  } catch (e) {
    console.error('standard-freelance', action, e.message);
    if (['pont', 'annonce'].includes(action)) return twiml(res, `<Say voice="${VOIX}" language="fr-FR">Désolé, une erreur technique empêche l'appel.</Say>`);
    return res.status(500).json({ erreur: 'Erreur serveur : ' + e.message });
  }
}
