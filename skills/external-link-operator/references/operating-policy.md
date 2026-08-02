# Operating policy

## Standing authorization

- Submit ordinary free directory listings after the selected Profile, fields, media, destination, and preview pass preflight.
- Use the existing Google quick-login session and select `syndredyoung@gmail.com` when the requested destination offers that already-authorized account.
- Download public website assets or use files from the matching local project `public` directory, normalize them, upload them, and verify the page preview.
- Update the Google handoff sheet, plugin library, exported ledger, workbook, and progress documentation after verified outcomes.

## Action-time gates

Park the destination, preserve its tab, release the queue slot, and continue other destinations when possible.

- Ask at action time before solving or completing a CAPTCHA, including an explicit Cloudflare Turnstile or “Verify you are human” challenge.
- Pause for OTP, email verification, a missing password, or an unexpected login destination.
- Ask before granting new OAuth scopes, persistent permissions, or other expanded access.
- Stop for a paywall, purchase, subscription, paid acceleration, or unexpected recurring charge unless the user separately authorizes the exact transaction and limit.
- Ask before accepting a legally binding agreement or an unexpected material commitment.
- Do not bypass browser security warnings, CAPTCHA systems, paywalls, site prohibitions, or access controls.

Cookie consent, an existing session, and an ordinary already-authorized account chooser are not blockers.

## Preflight gate

Before final submission, verify all of the following:

1. The active Profile ID, brand, domain, contact email, and target destination match the requested pair.
2. The destination is relevant, not already successful, and still offers the expected route.
3. Required text is accurate and does not advertise unfinished capabilities as production-ready.
4. Required checkboxes, radio groups, categories, dates, and length constraints pass.
5. Each file input has a real file; verify type, size, count, and visible preview where available.
6. No hidden paid plan, recurring charge, new permission, or binding declaration was introduced.

## Evidence gate

Accept one or more of:

- explicit success page or success text;
- receipt or confirmation identifier;
- account/dashboard status such as `Submitted`, `Under Review`, or `Pending Review`;
- public listing page;
- explicit user confirmation.

Record the exact text, evidence URL, capture time, and actor. Do not promote `filled`, `clicked`, `no error`, or `submitted_pending_evidence` to permanent success.
