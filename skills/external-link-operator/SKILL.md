---
name: external-link-operator
description: Operate the ExternalLink multi-site submission workflow, including ordinary directory submissions, one-off launches such as Product Hunt, Luna delegation, R2 media resolution, success-evidence validation, and synchronization of the Neon-backed Cloudflare data center with the Chrome runtime and submission ledger. Use when asked to submit, continue, audit, reconcile, or report external-link listings for any managed website.
---

# External Link Operator

Operate the ExternalLink workflow from `/Users/syndred/Desktop/projects/ExternalLink`. Treat the procedure as persistent policy and the repository/extension data as current facts.

## Load context

1. Read `PROJECT_CONTEXT.md`, `git status --short`, and the connected Cloud data center status. Use a handoff JSON only for first-install recovery or disaster-backup inspection.
2. Read [references/operating-policy.md](references/operating-policy.md) before any live submission.
3. Read [references/data-model.md](references/data-model.md) before changing records or reconciling the cloud snapshot.
4. Read [references/media-resolution.md](references/media-resolution.md) when a form requests a logo, featured image, screenshot, or other upload.
5. Preserve unrelated working-tree changes and use focused commits.

## Choose tools

Use purpose-built access first:

1. Use the ExternalLink Cloudflare Worker for canonical Neon state and R2 media. The connected workspace is the only human-maintained source.
2. Use the ExternalLink extension for queue construction, standard field mapping, media normalization, runtime cache, and immediate cloud persistence.
3. Use Computer Use for live pages, login selectors, custom widgets, unsupported sites, and authoritative result checks.
4. Delegate bounded preparation and audit work to the configured `luna_worker`; never let two agents control the same browser or tab concurrently.

## Run the workflow

1. Select one or more stable Profile IDs and requested destinations from the latest cloud snapshot.
2. Pull the connected cloud workspace before building a queue when another device may have changed it. The extension writes local edits back automatically.
3. Reconcile the runtime ledger with the cloud `submissionRecords` document before building a queue:

   ```bash
   node skills/external-link-operator/scripts/audit-state.mjs --profile RainbowPetAI
   ```

4. Delegate candidate research, field mapping, copy adaptation, media preflight, and reconciliation diffs to Luna when independently bounded.
5. Resolve media without asking the user to maintain a duplicate media folder:

   ```bash
   node skills/external-link-operator/scripts/discover-media.mjs --profile RainbowPetAI
   ```

6. Open one destination at a time. Verify the current brand/Profile before typing.
7. Fill all safe fields, prepare/upload media, and verify required fields, lengths, categories, URLs, and visible media previews.
8. Submit an ordinary free listing after the complete preflight passes. Apply the action-time gates in the operating policy.
9. Capture authoritative evidence. A filled form, lack of errors, timer, or button click is not success.
10. Record success using the exact destination/Profile pair in the extension ledger. The changed ledger and timeline are saved to the cloud workspace automatically. The deterministic handoff recorder below is for first-install migration or disaster-backup repair only, not the normal sync path:

   ```bash
   node skills/external-link-operator/scripts/record-success.mjs \
     --profile RainbowPetAI \
     --destination-url https://example.com/submit \
     --submitted-at 2026-08-02 \
     --confirmed-by agent \
     --evidence "Submitted for Review" \
     --write
   ```

11. Confirm the cloud write succeeds; do not rewrite `Table.xlsx`, `extension/table-library.json`, handoff JSON, or a workbook after every submission. Those artifacts are for first-install seeding, migration, or disaster backup only. Set `IndexPage` only after a public listing resolves.
12. Re-run the audit and task-specific tests. Report submitted, under review, published, parked, paid, skipped, and unconfirmed outcomes separately.

## Enforce success integrity

- Use `destinationKey + profileId` as the permanent success key.
- Treat the connected Neon workspace as the only human-maintained source for profiles, destinations, manual site classifications, and timeline notes. `chrome.storage.local` is an offline runtime cache, not a second manual source.
- Treat `submissionRecords` as the permanent success ledger. A verified success is written locally and persisted to the cloud; the extension shows its exact `publicationStatus` separately.
- `Table.xlsx`, `extension/table-library.json`, and exported/交接 JSON are first-install seeds or disaster backups; they are not required to be edited on every synchronization.
- Ignore the legacy imported `Link Submit.Submit` field as permanent success truth. It is historical site-level metadata and cannot prove a `destinationKey::profileId` success; use explicit `submissionRecords` evidence instead.
- Canonicalize known aliases with `references/destination-aliases.json` so a root URL and `/submit` do not double count one platform.
- Preserve stronger existing evidence; never overwrite an existing success merely because a seed row says `submitted`.
- Record `confirmedBy: agent` only from visible success evidence and `confirmedBy: manual` only from an explicit user confirmation.
- Keep `submitted`, `under_review`, and `published` distinct in human-facing reports even when the runtime success ledger uses `status: success` to mean the submission itself succeeded.
- Keep `paid`, `broken`, `skip`, and `deleted` as destination-level permanent gates; keep `needs_login`, `needs_captcha`, `needs_otp`, and `needs_manual` as recoverable human gates. A single profile failure must not mark the whole destination broken.

## Handle special launches

Treat Product Hunt and similar high-value launches as custom destinations. Let Luna prepare copy, categories, assets, and a field map; let the main agent inspect the live form and execute sequentially. Reuse automatically discovered assets for drafts, but allow optional user-provided overrides for launch-specific creative.

Community platforms may distinguish a logged-in account from a post-enabled account. Record a verified account restriction as `needs_manual` and do not buy paid access or manufacture engagement to bypass it.

## Finish

- Update `PROJECT_CONTEXT.md`, `docs/进度.md`, and the dated progress/report note when workflow state changes; do not treat those notes or backup artifacts as a replacement for the cloud workspace.
- Validate the Skill with the bundled Skill validator after editing it.
- Forward-test material Skill revisions with a fresh Luna task that receives the Skill path and a realistic read-only prompt.
- Do not claim live behavior from static tests alone.
