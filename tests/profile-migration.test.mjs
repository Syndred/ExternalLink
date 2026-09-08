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
assert.equal(P.canonicalProfileId("Rainbow Pet AI"), "RainbowPetAI");
assert.equal(P.canonicalProfileId("RainbowPet"), "RainbowPetAI");
assert.equal(P.canonicalProfileId("RSPAI"), "RspAi");

const mediaConfig = {
  logoUrl: "https://example.com/logo.png",
  logoDataUrl: "data:image/png;base64,logo",
  featuredImage: "https://example.com/featured.jpg",
  screenshots: [
    "https://example.com/screen-1.jpg",
    "https://example.com/screen-2.jpg",
  ],
  projectFields: {
    LOGO: "https://example.com/logo.png",
    "Featured image": "https://example.com/featured.jpg",
  },
};
assert.deepEqual(
  JSON.parse(JSON.stringify(P.resolveMediaField(mediaConfig, "Product screenshot 2", 0))),
  {
    value: "https://example.com/screen-2.jpg",
    profileKey: "Screenshot 2",
    useLogoDataUrl: false,
    screenshot: true,
    explicitIndex: true,
    index: 1,
  },
);
assert.equal(
  P.resolveMediaField(mediaConfig, "Gallery image", 1).value,
  "https://example.com/screen-2.jpg",
);
assert.equal(P.resolveMediaField(mediaConfig, "Company logo", 0).useLogoDataUrl, true);
assert.equal(
  P.resolveMediaField(mediaConfig, "Featured image", 0).value,
  "https://example.com/featured.jpg",
);
assert.equal(
  P.resolveMediaField(mediaConfig, "Main Image *", 0).value,
  "https://example.com/featured.jpg",
);

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

const unordered = {
  Zebra: { id: "Zebra", name: "Zebra", sortIndex: 2 },
  Alpha: { id: "Alpha", name: "Alpha", sortIndex: 0 },
  Middle: { id: "Middle", name: "Middle", sortIndex: 1 },
};
assert.equal(P.orderedProfileIds(unordered).join(","), "Alpha,Middle,Zebra");
const reordered = P.applyProfileOrder(unordered, ["Zebra", "Alpha", "Middle"]);
assert.equal(reordered.Zebra.sortIndex, 0);
assert.equal(reordered.Alpha.sortIndex, 1);
assert.equal(reordered.Middle.sortIndex, 2);
assert.equal(P.nextProfileSortIndex(reordered), 3);

assert.equal(P.inferReusableProfileKey("Product URL", ""), "Url");
assert.equal(P.inferReusableProfileKey("Short description", ""), "Short description(20-30 words)");
assert.equal(P.inferReusableProfileKey("CAPTCHA", "Title"), "");
assert.equal(P.inferReusableProfileKey("Discord", "", [], "https://discord.gg/demo"), "Discord");
assert.equal(P.inferReusableProfileKey("Founded year", "", [], "2024"), "Founded year");
assert.equal(P.inferReusableProfileKey("Integration list", "", [], "Slack, Notion"), "Integration list");
assert.equal(P.inferReusableProfileKey("How did you hear about us", "", [], "Google"), "");
assert.equal(P.inferReusableProfileKey("Category", "select", [], "AI Tools"), "");
assert.equal(P.inferReusableProfileKey("I agree to the terms", "", [], "on"), "");
assert.equal(P.isSiteSpecificField("How did you hear about us"), true);

