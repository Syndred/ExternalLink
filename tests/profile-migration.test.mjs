import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadProfilesModule() {
  const context = {
    self: {},
    console,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync("extension/lib/profiles.js", "utf8"), context);
  return context.self.ExtLinkProfiles;
}

const P = loadProfilesModule();

assert.equal(P.canonicalProfileId("OldPhotoLive AI"), "OldPhotoLive");
assert.equal(P.canonicalProfileId("comparison-text"), "TextComparison");
assert.equal(P.canonicalProfileId("graffiti_name_ai"), "GraffitiName");

const tableProjects = {
  OldPhotoLive: {
    Name: "OldPhotoLive AI",
    Url: "https://oldphotolive.com",
    Pricing: "table pricing",
  },
  TextComparison: {
    Name: "Comparison Text",
    Url: "https://comparison.example",
  },
  GraffitiName: {
    Name: "Graffiti Name AI",
    Url: "https://graffiti.example",
  },
};

const storedProfiles = {
  "oldphotolive-ai": {
    id: "oldphotolive-ai",
    name: "OldPhotoLive AI",
    source: "user",
    url: "https://custom-oldphoto.example",
    fields: {
      Name: "Custom OldPhoto",
      Pricing: "custom pricing",
    },
  },
  OldPhotoLive: {
    id: "OldPhotoLive",
    name: "OldPhotoLive AI",
    source: "table",
    fields: tableProjects.OldPhotoLive,
  },
  "comparison-text": {
    id: "comparison-text",
    name: "Comparison Text",
    source: "user",
    fields: { Name: "Comparison Text" },
  },
  "graffiti-name-ai": {
    id: "graffiti-name-ai",
    name: "Graffiti Name AI",
    source: "user",
    fields: { Name: "Graffiti Name AI" },
  },
  RspAi: {
    id: "RspAi",
    name: "RspAi",
    source: "user",
    fields: { Name: "RspAi" },
  },
};

const stabilized = P.stabilizeTableProfiles(tableProjects, storedProfiles);
assert.equal(stabilized.changed, true);
assert.deepEqual(
  Object.keys(stabilized.profiles).sort(),
  ["GraffitiName", "OldPhotoLive", "RspAi", "TextComparison"].sort(),
);
assert.deepEqual(JSON.parse(JSON.stringify(stabilized.idRemap)), {
  "oldphotolive-ai": "OldPhotoLive",
  "comparison-text": "TextComparison",
  "graffiti-name-ai": "GraffitiName",
});
assert.equal(stabilized.profiles.OldPhotoLive.source, "user");
assert.equal(stabilized.profiles.OldPhotoLive.url, "https://custom-oldphoto.example");
assert.equal(stabilized.profiles.OldPhotoLive.fields.Name, "Custom OldPhoto");
assert.equal(stabilized.profiles.OldPhotoLive.fields.Pricing, "custom pricing");
assert.equal(
  stabilized.profiles.OldPhotoLive.fields.Url,
  "https://oldphotolive.com",
  "Table fields should fill missing values without overwriting user fields",
);

const repeated = P.stabilizeTableProfiles(tableProjects, stabilized.profiles);
assert.equal(repeated.changed, false, "stable profile migration should be idempotent");
assert.deepEqual(JSON.parse(JSON.stringify(repeated.idRemap)), {});

console.log("profile migration tests passed");
