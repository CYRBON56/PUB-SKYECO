// 09/10/2026 — Démos en direct des 3 applis d'hiver, avec les vraies prévisions
// (via /api/meteo-demo, données MET Norway). La page déclare data-produit sur <body>.
(function () {
  const $ = (id) => document.getElementById(id);
  const produit = document.body.dataset.produit;
  const TZ = 'Europe/Paris';
  const fmtJour = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  const fmtCle = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtHeure = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
  const cleJour = (d) => fmtCle.format(d);
  const heure = (d) => Number(fmtHeure.formatToParts(d).find((x) => x.type === 'hour').value);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v, d = 0) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
  // Normales mensuelles approximatives (moitié ouest de la France), au-delà des 9 jours de prévision
  const NORMALES = [5.5, 6, 8.5, 10.5, 14, 17, 19, 19, 16.5, 13, 8.5, 6];

  async function trouverCommune(saisie) {
    const s = saisie.trim();
    if (!s) throw new Error('Indiquez une commune ou un code postal.');
    const q = /^\d{5}$/.test(s) ? 'codePostal=' + s : 'nom=' + encodeURIComponent(s) + '&boost=population';
    const r = await fetch('https://geo.api.gouv.fr/communes?' + q + '&fields=nom,centre,codeDepartement&limit=1');
    const l = r.ok ? await r.json() : [];
    if (!l.length || !l[0].centre) throw new Error('Commune introuvable. Essayez le code postal.');
    const [lon, lat] = l[0].centre.coordinates;
    return { nom: l[0].nom, dep: l[0].codeDepartement, lat, lon };
  }
  async function previsions(c) {
    const r = await fetch(`/api/meteo-demo?lat=${c.lat}&lon=${c.lon}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.points) throw new Error(j.error || 'Prévisions indisponibles pour le moment.');
    return j.points.map((p) => ({ ...p, d: new Date(p.t) }));
  }
  // Moyennes journalières (heure de Paris) à partir des points 1 h / 6 h
  function moyennesJour(points) {
    const m = new Map();
    for (const p of points) {
      const k = cleJour(p.d); const e = m.get(k) || { s: 0, n: 0 };
      e.s += p.T * p.h; e.n += p.h; m.set(k, e);
    }
    return [...m.entries()].filter(([, e]) => e.n >= 18).map(([k, e]) => ({ cle: k, T: e.s / e.n }));
  }
  const dju = (T) => Math.max(0, 18 - T);
  function lancer(form, travail) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const out = form.querySelector('.demo-res'), b = form.querySelector('button[type=submit]');
      b.disabled = true; out.innerHTML = '<p class="demo-attente">Récupération des prévisions…</p>';
      try {
        const c = await trouverCommune(form.querySelector('.demo-commune').value);
        const pts = await previsions(c);
        out.innerHTML = travail(c, pts);
      } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
      finally { b.disabled = false; }
    });
  }

  /* ---------------- Météo Chantier ---------------- */
  const METIERS = {
    resine: { nom: 'Sol résine, étanchéité liquide', test(p, i, h) {
      if (p.T < 5) return ['bad', `trop froid (${num(p.T)} °C)`];
      if (p.dew != null && p.T - p.dew < 3) return ['bad', 'risque de condensation (point de rosée)'];
      if (p.rh != null && p.rh > 85) return ['bad', `humidité ${num(p.rh)} %`];
      if (pluie(h, i, 4) > 0.1) return ['bad', 'pluie avant séchage'];
      return ['ok', ''];
    } },
    beton: { nom: 'Béton, chape, maçonnerie', test(p, i, h) {
      if (p.T < 5) return ['bad', `trop froid au coulage (${num(p.T)} °C)`];
      if (tmin(h, i, 0, 48) <= 0) return ['warn', 'gel dans les 48 h : protéger'];
      return ['ok', ''];
    } },
    enrobe: { nom: 'Enrobé', test(p, i, h) {
      if (p.T < 5) return ['bad', `trop froid (${num(p.T)} °C)`];
      if (tmin(h, i, -6, 0) <= 0.5) return ['bad', 'gel au sol probable'];
      if (p.pr > 0.1) return ['bad', 'support mouillé'];
      return ['ok', ''];
    } },
    peinture: { nom: 'Peinture, enduit de façade', test(p, i, h) {
      if (p.T < 5) return ['bad', `trop froid (${num(p.T)} °C)`];
      if (p.T > 30) return ['bad', 'trop chaud'];
      if (p.rh != null && p.rh > 80) return ['bad', `humidité ${num(p.rh)} %`];
      if (pluie(h, i, 24) > 0.5) return ['bad', 'pluie dans les 24 h'];
      return ['ok', ''];
    } },
    carrelage: { nom: 'Carrelage extérieur, colle', test(p, i, h) {
      if (p.T < 5) return ['bad', `trop froid (${num(p.T)} °C)`];
      if (tmin(h, i, 0, 24) <= 0) return ['bad', 'gel dans les 24 h'];
      return ['ok', ''];
    } },
  };
  // h = points horaires uniquement ; i = index de l'heure testée
  function pluie(h, i, n) { let s = 0; for (let k = i; k < Math.min(h.length, i + n); k++) s += h[k].pr; return s; }
  function tmin(h, i, a, b) { let m = Infinity; for (let k = Math.max(0, i + a); k <= Math.min(h.length - 1, i + b); k++) m = Math.min(m, h[k].T); return m; }

  function verdictJour(h, cle, metier) {
    const heures = [];
    h.forEach((p, i) => { const hh = heure(p.d); if (cleJour(p.d) === cle && hh >= 7 && hh <= 19) heures.push({ hh, p, r: metier.test(p, i, h) }); });
    if (heures.length < 6) return null;
    let best = null, cur = null;
    for (const x of heures) {
      if (x.r[0] === 'ok') { cur = cur ? { a: cur.a, b: x.hh } : { a: x.hh, b: x.hh }; if (!best || cur.b - cur.a > best.b - best.a) best = { ...cur }; }
      else cur = null;
    }
    // Regroupe « trop froid (4 °C) » et « trop froid (5 °C) » sous le même motif
    const raisons = {}; heures.forEach((x) => { if (x.r[1]) { const k = x.r[1].replace(/\s*\(.*\)$/, ''); raisons[k] = (raisons[k] || 0) + 1; } });
    const principale = Object.entries(raisons).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    let chip, texte;
    if (best && best.b - best.a >= 1) { chip = ['ok', best.a === heures[0].hh && best.b === heures[heures.length - 1].hh ? 'OK toute la journée' : `OK ${best.a}h–${Math.min(best.b + 1, 19)}h`]; texte = principale ? `En dehors de ce créneau : ${principale}.` : 'Conditions bonnes sur toute la plage de travail.'; }
    else if (heures.some((x) => x.r[0] === 'warn')) { chip = ['warn', 'Avec précautions']; texte = principale.charAt(0).toUpperCase() + principale.slice(1) + '.'; }
    else { chip = ['bad', 'Non']; texte = principale.charAt(0).toUpperCase() + principale.slice(1) + '.'; }
    const bande = heures.map((x) => `<span class="h-${x.r[0]}" title="${x.hh}h : ${num(x.p.T)} °C${x.p.rh != null ? ', humidité ' + num(x.p.rh) + ' %' : ''}${x.r[1] ? ' – ' + esc(x.r[1]) : ''}"></span>`).join('');
    const ref = heures.find((x) => x.hh === 9) || heures[0];
    return { chip, texte, bande, debut: heures[0].hh, fin: heures[heures.length - 1].hh, ref };
  }

  if (produit === 'meteo-chantier') {
    lancer($('demo-form'), (c, pts) => {
      const metier = METIERS[$('demo-metier').value];
      const h = pts.filter((p) => p.h === 1);
      const auj = cleJour(new Date());
      const jours = [...new Set(h.map((p) => cleJour(p.d)))].filter((k) => k > auj).slice(0, 2);
      const blocs = jours.map((k) => {
        const v = verdictJour(h, k, metier); if (!v) return '';
        const date = fmtJour.format(new Date(k + 'T12:00:00'));
        return `<div class="tile"><div class="row"><strong>${esc(date.charAt(0).toUpperCase() + date.slice(1))}</strong><span class="chip ${v.chip[0]}">${esc(v.chip[1])}</span></div>
          <div class="bande" aria-hidden="true">${v.bande}</div><div class="bande-lbl"><span>${v.debut}h</span><span>${v.fin}h</span></div>
          <span class="meta">${esc(v.texte)} À ${v.ref.hh}h : ${num(v.ref.p.T)} °C${v.ref.p.rh != null ? ', humidité ' + num(v.ref.p.rh) + ' %' : ''}${v.ref.p.dew != null ? ', rosée ' + num(v.ref.p.dew) + ' °C' : ''}.</span></div>`;
      }).join('');
      return `<p class="demo-titre">${esc(metier.nom)} · ${esc(c.nom)} (${esc(c.dep)})</p>${blocs || '<p>Prévisions horaires indisponibles pour ces jours.</p>'}
        <p class="demo-note">Démo avec les vraies prévisions de votre commune. Une case par heure : vert, on y va ; orange, avec précautions ; rouge, non. Données : MET Norway (CC BY 4.0).</p>`;
    });
  }

  /* ---------------- Stock granulés / bois ---------------- */
  function projectionJours(pts) {
    const prev = moyennesJour(pts).filter((x) => x.cle > cleJour(new Date())).slice(0, 9);
    const jours = prev.map((x) => ({ ...x, prevu: true }));
    let d = new Date((jours.length ? jours[jours.length - 1].cle : cleJour(new Date())) + 'T12:00:00');
    while (jours.length < 220) { d = new Date(d.getTime() + 864e5); jours.push({ cle: cleJour(d), T: NORMALES[d.getMonth()], prevu: false }); }
    return jours;
  }
  if (produit === 'stock-granules') {
    lancer($('demo-form'), (c, pts) => {
      const stock = Math.max(0, Number($('demo-stock').value) || 0), sem = Math.max(0.5, Number($('demo-semaine').value) || 0);
      const jours = projectionJours(pts);
      // Consommation par degré-jour, calée sur une semaine « normale » du mois en cours
      const ref = 7 * dju(NORMALES[new Date().getMonth()]) || 7;
      const parDJU = sem / Math.max(ref, 14);
      let reste = stock, fin = null, sem7 = 0;
      jours.forEach((j, i) => { const c = dju(j.T) * parDJU; if (i < 7) sem7 += c; if (fin === null) { reste -= c; if (reste <= 0) fin = j; } });
      const froid = jours.slice(0, 9).reduce((m, j) => (j.T < m.T ? j : m), jours[0]);
      let html = `<p class="demo-titre">${esc(c.nom)} (${esc(c.dep)}) · ${num(stock)} sacs en stock</p>`;
      if (!fin) html += `<div class="tile"><div class="row"><strong>Votre stock tient</strong><span class="chip ok">tout l'hiver</span></div><span class="meta">Au rythme estimé, vous ne serez pas à court avant le printemps.</span></div>`;
      else {
        const dFin = new Date(fin.cle + 'T12:00:00'), dCmd = new Date(dFin.getTime() - 21 * 864e5);
        const urgent = dCmd <= new Date();
        html += `<div class="tile"><div class="row"><strong>Tient jusqu'au</strong><span class="chip ${urgent ? 'bad' : 'warn'}">${esc(fmtJour.format(dFin))}</span></div><span class="meta">${fin.prevu ? 'Selon les prévisions des prochains jours.' : 'Prévisions sur 9 jours, puis températures moyennes de saison.'}</span></div>
          <div class="tile"><div class="row"><strong>Recommandez avant le</strong><span class="chip ${urgent ? 'bad' : 'ok'}">${urgent ? 'maintenant' : esc(fmtJour.format(dCmd))}</span></div><span class="meta">En comptant 3 semaines de délai de livraison en plein hiver.</span></div>`;
      }
      html += `<div class="tile"><div class="row"><strong>Les 7 prochains jours</strong><span>${num(sem7, 1)} sacs</span></div><span class="meta">Journée la plus froide prévue : ${esc(fmtJour.format(new Date(froid.cle + 'T12:00:00')))}, ${num(froid.T, 1)} °C en moyenne.</span></div>
        <p class="demo-note">Démo simplifiée : l'appli apprendra votre vraie consommation semaine après semaine. Données : MET Norway (CC BY 4.0).</p>`;
      return html;
    });
  }

  /* ---------------- Facture chauffage ---------------- */
  if (produit === 'facture-chauffage') {
    lancer($('demo-form'), (c, pts) => {
      const kwh = Math.max(1, Number($('demo-kwh').value) || 0), prix = Math.max(0.01, Number(String($('demo-prix').value).replace(',', '.')) || 0.25);
      const jours = projectionJours(pts);
      const ref = 7 * dju(NORMALES[new Date().getMonth()]) || 7;
      const parDJU = kwh / Math.max(ref, 14);
      const finMars = (new Date().getMonth() >= 3 ? new Date().getFullYear() + 1 : new Date().getFullYear()) + '-03-31';
      const mois = new Map(); let total = 0;
      for (const j of jours) { if (j.cle > finMars) break; const k = j.cle.slice(0, 7); const v = dju(j.T) * parDJU; mois.set(k, (mois.get(k) || 0) + v); total += v; }
      const fmtMois = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' });
      const max = Math.max(...mois.values());
      const lignes = [...mois.entries()].map(([k, v]) => `<div class="mois"><span>${esc(fmtMois.format(new Date(k + '-15T12:00:00')))}</span><span class="barre"><i style="width:${(v / max) * 100}%"></i></span><span>${num(v * prix)} €</span></div>`).join('');
      return `<p class="demo-titre">${esc(c.nom)} (${esc(c.dep)}) · ${num(kwh)} kWh par semaine en ce moment</p>
        <div class="tile"><span class="meta">Chauffage prévu d'ici au 31 mars</span><span class="gros">${num(total * prix)} €</span><span class="meta">${num(total)} kWh à ${num(prix, 4)} € le kWh</span></div>
        <div class="tile">${lignes}</div>
        <p class="demo-note">Démo simplifiée : prévisions sur 9 jours, puis températures moyennes de saison. L'appli affinera avec vos relevés chaque semaine. Données : MET Norway (CC BY 4.0).</p>`;
    });
  }
})();