const learned = P.learnProfileFieldsFromFill(
  {
    id: "Demo",
    name: "Demo",
    fields: { Name: "Demo" },
    learnedFieldMappings: { "demo.example": { website: { profileKey: "Url" } } },
  },
  {
    url: { label: "Website", value: "https://demo.example" },
    title: { label: "Title", value: "Demo Tool" },
    name: { label: "Product name", value: "Should not overwrite" },
    captcha: { label: "CAPTCHA", value: "AB12" },
    date: { label: "Launch date", value: "2026-09-08" },
    discord: { label: "Discord", value: "https://discord.gg/demo" },
    founded: { label: "Founded year", value: "2024" },
    integrations: { label: "Integration list", value: "Slack, Notion" },
    hear: { label: "How did you hear about us", value: "Google" },
    category: { label: "Category", profileKey: "category", value: "AI Tools" },
  },
);
assert.equal(learned.profile.fields.Url, "https://demo.example");
assert.equal(learned.profile.fields.Title, "Demo Tool");
assert.equal(learned.profile.fields.Name, "Demo");
assert.equal(learned.profile.fields.Discord, "https://discord.gg/demo");
assert.equal(learned.profile.fields["Founded year"], "2024");
assert.equal(learned.profile.fields["Integration list"], "Slack, Notion");
assert.ok(!learned.profile.fields.CAPTCHA);
assert.ok(!learned.profile.fields.Category);
assert.ok(!learned.profile.fields["How did you hear about us"]);
assert.ok(!learned.added.includes("Name"));
assert.ok(learned.added.includes("Title"));
assert.ok(learned.added.includes("Url"));
assert.ok(learned.added.includes("Discord"));
assert.ok(learned.added.includes("Founded year"));
assert.ok(learned.added.includes("Integration list"));
assert.equal(learned.profile.learnedFieldMappings["demo.example"].website.profileKey, "Url");

{
  const rainbow = {
    id: "RainbowPetAI",
    name: "RainbowPetAI",
    promoUrl: "https://rainbowpetai.com",
    fields: {
      Name: "RainbowPetAI",
      Url: "https://rainbowpetai.com",
      "Long description (250-500 words)": "RainbowPetAI helps remember pets.",
    },
  };
  const video = {
    id: "VideoToArticleAI",
    name: "VideoToArticleAI",
    promoUrl: "https://videotoarticleai.com",
    fields: {
      Name: "VideoToArticleAI",
      Url: "https://videotoarticleai.com",
      "Long description (250-500 words)": "VideoToArticleAI turns video into articles.",
    },
  };
  const leakedGlobal = P.buildAgentConfigFromProfile(video, {
    commentTemplate: "RainbowPetAI leftover copy",
    brandName: "RainbowPetAI",
  });
  assert.equal(leakedGlobal.brandName, "VideoToArticleAI");
  assert.equal(leakedGlobal.targetDomain, "https://videotoarticleai.com");
  assert.equal(leakedGlobal.commentTemplate, "VideoToArticleAI turns video into articles.");
  assert.equal(leakedGlobal.projectKey, "VideoToArticleAI");

  const explicitComment = P.buildAgentConfigFromProfile(video, {
    applyCommentTemplate: true,
    commentTemplate: "custom comment for this page",
  });
  assert.equal(explicitComment.commentTemplate, "custom comment for this page");

  const merged = P.mergeFillConfig(
    {
      brandName: "RainbowPetAI",
      targetDomain: "https://rainbowpetai.com",
      commentTemplate: "Rainbow leftover",
      fillOnly: false,
      autoSubmitDirectory: true,
      pingIndex: true,
    },
    P.buildAgentConfigFromProfile(video),
    {
      brandName: "RainbowPetAI",
      targetDomain: "https://rainbowpetai.com",
      commentTemplate: "also leftover",
      concurrency: 3,
    },
  );
  assert.equal(merged.brandName, "VideoToArticleAI");
  assert.equal(merged.targetDomain, "https://videotoarticleai.com");
  assert.equal(merged.commentTemplate, "VideoToArticleAI turns video into articles.");
  assert.equal(merged.projectKey, "VideoToArticleAI");
  assert.equal(merged.pingIndex, true);
  assert.equal(merged.concurrency, 3);

  assert.equal(P.fillIdentityMismatch(merged, video), "");
  assert.equal(
    P.fillIdentityMismatch(P.buildAgentConfigFromProfile(rainbow), video),
    "projectKey",
  );
  assert.equal(
    P.taskConfigIdentityMismatch(
      {
        profileId: "VideoToArticleAI",
        profileName: "VideoToArticleAI",
        config: P.buildAgentConfigFromProfile(video),
      },
      P.buildAgentConfigFromProfile(rainbow),
    ),
    "projectKey",
  );
}

console.log("profile migration tests passed");
