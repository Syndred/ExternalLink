# Data model and synchronization

## Fixed locations and source priority

- Project root: `/Users/syndred/Desktop/projects/ExternalLink`
- 私有 Google Sheet（唯一人工维护源）: `https://docs.google.com/spreadsheets/d/17xqgpPDGQZozG9mBMOLRjnqy2LPiZJ6xkoYaC-HuoD0/edit?gid=2123519382#gid=2123519382`
- Chrome runtime cache/local persistence: `chrome.storage.local`
- First-install seed only: `extension/table-library.json` (and any imported `Table.xlsx`)
- Disaster-backup/export only: `data/submission-handoff-2026-08-02.json`
- Human-readable backup artifact only: `outputs/external-link-handoff-2026-08-02/外链提交交接表.xlsx`
- Progress/report note: `docs/外链提交报告-2026-08-02.md`

The private Google Sheet is the only place a human should maintain profile facts, the destination list, and manual destination classifications. The extension pulls a reviewed snapshot into `chrome.storage.local`; that storage is runtime state and a local cache, not a second manually edited source. Seeds, workbooks, and handoff JSON are used for first installation, migration, or disaster recovery and do not need to be edited after every submission.

## Ownership by data type

- Google Sheet profile tabs / `siteProfiles`: stable managed-website facts and Profile IDs; the Sheet is the human-maintained authority.
- Google Sheet `Link Submit` / runtime destination entries: canonical destination URLs, selected Profile IDs, notes, and optional classification fields.
- `submissionRecords`: permanent submission-success ledger, keyed by `destinationKey::profileId`. A verified local success is queued in the outbox and only becomes synchronized after the Sheet `Submission Records` write is acknowledged.
- `siteAnnotations`: destination-level paid, broken, skipped, deleted, login, CAPTCHA, and manual gates. A Sheet `Status`/`CategoryStatus` value is authoritative when present; runtime auto-classifications remain cache state until deliberately reconciled.
- `activeBatchRun`, queue cursors, and outbox: resumable runtime state only.
- `Table.xlsx`, `table-library.json`, and handoff JSON: first-install/migration seeds or disaster backups; never sufficient evidence by themselves and not a per-submission maintenance target.

## Status vocabulary

Use `queued`, `ready`, `filling`, `filled`, `needs_login`, `needs_captcha`, `needs_otp`, `needs_manual`, `submitted`, `under_review`, `published`, `rejected`, `failed`, `paid`, `skip`, or `blocked` in operational reports. The v2 runtime ledger uses `status: success` when the submission itself has authoritative success evidence; retain the more precise review/publication state in evidence and human-facing fields.

## Reconciliation order

1. Pull the latest snapshot from the configured private Google Sheet and verify the spreadsheet allowlist before reading or writing.
2. Preview profile, destination, and annotation changes; apply approved changes to `chrome.storage.local` while preserving local media, learned mappings, and stronger local success evidence.
3. Load runtime `submissionRecords` and its outbox without deleting existing successes. Canonicalize destination aliases before comparing keys.
4. Treat the legacy `Link Submit.Submit` column as historical metadata only. It is a site-level flag and cannot seed permanent success for every current or newly added Profile.
5. Add a missing success only when the exact success evidence or explicit manual confirmation exists. Keep the exact `destinationKey::profileId` pair.
6. Push verified outbox records to the Sheet `Submission Records` tab; clear only keys the Sheet write acknowledges. Never downgrade a stronger record with a seed row or weak evidence.
7. Use `Table.xlsx`, `table-library.json`, handoff JSON, and workbooks only when installing, migrating, backing up, or recovering; do not require a second copy to be updated after each normal sync.
8. Re-run `audit-state.mjs`; require no missing verified pair and no duplicate canonical destination for the selected Profile.

## Google Sheet layout

Keep the editable source in the existing private workbook rather than creating another spreadsheet:

- `Link Submit`: one canonical destination per row, selected Profile IDs, notes, optional `Status`/`CategoryStatus`, and `IndexPage` only after a public listing resolves;
- website profile tabs: one stable Profile ID per tab/section with the source copy and media references;
- `Submission Records`: one destination/Profile pair per row with `success` status, date, evidence, confirmation actor, and public page. This tab is the success-ledger writeback target, not a replacement for exact evidence.

The legacy `Submit` column in `Link Submit` is not a permanent success source. It may be retained for migration/audit context, but runtime queues must leave `submitted: false` and use `Submission Records` for per-Profile skipping.

Use explicit image URLs or Drive file IDs if the sheet stores media references. Do not rely only on an in-cell rendered image.
