import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const root = resolve(".");
const backgroundSource = readFileSync(resolve(root, "extension/background.js"), "utf8");

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

// Keep this test coupled to the real worker implementation while avoiding the
// unrelated tab scheduler and network runtime. The targeted functions are
// extracted from the current background source and executed in one VM.
function extractFunction(source, name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `background.js must define ${name}()`);

  const open = source.indexOf("{", start);
  assert.ok(open > start, `${name}() must have a function body`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`could not extract ${name}()`);
}

function createChrome(storage = {}, tabs = []) {
  const storageData = clone(storage) || {};
  const tabMap = new Map(tabs.map((tab) => [tab.id, { ...clone(tab) }]));
  const getCalls = [];
  const local = {
    async get(keys) {
      getCalls.push(keys);
      if (keys === undefined || keys === null) return clone(storageData);
      if (typeof keys === "string") return { [keys]: clone(storageData[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, clone(storageData[key])]));
      }
      return Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [
          key,
          Object.prototype.hasOwnProperty.call(storageData, key)
            ? clone(storageData[key])
            : clone(fallback),
        ]),
      );
    },
    async set(values) {
      for (const [key, value] of Object.entries(values || {})) storageData[key] = clone(value);
    },
  };
  return {
    chrome: {
      storage: { local },
      tabs: {
        async get(tabId) {
          const tab = tabMap.get(tabId);
          if (!tab) throw new Error(`No tab with id ${tabId}`);
          return clone(tab);
        },
      },
    },
    storageData,
    getCalls,
  };
}

const mock = createChrome(
  { siteAnnotations: {}, deletedSubmissionKeys: [] },
  [{ id: 17, url: "https://directory.example/submit" }],
);
const context = {
  console: { log() {}, warn() {}, error() {} },
  chrome: mock.chrome,
  URL,
  Promise,
  Set,
  Map,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Date,
  JSON,
  Error,
  TypeError,
};
context.self = context;
context.window = context;
vm.createContext(context);

for (const file of ["extension/lib/batch-controls.js", "extension/lib/queue.js"]) {
  vm.runInContext(readFileSync(resolve(root, file), "utf8"), context, { filename: file });
}

const functions = [
  "siteKeyForUrl",
  "reusableDestinationMappings",
  "persistDestinationFormKnowledge",
  "applyDestinationFormKnowledge",
  "destinationFormSchema",
  "writeSubmissionSiteAnnotation",
  "markSubmissionSite",
].map((name) => extractFunction(backgroundSource, name));
vm.runInContext(
  `const runSiteAnnotationWrite = self.ExtLinkBatchControls.createSerialExecutor();\n${functions.join("\n\n")}`,
  context,
  { filename: "extension/background-destination-memory.js" },
);

const hooks = vm.runInContext(
  `({
    reusableDestinationMappings,
    persistDestinationFormKnowledge,
    applyDestinationFormKnowledge,
    destinationFormSchema,
    writeSubmissionSiteAnnotation,
    markSubmissionSite,
  })`,
  context,
);

const destinationUrl = "https://directory.example/submit";
const learnedByA = {
  product_url: {
    profileKey: "Url",
    value: "https://product-a.example",
    label: "Product URL",
    hint: "Website URL",
  },
  product_name: {
    profileKey: "Name",
    value: "Product A",
    label: "Product name",
    hint: "Name of tool",
  },
  category: {
    profileKey: "category",
    value: "AI Tools",
    label: "Category",
    hint: "Choose category",
  },
  select_without_profile_key: {
    profileKey: "select",
    value: "SaaS",
    label: "Pricing type",
    hint: "Pricing",
  },
  unknown_value: {
    value: "A-only answer",
    label: "How did you hear about us?",
    hint: "Referral",
  },
};

const reusable = await hooks.reusableDestinationMappings(learnedByA);
assert.deepEqual(Object.keys(reusable).sort(), ["product_name", "product_url"]);
assert.equal(reusable.product_name.profileKey, "Name");
assert.equal(reusable.product_url.profileKey, "Url");
assert.equal(reusable.product_name.shared, true);
assert.equal(Object.hasOwn(reusable.product_name, "value"), false);
assert.equal(Object.hasOwn(reusable.product_url, "value"), false);

const initialMark = await hooks.markSubmissionSite({
  url: destinationUrl,
  status: "can_submit",
  note: "A 已人工确认表单可提交",
  submittedProject: "A",
});
assert.equal(initialMark.annotation.status, "can_submit");
assert.equal(initialMark.annotation.auto, false);

const snapshotWithAnswers = {
  url: `${destinationUrl}?profile=A&utm_source=test`,
  forms: [{ action: "/submit?from=A", method: "post" }],
  fields: [
    {
      selector: "#product-name",
      name: "product_name",
      id: "product-name",
      type: "text",
      label: "Product name",
      required: true,
      value: "Product A",
    },
    {
      selector: "#pricing",
      name: "pricing",
      id: "pricing",
      type: "select",
      label: "Pricing type",
      required: true,
      value: "paid",
      options: [{ value: "paid", label: "Paid", text: "Paid", selected: true, disabled: false }],
    },
  ],
};
const schema = hooks.destinationFormSchema(snapshotWithAnswers);
assert.equal(schema.url, destinationUrl);
assert.equal(JSON.stringify(schema).includes("Product A"), false);
assert.equal(JSON.stringify(schema).includes("selected"), false);
assert.equal(JSON.stringify(schema).includes("?profile=A"), false);
assert.equal(Object.hasOwn(schema.fields[0], "value"), false);
assert.equal(Object.hasOwn(schema.fields[1], "value"), false);
assert.equal(schema.fields[1].options[0].value, "paid");

