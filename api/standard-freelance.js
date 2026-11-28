// api/standard-freelance.js
//
// STANDARD TÉLÉPHONIQUE DES COMMERCIAUX FREELANCES (Skyeco)
//
// Le freelance n'a jamais le numéro du prospect : il clique « Appeler » sur sa
// page (skyeco.fr/freelance/?c=SON_CODE). Twilio fait sonner SON portable,
// puis appelle le prospect en affichant le numéro Skyeco. L'appel est
// enregistré (2 voix séparées), transcrit en direct en français, et résumé
// par l'IA à la fin. Cyrille retrouve tout sur skyeco.fr/admin/standard.html.
//
// Le prospect entend en décrochant : « vous allez être mis en relation avec
// un conseiller Skyeco, cet appel est enregistré » (obligation d'information).
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

export const config = { maxDuration: 60 };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const CALLER_ID = process.env.STANDARD_CALLER_ID || '+33219121448';
const VOIX = 'Polly.Lea-Neural';
const MODELE = 'claude-sonnet-4-6';
const STATUTS = ['a_appeler', 'a_rappeler', 'interesse', 'pas_interesse', 'client', 'injoignable'];

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
    if (action === 'liste') {
      const f = await freelanceParCode(q.c);
      if (!f) return res.status(403).json({ erreur: 'Lien invalide ou désactivé.' });
      const { data: pros } = await supabase.from('freelance_prospects').select('id,nom,entreprise,telephone,ville,metier,statut,note').eq('freelance_id', f.id).order('created_at');
      const { data: appels } = await supabase.from('freelance_appels').select('prospect_id,statut,duree,created_at').eq('freelance_id', f.id).order('created_at', { ascending: false }).limit(300);
      return res.status(200).json({
        prenom: f.prenom,
        prospects: (pros || []).map((p) => ({ ...p, telephone: masquer(p.telephone), dernier: (appels || []).find((a) => a.prospect_id === p.id) || null })),
      });
    }
    if (action === 'appeler' && req.method === 'POST') {
      const f = await freelanceParCode(b.c);
      if (!f) return res.status(403).json({ erreur: 'Lien invalide ou désactivé.' });
      const { data: p } = await supabase.from('freelance_prospects').select('id,nom,entreprise,telephone').eq('id', b.prospect_id).eq('freelance_id', f.id).maybeSingle();
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
    if (action === 'statut' && req.method === 'POST') {
      const f = await freelanceParCode(b.c);
      if (!f) return res.status(403).json({ erreur: 'Lien invalide ou désactivé.' });
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
        const qui = [p.nom, p.entreprise].filter(Boolean).join(', ') || 'votre prospect';
        await supabase.from('freelance_appels').update({ statut: 'en_cours', updated_at: new Date().toISOString() }).eq('id', appelId);
        return twiml(res,
          `<Say voice="${VOIX}" language="fr-FR">Skyeco. Appel de ${xml(qui)}. La conversation est enregistrée.</Say>` +
          `<Start><Transcription languageCode="fr-FR" track="both_tracks" partialResults="false" statusCallbackUrl="${xml(url(req, 'transcription', `&appel=${appelId}`))}"/></Start>` +
          `<Dial callerId="${CALLER_ID}" timeout="30" record="record-from-answer-dual" recordingStatusCallback="${xml(url(req, 'enregistrement', `&appel=${appelId}`))}" recordingStatusCallbackEvent="completed">` +
          `<Number url="${xml(url(req, 'annonce'))}">${numero}</Number></Dial>` +
          `<Say voice="${VOIX}" language="fr-FR">L'appel est terminé. Pensez à mettre à jour la fiche du prospect.</Say>`);
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
        await supabase.from('freelance_appels').update({ statut, updated_at: new Date().toISOString() }).eq('id', appelId);
        await new Promise((r) => setTimeout(r, 4000)); // derniers morceaux de transcription
        await finaliser(appelId);
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
          supabase.from('freelances').select('*').order('created_at'),
          supabase.from('freelance_prospects').select('id,freelance_id,nom,entreprise,telephone,ville,statut').order('created_at'),
          supabase.from('freelance_appels').select('id,freelance_id,prospect_id,statut,duree,recording_sid,transcription,resume,interet,created_at').order('created_at', { ascending: false }).limit(150),
        ]);
        return res.status(200).json({ freelances: fl || [], prospects: pros || [], appels: appels || [] });
      }
      if (action === 'admin_freelance') {
        const tel = e164(b.telephone);
        if (!b.prenom || !tel) return res.status(400).json({ erreur: 'Prénom et portable valides obligatoires.' });
        const { data, error } = await supabase.from('freelances').insert({ prenom: String(b.prenom).trim(), nom: b.nom ? String(b.nom).trim() : null, telephone: tel }).select('*').single();
        if (error) throw error;
        return res.status(200).json({ ok: true, freelance: data });
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
