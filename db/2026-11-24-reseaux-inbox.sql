-- Boîte « Réponses réseaux » (24/11/2026)
create table if not exists public.reseaux_inbox (
  id bigserial primary key,
  draft_id text,
  compte_id text,
  nom_page text,
  plateforme text not null,            -- facebook | instagram | tiktok
  type text not null,                  -- commentaire | message
  objet_id text not null,              -- id du commentaire ou du message
  publication_id text,
  auteur_id text,
  auteur text,
  texte text,
  reponse_proposee text,
  reponse_envoyee text,
  statut text default 'à répondre',    -- à répondre | répondu | ignoré | ignoré (spam)
  erreur text,
  recu_le timestamptz default now(),
  repondu_le timestamptz,
  cree_le timestamptz default now(),
  unique (plateforme, objet_id)
);
create index if not exists reseaux_inbox_draft on public.reseaux_inbox (draft_id, recu_le desc);
alter table public.reseaux_inbox enable row level security;   -- accès uniquement via les API (clé service)
alter table public.skyeco_pro_social_connections add column if not exists inbox_abonne boolean default false;
alter table public.skyeco_pro_social_connections add column if not exists tiktok_biz_token text, add column if not exists tiktok_business_id text;