await hooks.persistDestinationFormKnowledge(destinationUrl, learnedByA, schema);
const destinationKey = "directory.example/submit";
const domain = "directory.example";
const annotationAfterA = mock.storageData.siteAnnotations[destinationKey];
assert.equal(annotationAfterA.status, "can_submit");
assert.equal(annotationAfterA.formKnowledge.version, 1);
assert.equal(annotationAfterA.formKnowledge.mappings.product_name.profileKey, "Name");
assert.equal(Object.hasOwn(annotationAfterA.formKnowledge.mappings.product_name, "value"), false);
assert.equal(
  JSON.stringify(annotationAfterA.formKnowledge.schema),
  JSON.stringify(schema),
);
assert.equal(
  JSON.stringify(mock.storageData.siteAnnotations[domain]),
  JSON.stringify(annotationAfterA),
);

// Profile B receives the destination schema, while A's concrete values never
// cross the Profile boundary. A Profile-local mapping still wins when present.
const configB = { learnedFieldMappings: {} };
await hooks.applyDestinationFormKnowledge(17, configB);
const hostMappings = configB.learnedFieldMappings[domain];
assert.equal(hostMappings.product_name.profileKey, "Name");
assert.equal(hostMappings.product_url.profileKey, "Url");
assert.equal(hostMappings.product_name.shared, true);
assert.equal(Object.hasOwn(hostMappings.product_name, "value"), false);
assert.equal(JSON.stringify(configB.destinationFormSchema), JSON.stringify(schema));

// Existing per-Profile knowledge is upgraded into the shared semantic layer
// when B visits C. The literal answer stored by A must stay out of B's config.
mock.storageData.siteProfiles = {
  A: {
    learnedFieldMappings: {
      [domain]: {
        legacy_url: {
          profileKey: "Url",
          value: "https://product-a.example",
          label: "Website URL",
          hint: "Product URL",
        },
        legacy_choice: {
          profileKey: "category",
          value: "AI Tools",
          label: "Category",
          hint: "Choose category",
        },
      },
    },
  },
  B: {},
};
const configBFromLegacy = { learnedFieldMappings: {} };
await hooks.applyDestinationFormKnowledge(17, configBFromLegacy);
assert.ok(
  mock.getCalls.some(
    (keys) =>
      Array.isArray(keys) && keys.includes("siteAnnotations") && keys.includes("siteProfiles"),
  ),
);
const legacyMappings = configBFromLegacy.learnedFieldMappings[domain];
assert.equal(legacyMappings.legacy_url.profileKey, "Url");
assert.equal(Object.hasOwn(legacyMappings.legacy_url, "value"), false);
assert.equal(legacyMappings.legacy_choice, undefined);

const configBWithOwnMapping = {
  learnedFieldMappings: {
    [domain]: {
      product_name: {
        profileKey: "Name",
        value: "Product B",
        label: "Product name",
        hint: "Name of tool",
      },
    },
  },
};
await hooks.applyDestinationFormKnowledge(17, configBWithOwnMapping);
assert.equal(
  configBWithOwnMapping.learnedFieldMappings[domain].product_name.value,
  "Product B",
);
assert.notEqual(
  configBWithOwnMapping.learnedFieldMappings[domain].product_name.value,
  "Product A",
);

// An automatic paid observation from B must not erase A's explicit
// destination verdict or its shared form knowledge.
const automaticObservation = await hooks.markSubmissionSite({
  url: destinationUrl,
  status: "paid",
  note: "B 页面出现 Paid 字样，待确认是否为产品定价字段",
  auto: true,
});
assert.equal(automaticObservation.annotation.status, "can_submit");
assert.equal(automaticObservation.annotation.auto, false);
assert.equal(automaticObservation.annotation.lastAutomaticObservation.status, "paid");
assert.equal(
  automaticObservation.annotation.formKnowledge.mappings.product_url.profileKey,
  "Url",
);
assert.equal(
  Object.hasOwn(automaticObservation.annotation.formKnowledge.mappings.product_url, "value"),
  false,
);

// A later manual gate decision is allowed to change the destination status,
// but it must retain the learned form schema.
const manualCaptcha = await hooks.markSubmissionSite({
  url: destinationUrl,
  status: "needs_captcha",
  note: "需要人工验证码",
});
assert.equal(manualCaptcha.annotation.status, "needs_captcha");
assert.equal(manualCaptcha.annotation.formKnowledge.mappings.product_name.profileKey, "Name");
assert.equal(mock.storageData.siteAnnotations[destinationKey].status, "needs_captcha");

for (let stage = 0; stage < 14; stage++) {
  await hooks.persistDestinationFormKnowledge(destinationUrl, {}, { url: destinationUrl, fields: [{ label: `Stage ${stage}` }] });
}
const rememberedStages = mock.storageData.siteAnnotations[destinationKey].formKnowledge.stages;
assert.equal(rememberedStages.length, 12);
assert.equal(rememberedStages.at(-1).fields[0].label, "Stage 13");
assert.equal(mock.storageData.siteAnnotations[destinationKey].formKnowledge.mappings.product_name.profileKey, "Name");

console.log("destination memory tests passed");
