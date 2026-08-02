---
name: external-link-operator
description: Operate the ExternalLink multi-site submission workflow, including ordinary directory submissions, one-off launches such as Product Hunt, Luna delegation, automatic media discovery from local project public folders, success-evidence validation, and synchronization of the Google handoff sheet, plugin library, and submission ledger. Use when asked to submit, continue, audit, reconcile, or report external-link listings for any managed website.
---

# External Link Operator

Operate the ExternalLink workflow from `/Users/syndred/Desktop/projects/ExternalLink`. Treat the procedure as persistent policy and the repository/extension data as current facts.

## Load context

1. Read `PROJECT_CONTEXT.md`, `git status --short`, and the current handoff JSON.
2. Read [references/operating-policy.md](references/operating-policy.md) before any live submission.
3. Read [references/data-model.md](references/data-model.md) before changing records or reconciling the Google Sheet.
4. Read [references/media-resolution.md](references/media-resolution.md) when a form requests a logo, featured image, screenshot, or other upload.
5. Preserve unrelated working-tree changes and use focused commits.

## Choose tools

Use purpose-built access first:

1. Use the Google Sheets/Drive connector for structured sheet reads and writes when connected.
2. Use the ExternalLink extension for queue construction, standard field mapping, media normalization, and its runtime ledger.
3. Use Computer Use for live pages, login selectors, custom widgets, unsupported sites, and authoritative result checks.
4. Delegate bounded preparation and audit work to the configured `luna_worker`; never let two agents control the same browser or tab concurrently.

## Run the workflow

1. Select one or more stable Profile IDs and requested destinations.
2. Reconcile the runtime/exported ledger and the plugin library before building a queue:

   ```bash
   node skills/external-link-operator/scripts/audit-state.mjs --profile RainbowPetAI
   ```

3. Delegate candidate research, field mapping, copy adaptation, media preflight, and reconciliation diffs to Luna when independently bounded.
4. Resolve media without asking the user to maintain a duplicate media folder:

   ```bash
   node skills/external-link-operator/scripts/discover-media.mjs --profile RainbowPetAI
   ```

5. Open one destination at a time. Verify the current brand/Profile before typing.
6. Fill all safe fields, prepare/upload media, and verify required fields, lengths, categories, URLs, and visible media previews.
7. Submit an ordinary free listing after the complete preflight passes. Apply the action-time gates in the operating policy.
8. Capture authoritative evidence. A filled form, lack of errors, timer, or button click is not success.
9. Record success using the exact destination/Profile pair. Prefer the extension ledger; for handoff JSON use the deterministic recorder:

   ```bash
   node skills/external-link-operator/scripts/record-success.mjs \
     --profile RainbowPetAI \
     --destination-url https://example.com/submit \
     --submitted-at 2026-08-02 \
     --confirmed-by agent \
     --evidence "Submitted for Review" \
     --write
   ```

10. Synchronize the human-readable Google Sheet, `extension/table-library.json`, exported handoff JSON, workbook, report, and project progress. Set `IndexPage` only after a public listing resolves.
11. Re-run the audit and task-specific tests. Report submitted, under review, published, parked, paid, skipped, and unconfirmed outcomes separately.

## Enforce success integrity

- Use `destinationKey + profileId` as the permanent success key.
- Canonicalize known aliases with `references/destination-aliases.json` so a root URL and `/submit` do not double count one platform.
- Preserve stronger existing evidence; never overwrite an existing success merely because a seed row says `submitted`.
- Record `confirmedBy: agent` only from visible success evidence and `confirmedBy: manual` only from an explicit user confirmation.
- Keep `submitted`, `under_review`, and `published` distinct in human-facing reports even when the runtime success ledger uses `status: success` to mean the submission itself succeeded.

## Handle special launches

Treat Product Hunt and similar high-value launches as custom destinations. Let Luna prepare copy, categories, assets, and a field map; let the main agent inspect the live form and execute sequentially. Reuse automatically discovered assets for drafts, but allow optional user-provided overrides for launch-specific creative.

## Finish

- Update `PROJECT_CONTEXT.md`, `docs/进度.md`, and the dated handoff report when state changes.
- Validate the Skill with the bundled Skill validator after editing it.
- Forward-test material Skill revisions with a fresh Luna task that receives the Skill path and a realistic read-only prompt.
- Do not claim live behavior from static tests alone.
