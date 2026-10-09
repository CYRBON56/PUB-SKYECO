// 09/10/2026 — Précommande commune aux pages meteo-chantier, stock-granules, facture-chauffage.
// La page déclare <body data-produit="..."> ; les boutons ont la classe .js-precommander.
(function () {
  const produit = document.body.dataset.produit;
  const q = new URLSearchParams(location.search);
  const source = (q.get('src') || q.get('utm_source') || (/[?&](gclid|gbraid|wbraid)=/.test(location.search) ? 'gads' : '')).slice(0, 40);
  const evt = (type) => { try { navigator.sendBeacon('/api/precommande-evenement', new Blob([JSON.stringify({ produit, type, source })], { type: 'application/json' })); } catch (e) {} };
  const banniere = (txt, cls) => { const b = document.getElementById('banniere'); if (!b) return; b.textContent = txt; b.className = 'banniere ' + cls; b.hidden = false; };

  document.querySelectorAll('.js-precommander').forEach((btn) => btn.addEventListener('click', async () => {
    const err = btn.parentElement.querySelector('.err') || document.querySelector('.err');
    const metierSel = document.getElementById('metier');
    btn.disabled = true; const libelle = btn.textContent; btn.textContent = 'Redirection vers le paiement sécurisé…';
    evt('clic_precommande');
    try {
      const r = await fetch('/api/precommande-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ produit, source, metier: metierSel ? metierSel.value : null }) });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.error || 'Erreur');
      location.href = j.url;
    } catch (e) {
      if (err) err.textContent = e.message || "Le paiement n'a pas pu être préparé. Réessayez.";
      btn.disabled = false; btn.textContent = libelle;
    }
  }));

  const etat = q.get('precommande');
  if (etat === 'annule') banniere("Paiement annulé : aucun montant n'a été débité.", 'info');
  else if (etat === 'ok') {
    banniere('Vérification de votre paiement…', 'info');
    fetch('/api/precommande-confirmer?session_id=' + encodeURIComponent(q.get('session_id') || ''))
      .then((r) => r.json())
      .then((j) => banniere(j.paye ? `Merci, votre précommande est confirmée. Un email de confirmation a été envoyé${j.email ? ' à ' + j.email : ''}. Vous recevrez l'appli dès sa sortie.` : "Le paiement n'est pas encore confirmé. Rechargez la page dans une minute.", j.paye ? 'ok' : 'info'))
      .catch(() => banniere('Nous ne pouvons pas vérifier le paiement pour le moment. Rechargez la page dans une minute ou écrivez à infos@ecosky.fr.', 'info'));
  } else evt('visite');
})();
