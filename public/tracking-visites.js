// public/tracking-visites.js
//
// À inclure sur chaque page du tunnel Skyeco Ads (juste avant </body>) :
//   <script src="/tracking-visites.js"></script>
//
// - Récupère "pid" dans l'URL (transmis par api/lien.js depuis le clic
//   email) OU le reprend de sessionStorage si déjà présent (pour qu'il
//   suive le visiteur d'une page à l'autre du tunnel, même une fois "pid"
//   disparu de l'URL).
// - session_id : un identifiant par visite (sessionStorage), pour
//   regrouper les pages vues même sans pid (trafic anonyme/organique).
// - Envoie l'entrée sur la page au chargement, puis la durée passée
//   quand le visiteur quitte la page ou change d'onglet.
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    var pidUrl = params.get('pid');
    if (pidUrl) sessionStorage.setItem('skyeco_pid', pidUrl);
    var pid = sessionStorage.getItem('skyeco_pid') || null;

    var sessionId = sessionStorage.getItem('skyeco_session_id');
    if (!sessionId) {
      sessionId = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('skyeco_session_id', sessionId);
    }

    var entree = Date.now();
    var visiteId = null;
    var envoye = false;

    fetch('/api/tracker-visite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'entree',
        sessionId: sessionId,
        pid: pid,
        page: window.location.pathname.replace(/^\//, '') || 'index.html',
        referrer: document.referrer || null,
      }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.id) visiteId = data.id;
    }).catch(function () {});

    function envoyerSortie() {
      if (envoye || !visiteId) return;
      envoye = true;
      var dureeSecondes = Math.round((Date.now() - entree) / 1000);
      var payload = JSON.stringify({ action: 'sortie', id: visiteId, dureeSecondes: dureeSecondes });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/tracker-visite', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/tracker-visite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
      }
    }

    // 02/10/2026 : événements ponctuels (ex : essai gratuit démarré, écran
    // de paiement ouvert). Une page peut appeler, même AVANT que ce script
    // soit chargé :
    //   (window.skyecoEvenements = window.skyecoEvenements || []).push('essai_demarre');
    // Chaque événement est enregistré dans visites_tunnel comme une "page"
    // nommée "evenement:<nom>", avec le même session_id et pid que la visite,
    // ce qui le fait apparaître tel quel dans statistiques-visites.html.
    function envoyerEvenement(nom) {
      try {
        fetch('/api/tracker-visite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            action: 'entree',
            sessionId: sessionId,
            pid: pid,
            page: 'evenement:' + String(nom).slice(0, 60),
            referrer: window.location.pathname,
          }),
        }).catch(function () {});
      } catch (e) {}
    }
    var fileAttente = window.skyecoEvenements || [];
    window.skyecoEvenements = { push: envoyerEvenement };
    for (var i = 0; i < fileAttente.length; i++) envoyerEvenement(fileAttente[i]);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') envoyerSortie();
    });
    window.addEventListener('pagehide', envoyerSortie);
  } catch (e) {
    // Le tracking ne doit jamais empêcher la page de fonctionner.
  }
})();
