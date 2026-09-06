-- ExternalLink canonical cloud state. Run once against the chosen Neon branch.
-- Profiles, library rows and ledgers remain their complete JSON shapes so the
-- extension can retain every existing spreadsheet field without lossy mapping.

create table if not exists externallink_workspaces (
  workspace_id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists externallink_workspace_documents (
  workspace_id text not null references externallink_workspaces(workspace_id) on delete cascade,
  document_key text not null,
  data jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, document_key)
);

create table if not exists externallink_timeline_revisions (
  revision_id bigserial primary key,
  workspace_id text not null references externallink_workspaces(workspace_id) on delete cascade,
  event_id text not null,
  operation text not null check (operation in ('created', 'updated', 'deleted')),
  event jsonb not null,
  changed_at timestamptz not null default now()
);

create index if not exists externallink_timeline_revisions_event_idx
  on externallink_timeline_revisions (workspace_id, event_id, changed_at desc);

create table if not exists externallink_media_assets (
  workspace_id text not null references externallink_workspaces(workspace_id) on delete cascade,
  asset_id text not null,
  profile_id text not null,
  media_kind text not null check (media_kind in ('logo', 'screenshot', 'featured')),
  media_index smallint,
  object_key text not null,
  file_name text not null,
  content_type text not null,
  byte_length bigint not null,
  sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, asset_id),
  unique (workspace_id, object_key)
);

create index if not exists externallink_media_assets_profile_idx
  on externallink_media_assets (workspace_id, profile_id, media_kind, media_index);
