# Automatic media resolution

Do not require a manually maintained duplicate media folder or image host. Treat each managed project's source `public` directory and deployed public URLs as the source library.

## Resolution order

1. Use explicit Profile fields: `LOGO`, `Featured image`, and `Screenshot 1–4`.
2. Map deployed URL paths back to files under the configured local project `public` directory.
3. Inspect source metadata and standard assets such as `logo`, `brand-icon`, `logo-mark`, `og-preview`, `opengraph`, `preview`, and product hero files.
4. Exclude payment-provider icons, framework logos, avatars, template/demo assets, admin screenshots, and unrelated generated media unless the Profile explicitly points to them.
5. Capture a current browser screenshot of an appropriate public page if no suitable product screenshot exists.
6. Ask for an override only when the candidates are ambiguous, missing, low quality, or a high-value launch needs purpose-built creative.

Run:

```bash
node skills/external-link-operator/scripts/discover-media.mjs --profile RainbowPetAI
```

The script returns ranked sources; it does not claim they were uploaded.

## Upload preparation

- Use the existing source file directly when the destination accepts its type and size.
- Otherwise use the extension's media normalization or an automatically created temporary/cache copy.
- Never require the user to name or maintain the cache. It may be regenerated.
- For URL fields, prefer a stable deployed URL on the user's own domain. Do not introduce a separate image host unless the destination explicitly requires a public URL and no stable URL exists.

## Verification

After setting a file input, verify `files.length`, MIME type, file size, upload completion, and the page's visible preview where available. A URL, filename, cached artifact, or script result is not upload success.
