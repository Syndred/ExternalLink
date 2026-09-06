# Data model and synchronization

## Fixed locations and source priority

- Project root: `/Users/syndred/Desktop/projects/ExternalLink`
- Canonical data center: Neon PostgreSQL through `externallink-cloud` Cloudflare Worker; the `default` workspace is the sole human-maintained source.
- Private media store: Cloudflare R2 bucket `externallink-media`, accessed only through the Worker.
- Chrome runtime cache/local persistence: `chrome.storage.local` (offline cache, not a competing source)
- First-install seed only: `extension/table-library.json` (and any imported `Table.xlsx`)
- Disaster-backup/export only: `data/submission-handoff-2026-08-02.json`
- Human-readable backup artifact only: `outputs/external-link-handoff-2026-08-02/外链提交交接表.xlsx`
- Progress/report note: `docs/外链提交报告-2026-08-02.md`

The connected Neon workspace is the only place a human should maintain profile facts, the destination list, manual destination classifications, records, and timeline notes. The extension mirrors this into `chrome.storage.local` as offline runtime state, not a second manual source. Seeds, workbooks, and handoff JSON are used only for first installation, migration, or disaster recovery and do not need to be edited after every submission.

## Ownership by data type

- `siteProfiles`: stable managed-website facts and Profile IDs in the cloud workspace.
- `sheetTableData`: imported all-field library rows: canonical destination URLs, selected Profile IDs, notes, and optional classification fields. The name remains for backwards-compatible migration only.
- `submissionRecords`: permanent submission-success ledger, keyed by `destinationKey::profileId`, persisted immediately to the workspace.
- `submissionTimeline`: append-only human-facing events, persisted with an audit revision for creation, editing, and deletion.
- `siteAnnotations`: destination-level paid, broken, skipped, deleted, login, CAPTCHA, and manual gates.
- `activeBatchRun` and queue cursors: resumable runtime state.
- `Table.xlsx`, `table-library.json`, and handoff JSON: first-install/migration seeds or disaster backups; never sufficient evidence by themselves and not a per-submission maintenance target.

## Status vocabulary

Use `queued`, `ready`, `filling`, `filled`, `needs_login`, `needs_captcha`, `needs_otp`, `needs_manual`, `submitted`, `under_review`, `published`, `rejected`, `failed`, `paid`, `skip`, or `blocked` in operational reports. The v2 runtime ledger uses `status: success` when the submission itself has authoritative success evidence. Store the precise review/publication state in `publicationStatus`: `submitted`, `pending_moderation`, or `published`. Do not treat a click or a casual confirm as `published`.

## Reconciliation order

1. Pull the latest snapshot from the connected cloud workspace before a multi-device reconciliation.
2. Apply it to `chrome.storage.local` while preserving only unsaved local work; resolve a revision conflict by pulling before editing again.
3. Load runtime `submissionRecords` without deleting existing successes. Canonicalize destination aliases before comparing keys.
4. Treat the legacy imported `Link Submit.Submit` field as historical metadata only. It is a site-level flag and cannot seed permanent success for every current or newly added Profile.
5. Add a missing success only when the exact success evidence or explicit manual confirmation exists. Keep the exact `destinationKey::profileId` pair.
6. Persist changed state to the Worker with its current revision. Never downgrade stronger evidence with a migration seed or weak historical field.
7. Use `Table.xlsx`, `table-library.json`, handoff JSON, and workbooks only when installing, migrating, backing up, or recovering; do not require a second copy to be updated after each normal sync.
8. Re-run `audit-state.mjs`; require no missing verified pair and no duplicate canonical destination for the selected Profile.

## Migration snapshot and media

The first migration preserves all legacy `Link Submit` fields (`Link`, `SubmitProject`, `Submit`, `Time`, `Record`, `Detail`, optional quality/status fields) inside `sheetTableData`, every Profile Field / Content / Notes entry inside `siteProfiles`, and the exact per-Profile evidence ledger in `submissionRecords`.

The imported `Submit` flag is not permanent success evidence. Runtime queues use only evidence-backed `submissionRecords` for per-Profile skipping. Logo and screenshots are stored as private R2 objects and referenced as `cloud-media://asset-id`; the extension fetches them through the authenticated Worker at upload time.
