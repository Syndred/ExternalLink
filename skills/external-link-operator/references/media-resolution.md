# Automatic media resolution

Do not require a manually maintained duplicate media folder or image host. The connected cloud workspace's R2 media catalogue is the normal source at submission time. Local project `public` folders are only first-migration or replacement candidates.

## Resolution order

1. Resolve `cloud-media://asset-id` Profile references from the authenticated Worker and use the returned R2 object.
2. For a missing or replacement reference, use explicit Profile fields: `LOGO`, `Featured image`, and `Screenshot 1–4`.
3. Map deployed URL paths back to files under the configured local project `public` directory.
4. Inspect source metadata and standard assets such as `logo`, `brand-icon`, `logo-mark`, `og-preview`, `opengraph`, `preview`, and product hero files.
5. Exclude payment-provider icons, framework logos, avatars, template/demo assets, admin screenshots, and unrelated generated media unless the Profile explicitly points to them.
6. Capture a current browser screenshot of an appropriate public page if no suitable product screenshot exists.
7. Ask for an override only when the candidates are ambiguous, missing, low quality, or a high-value launch needs purpose-built creative.

Run:

```bash
node skills/external-link-operator/scripts/discover-media.mjs --profile RainbowPetAI
```

The script returns ranked migration sources; it does not claim they were uploaded. Upload the chosen source through the Worker and verify the returned R2 asset reference.

## Upload preparation

- Use the private R2 asset directly when the destination accepts its type and size.
- Otherwise use the extension's media normalization or an automatically created temporary/cache copy.
- Never require the user to name or maintain the cloud media cache. It may be regenerated from the source project when needed.
- For URL fields, prefer a stable deployed URL on the user's own domain. Do not introduce a separate image host unless the destination explicitly requires a public URL and no stable URL exists.

## Verification

After setting a file input, verify `files.length`, MIME type, file size, upload completion, and the page's visible preview where available. A URL, filename, cached artifact, or script result is not upload success.
