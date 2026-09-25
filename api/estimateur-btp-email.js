// /api/_lib/estimateur-btp-email.js
// Bloc HTML "comment ça marche" partagé par les emails qui présentent
// l'Estimateur BTP :
//   - api/stripe-webhook.js (email de livraison du Kit Pro Artisan BTP, qui
//     inclut l'appli en bonus ; et email de confirmation d'achat de
//     l'Estimateur BTP après un paiement Stripe réussi)
//   - api/estimateur-btp-essai.js (email envoyé aux acheteurs du Kit Pro
//     Artisan BTP au moment où leur accès bonus à l'Estimateur BTP est activé)
// Centralisé ici pour ne pas dupliquer le texte et les images dans plusieurs
// fichiers (25/09/2026 — avant cette date, le lien de l'appli était envoyé
// nu, sans explication du fonctionnement du catalogue de prix).

// Trois captures d'écran réelles de l'appli, hébergées en statique dans
// /public/images/estimateur-btp/.
const ESTIMATEUR_IMG_BASE = 'https://www.skyeco.fr/images/estimateur-btp';

export function blocCommentCaMarcheEstimateur() {
  return `
    <div style="margin-top:20px;">
      <p style="margin:0 0 14px; font-weight:bold; color:#1F3A5F; font-size:15px;">Comment ça marche : le prix est déjà dans le catalogue</p>

      <p style="margin:0 0 6px; font-weight:bold; color:#1F3A5F;">1. Tapez (ou dictez) ce que vous cherchez</p>
      <p style="margin:0 0 10px; font-size:13.5px; color:#444;">Pas besoin d'être précis — "résine", "portail", "fosse septique"… le prix de chaque poste s'affiche déjà, à partir des tarifs BTP du marché (ou de vos propres tarifs, une fois modifiés).</p>
      <img src="${ESTIMATEUR_IMG_BASE}/1-recherche-prix-preintegre.jpg" width="460" alt="Recherche d'un poste avec prix déjà affiché" style="width:100%; max-width:460px; border-radius:10px; border:1px solid #e5e5e5; display:block; margin:0 0 20px;">

      <p style="margin:0 0 6px; font-weight:bold; color:#1F3A5F;">2. Indiquez les dimensions (ou la quantité)</p>
      <p style="margin:0 0 10px; font-size:13.5px; color:#444;">Longueur × largeur, ou juste une quantité selon le poste — la surface (ou le volume) et le prix se calculent tout seuls. Vous pouvez ajuster le prix unitaire à tout moment, il n'est jamais figé.</p>
      <img src="${ESTIMATEUR_IMG_BASE}/2-fiche-produit-prix-modifiable.jpg" width="460" alt="Fiche produit avec calcul automatique et prix modifiable" style="width:100%; max-width:460px; border-radius:10px; border:1px solid #e5e5e5; display:block; margin:0 0 20px;">

      <p style="margin:0 0 6px; font-weight:bold; color:#1F3A5F;">3. Le devis se remplit tout seul, avec le total en direct</p>
      <p style="margin:0 0 10px; font-size:13.5px; color:#444;">Chaque poste ajouté apparaît dans le devis avec son total, TVA comprise — vous n'avez plus qu'à ajouter les postes du chantier les uns après les autres.</p>
      <img src="${ESTIMATEUR_IMG_BASE}/3-devis-qui-se-remplit.jpg" width="460" alt="Devis qui se remplit avec total en direct" style="width:100%; max-width:460px; border-radius:10px; border:1px solid #e5e5e5; display:block; margin:0 0 4px;">

      <p style="margin:16px 0 0; font-size:13px; color:#666;">Une fois un prix modifié, l'appli s'en souvient — sur ce téléphone comme sur votre ordinateur, avec le même email.</p>
    </div>`;
}
