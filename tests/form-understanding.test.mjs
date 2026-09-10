import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backgroundSource = readFileSync(resolve(root, "extension/background.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = backgroundSource.indexOf(startMarker);
  const end = backgroundSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `background.js should contain ${startMarker}`);
  assert.ok(end > start, `background.js should contain ${endMarker} after ${startMarker}`);
  return backgroundSource.slice(start, end);
}

const schemaAndUnderstandSource = sourceBetween(
  "function destinationFormSchema(snapshot)",
  "async function persistFillLearnings",
);
const executeTabActionsSource = sourceBetween(
  "async function executeTabActions(tabId, actions)",
  "async function sha256Hex",
);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function baseSnapshot(overrides = {}) {
  return {
    url: "https://directory.example/submit?from=queue",
    forms: [{ action: "/submit", method: "post" }],
    fields: [
      {
        selector: "#name",
        name: "name",
        id: "name",
        type: "text",
        label: "Product name",
        options: [],
        required: true,
        value: "old name",
      },
      {
        selector: "#pricing",
        name: "pricing",
        id: "pricing",
        type: "select",
        label: "How is your product priced?",
        options: [
          { value: "free", label: "Free", text: "Free", selected: true },
          { value: "paid", label: "Paid", text: "Paid", selected: false },
        ],
        required: true,
        value: "free",
      },
      {
        selector: "#agree",
        name: "agree",
        id: "agree",
        type: "checkbox",
        label: "I agree to the terms",
        options: [],
        required: true,
        value: "on",
      },
    ],
    ...overrides,
  };
}

function makeHarness({ plans = [], snapshots = [], activeSiteId = "A", onPlan } = {}) {
  const state = { activeTabs: new Map(), lifecycleVersion: 0 };
  const events = [];
  const cloudCalls = [];
  const messages = [];
  let currentSiteId = activeSiteId;
  let snapshotIndex = 0;
  let planIndex = 0;
  const snapshotList = snapshots.length ? snapshots.map(clone) : [baseSnapshot()];
  const planList = plans.length ? plans.map(clone) : [{ status: "act", actions: [] }];

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === "activeSiteId" || (Array.isArray(keys) && keys.includes("activeSiteId"))) {
            return { activeSiteId: currentSiteId };
          }
          return {};
        },
      },
    },
    tabs: {
      async get() {
        return { id: 7, url: "https://directory.example/submit?from=queue" };
      },
      async sendMessage(tabId, message) {
        messages.push({ tabId, message: clone(message) });
        events.push(`message:${message.action}`);
        return { ok: true, results: [] };
      },
    },
  };

  const context = {
    console: { log() {}, warn() {}, error() {} },
    chrome,
    URL,
    JSON,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    Promise,
    RegExp,
    state,
    understoodForms: new Map(),
    applyDestinationFormKnowledge: async () => {},
    assertRunCurrent() {},
    broadcastAutoFillUpdate() {},
    log() {},
    getTabSnapshot: async () => {
      events.push("snapshot");
      const snapshot = snapshotList[Math.min(snapshotIndex++, snapshotList.length - 1)];
      return clone(snapshot);
    },
    callCloudAgent: async (endpoint, payload) => {
      events.push(`plan:${endpoint}`);
      cloudCalls.push({ endpoint, payload: clone(payload) });
      const plan = clone(planList[Math.min(planIndex++, planList.length - 1)]);
      if (onPlan) await onPlan({ state, setActiveSiteId: (id) => { currentSiteId = id; }, plan });
      return plan;
    },
  };
  context.self = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(executeTabActionsSource, context, { filename: "extension/background.js#executeTabActions" });
  vm.runInContext(schemaAndUnderstandSource, context, { filename: "extension/background.js#formUnderstanding" });
  const hooks = vm.runInContext(
    "({ destinationFormSchema, formSchemaKey, understandFormBeforeFill, state, understoodForms })",
    context,
  );

  return {
    context,
    hooks,
    events,
    cloudCalls,
    messages,
    setActiveSiteId(id) {
      currentSiteId = id;
    },
    setSnapshots(next) {
      snapshotIndex = 0;
      snapshotList.splice(0, snapshotList.length, ...next.map(clone));
    },
  };
}

function config(projectKey) {
  return {
    projectKey,
    targetDomain: "directory.example",
    projectFields: { Name: `Product ${projectKey}`, Pricing: "Paid" },
  };
}

{
  const runtime = makeHarness({
    plans: [{
      status: "act",
      reason: "Paid is the product pricing choice; the submission is free",
      actions: [
        { type: "fill", selector: "#name", value: "Product A" },
        { type: "select", selector: "#pricing", value: "free" },
        { type: "check", selector: "#agree", value: true },
        { type: "submit", selector: "form" },
        { type: "click", selector: "#submit" },
        { type: "fill", selector: "#not-in-snapshot", value: "must be ignored" },
      ],
    }],
    snapshots: [baseSnapshot(), baseSnapshot()],
  });

  const result = await runtime.hooks.understandFormBeforeFill(7, config("A"), "directory");
  assert.equal(result, null, "an act plan for a product Paid field should continue filling");
  const planIndex = runtime.events.indexOf("plan:/plan");
  const executeIndex = runtime.events.indexOf("message:executeActionPlan");
  assert.ok(planIndex >= 0 && executeIndex > planIndex, "plan must complete before executeActionPlan");
  assert.deepEqual(runtime.messages[0].message.actions, [
    { type: "fill", selector: "#name", value: "Product A" },
    { type: "select", selector: "#pricing", value: "free" },
    { type: "check", selector: "#agree", value: true },
  ]);
  assert.match(
    runtime.cloudCalls[0].payload.task.note,
    /Paid\/Free\/Freemium\/Subscription/,
    "the plan prompt must explain product pricing versus submission fees",
  );
  assert.equal(runtime.cloudCalls[0].payload.config.projectKey, "A");
  assert.equal(runtime.cloudCalls[0].payload.config.targetDomain, "directory.example");
  assert.equal(runtime.cloudCalls[0].payload.fillOnly, true);
  assert.equal(
    runtime.cloudCalls[0].payload.snapshot.url,
    "https://directory.example/submit?from=queue",
    "the model must receive the current page snapshot",
  );
}

