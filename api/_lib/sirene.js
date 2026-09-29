// /api/_lib/sirene.js : fiche officielle d'une entreprise (API Recherche d'entreprises, gratuite, data.gouv.fr)
export async function ficheSiret(siret) {
  siret = String(siret || '').replace(/\D/g, '');
  if (!/^\d{14}$/.test(siret)) return null;
  const r = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${siret}&per_page=1`);
  if (!r.ok) return null;
  const e = (await r.json()).results?.[0];
  if (!e) return null;
  const etabs = [e.siege, ...(e.matching_etablissements || [])].filter(Boolean);
  const et = etabs.find((x) => x.siret === siret) || e.siege || {};
  return {
    siret, entreprise: e.nom_complet || e.nom_raison_sociale, actif: (et.etat_administratif || e.etat_administratif) === 'A',
    adresse: et.adresse || '', code_postal: et.code_postal || '', departement: et.departement || String(et.code_postal || '').slice(0, 2),
    code_ape: String(et.activite_principale || e.activite_principale || '').replace('.', ''),
  };
}
