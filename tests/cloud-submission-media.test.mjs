import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("extension/background.js", "utf8");
const start = source.indexOf("async function preferCloudSubmissionMedia(");
const end = source.indexOf("// ─── AI comment drafts", start);
assert.ok(start >= 0 && end > start);
let calls = 0;
const context = {
  self: { ExtLinkProfiles: { canonicalProfileId: (value) => ({
    GraffitiName: "GraffitiName", JevPlay: "JevPlay",
  })[value] || "" } },
  listCloudSubmissionMedia: async () => {
    calls++;
    return { assets: [
      { profile_id: "GraffitiName", media_kind: "screenshot", media_index: 2, asset_id: "graffiti-2", content_type: "image/png" },
      { profile_id: "GraffitiName", media_kind: "screenshot", media_index: 1, asset_id: "graffiti-1", content_type: "image/png" },
      { profile_id: "GraffitiName", media_kind: "logo", asset_id: "graffiti-logo", content_type: "image/png" },
      { profile_id: "JevPlay", media_kind: "screenshot", media_index: 1, asset_id: "jev-1", content_type: "image/png" },
    ] };
  },
  log: () => {},
  setTimeout,
  clearTimeout,
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const config = {
  projectKey: "GraffitiName",
  screenshots: ["https://example.com/graffiti-examples/throw-up.png"],
  projectFields: { LOGO: "https://graffitinameai.com/logo.png" },
};
await context.preferCloudSubmissionMedia(config);
assert.deepEqual(Array.from(config.screenshots), ["cloud-media://graffiti-1", "cloud-media://graffiti-2"]);
assert.equal(config.projectFields["Cloud LOGO"], "cloud-media://graffiti-logo");
assert.equal(config.projectFields.LOGO, "https://graffitinameai.com/logo.png", "public logo URL remains available for URL fields");
await context.preferCloudSubmissionMedia(config);
assert.equal(calls, 1, "one fill session reads the manifest once");
await context.preferCloudSubmissionMedia({ projectKey: "unknown" });
assert.equal(calls, 1, "an unknown profile must never receive another profile's media");