{
  const runtime = makeHarness({
    plans: [{ status: "needs_manual", reason: "无法理解当前表单语义", actions: [] }],
    snapshots: [baseSnapshot(), baseSnapshot()],
  });
  const result = await runtime.hooks.understandFormBeforeFill(7, config("A"), "directory");
  assert.equal(result?.needs_manual, true);
  assert.equal(result?.reason, "无法理解当前表单语义");
  assert.equal(result?.semanticReview, true);
  assert.equal(
    runtime.messages.some(({ message }) => message.action === "executeActionPlan"),
    false,
    "a non-act semantic review must not execute actions",
  );
}

{
  const changed = baseSnapshot({
    fields: [baseSnapshot().fields[0], { ...baseSnapshot().fields[1], selector: "#new-pricing" }],
  });
  const runtime = makeHarness({
    plans: [{ status: "act", actions: [{ type: "fill", selector: "#name", value: "A" }] }],
    snapshots: [baseSnapshot(), changed],
  });
  const result = await runtime.hooks.understandFormBeforeFill(7, config("A"), "directory");
  assert.equal(result?.needs_manual, true, "a changed form schema must require review");
  assert.equal(result?.semanticReview, true);
  assert.equal(
    runtime.messages.some(({ message }) => message.action === "executeActionPlan"),
    false,
    "schema changes must stop before actions",
  );
}

for (const change of ["site", "lifecycle"]) {
  const runtime = makeHarness({
    plans: [{ status: "act", actions: [{ type: "fill", selector: "#name", value: "A" }] }],
    snapshots: [baseSnapshot(), baseSnapshot()],
    onPlan: async ({ state, setActiveSiteId }) => {
      if (change === "site") setActiveSiteId("B");
      else state.lifecycleVersion += 1;
    },
  });
  await assert.rejects(
    runtime.hooks.understandFormBeforeFill(7, config("A"), "directory"),
    change === "site" ? /项目已切换/ : /任务已变化/,
    `${change} changes must invalidate the pending plan`,
  );
  assert.equal(
    runtime.messages.some(({ message }) => message.action === "executeActionPlan"),
    false,
    `${change} changes must not execute stale actions`,
  );
}

{
  const runtime = makeHarness({
    plans: [
      { status: "act", actions: [{ type: "fill", selector: "#name", value: "A" }] },
      { status: "act", actions: [{ type: "fill", selector: "#name", value: "B" }] },
    ],
    snapshots: [baseSnapshot()],
  });
  await runtime.hooks.understandFormBeforeFill(7, config("A"), "directory");
  await runtime.hooks.understandFormBeforeFill(7, config("A"), "directory");
  assert.equal(runtime.cloudCalls.length, 1, "same profile and schema should use the per-tab cache");
  assert.equal(runtime.messages.filter(({ message }) => message.action === "executeActionPlan").length, 1);

  await runtime.hooks.understandFormBeforeFill(7, config("B"), "directory");
  assert.equal(runtime.cloudCalls.length, 2, "switching profile must ask the model again");
  assert.equal(runtime.cloudCalls[1].payload.task.projectKey, "B");
  assert.equal(runtime.messages.filter(({ message }) => message.action === "executeActionPlan").length, 2);
}

{
  const selectedFree = baseSnapshot();
  const selectedPaidAndFilled = baseSnapshot({
    url: "https://directory.example/submit?after=fill",
    fields: selectedFree.fields.map((field) => ({
      ...field,
      value: field.selector === "#name" ? "Product A" : field.value,
      options: field.options.map((option) => ({ ...option, selected: option.value === "paid" })),
    })),
  });
  assert.equal(
    runtimeSchemaKey(selectedFree),
    runtimeSchemaKey(selectedPaidAndFilled),
    "URL query, field values, and option.selected must not change the form schema",
  );

  const runtime = makeHarness({
    plans: [{ status: "act", actions: [{ type: "fill", selector: "#name", value: "A" }] }],
    snapshots: [selectedFree, selectedFree, selectedPaidAndFilled],
  });
  await runtime.hooks.understandFormBeforeFill(7, config("A"), "directory");
  await runtime.hooks.understandFormBeforeFill(7, config("A"), "directory");
  assert.equal(runtime.cloudCalls.length, 1, "answer changes alone must not invalidate the schema cache");
}

function runtimeSchemaKey(snapshot) {
  const runtime = makeHarness();
  return runtime.hooks.formSchemaKey(snapshot);
}

console.log("form understanding runtime tests passed");
