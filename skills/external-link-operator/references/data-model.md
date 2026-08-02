# Data model and synchronization

## Fixed locations

- Project root: `/Users/syndred/Desktop/projects/ExternalLink`
- Google Sheet: `https://docs.google.com/spreadsheets/d/17xqgpPDGQZozG9mBMOLRjnqy2LPiZJ6xkoYaC-HuoD0/edit?gid=2123519382#gid=2123519382`
- Plugin seed/library: `extension/table-library.json`
- Runtime truth: Chrome `chrome.storage.local`
- Portable runtime backup: `data/submission-handoff-2026-08-02.json`
- Human workbook: `outputs/external-link-handoff-2026-08-02/外链提交交接表.xlsx`
- Daily report: `docs/外链提交报告-2026-08-02.md`

## Ownership by data type

- `siteProfiles`: stable managed-website facts and Profile IDs.
- `submissionRecords`: permanent submission-success ledger, keyed by `destinationKey::profileId`.
- `siteAnnotations`: destination-level paid, broken, skipped, deleted, login, CAPTCHA, and manual gates.
- `activeBatchRun`: resumable runtime state only.
- `Table.xlsx` and `table-library.json`: profile/destination seed and human-readable status, never sufficient evidence by themselves.

## Status vocabulary

Use `queued`, `ready`, `filling`, `filled`, `needs_login`, `needs_captcha`, `needs_otp`, `needs_manual`, `submitted`, `under_review`, `published`, `rejected`, `failed`, `paid`, `skip`, or `blocked` in operational reports. The v2 runtime ledger uses `status: success` when the submission itself has authoritative success evidence; retain the more precise review/publication state in evidence and human-facing fields.

## Reconciliation order

1. Load runtime/exported `submissionRecords` without deleting existing successes.
2. Canonicalize destination aliases before comparing keys.
3. Compare the selected Profile against submitted seed rows and human reports.
4. Treat differences as an audit finding, not automatic proof.
5. Add a missing success only when the exact evidence is available.
6. Update the plugin library, Google Sheet, workbook, report, and progress docs from that verified result.
7. Re-run `audit-state.mjs`; require no missing verified pair and no duplicate canonical destination for the selected Profile.

## Google Sheet layout

Keep all information in the existing workbook rather than creating another spreadsheet:

- destination/library view: one canonical platform per row;
- website profile view: one stable Profile per row or section;
- submission records: one destination/Profile pair per row with status, date, evidence, and public page.

Use explicit image URLs or Drive file IDs if the sheet stores media references. Do not rely only on an in-cell rendered image.
