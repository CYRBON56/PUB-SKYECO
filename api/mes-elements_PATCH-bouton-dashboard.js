// Patch pour mes-elements.html — chercher ce bloc exact (dans chargerDraftExistant()) :
//
//   draftStatutActuel = draft.status || null;
//   compteDejaExistant = !!draft.dashboard_password_hash;
//
//   // Le bouton est toujours affiché : on n'arrive sur cette page qu'avec
//   // un id de brouillon réel, soit via "Modifier mes éléments" depuis un
//   // tableau de bord déjà existant, soit via un premier passage — dans
//   // les deux cas un lien direct est plus utile qu'un bouton caché à
//   // cause d'un statut imprévu (ex : resté "preview" après un essai
//   // interrompu avant correction de la contrainte Supabase).
//   const lienRetour = document.getElementById('lienRetourDashboard');
//   lienRetour.href = '/mon-dashboard.html?id=' + draftId;
//   lienRetour.style.display = 'flex';
//
// Le remplacer par le bloc ci-dessous.

draftStatutActuel = draft.status || null;

// 07/09/2026 : dashboard_password_hash n'est plus lisible en clé anonyme
// (verrouillage des colonnes sensibles du 06/09) — cette lecture directe
// renvoyait donc toujours "undefined", compteDejaExistant restait toujours
// false, et le bouton ci-dessous pointait TOUJOURS vers /mon-dashboard.html
// (page protégée par mot de passe) même quand aucun compte n'existe encore
// — l'artisan tombait sur un mur de connexion sans pouvoir y accéder. On
// vérifie donc désormais via /api/acces-dashboard-etat (service role),
// comme le fait déjà mon-dashboard-demo.html, et on adapte le lien en
// conséquence pour permettre une vraie navigation libre entre éléments et
// dashboard tant qu'aucun compte n'a été créé.
try {
  const respEtat = await fetch('/api/acces-dashboard-etat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftId })
  });
  const etat = await respEtat.json();
  compteDejaExistant = !!(etat.success && etat.aDejaMotDePasse);
} catch (e) {
  compteDejaExistant = false;
}

// Le bouton est toujours affiché : on n'arrive sur cette page qu'avec
// un id de brouillon réel, soit via "Modifier mes éléments" depuis un
// tableau de bord déjà existant, soit via un premier passage — dans
// les deux cas un lien direct est plus utile qu'un bouton caché à
// cause d'un statut imprévu (ex : resté "preview" après un essai
// interrompu avant correction de la contrainte Supabase).
const lienRetour = document.getElementById('lienRetourDashboard');
lienRetour.href = compteDejaExistant
  ? '/mon-dashboard.html?id=' + draftId
  : '/mon-dashboard-demo.html?id=' + draftId;
lienRetour.style.display = 'flex';
