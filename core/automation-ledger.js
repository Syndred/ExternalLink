// Durable, bounded automation run ledger. The LLM may propose actions and a
// verdict, but only validateSuccessProof() may authorize a success record.
(function (global) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const MAX_RUNS = 120;
  const MAX_EVENTS_PER_RUN = 600;
  const MAX_TEXT = 1200;

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function compactText(value, limit = MAX_TEXT) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function normalizeLedger(raw = {}) {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const runs = source.runs && typeof source.runs === "object" && !Array.isArray(source.runs)
      ? clone(source.runs)
      : {};
    const order = (Array.isArray(source.order) ? source.order : Object.keys(runs))
      .map((id) => String(id || ""))
      .filter((id, index, list) => id && runs[id] && list.indexOf(id) === index)
      .slice(0, MAX_RUNS);
    const keep = new Set(order);
    for (const id of Object.keys(runs)) if (!keep.has(id)) delete runs[id];
    return { schemaVersion: SCHEMA_VERSION, order, runs };
  }

  function startRun(raw, input = {}) {
    const ledger = normalizeLedger(raw);
    const runId = String(input.runId || "").trim();
    if (!runId) throw new Error("automation run requires runId");
    const run = {
      runId,
      status: "running",
      selectedProfileIds: [...new Set((input.selectedProfileIds || []).map(String).filter(Boolean))],
      taskTotal: Math.max(0, Number(input.taskTotal) || 0),
      destinationTotal: Math.max(0, Number(input.destinationTotal) || 0),
      fillOnly: input.fillOnly === true,
      startedAt: input.startedAt || new Date().toISOString(),
      updatedAt: input.startedAt || new Date().toISOString(),
      tasks: {},
      events: [],
    };
    ledger.runs[runId] = run;
    ledger.order = [runId, ...ledger.order.filter((id) => id !== runId)].slice(0, MAX_RUNS);
    const keep = new Set(ledger.order);
    for (const id of Object.keys(ledger.runs)) if (!keep.has(id)) delete ledger.runs[id];
    return ledger;
  }

  function sanitizeSnapshot(value) {
    if (!value || typeof value !== "object") return undefined;
    return {
      url: compactText(value.url, 1000),
      title: compactText(value.title, 500),
      domHash: compactText(value.domHash, 160),
      fieldCount: Math.max(0, Number(value.fieldCount ?? value.meta?.fieldCount) || 0),
      buttonCount: Math.max(0, Number(value.buttonCount ?? value.meta?.buttonCount) || 0),
      formCount: Math.max(0, Number(value.formCount ?? value.meta?.formCount) || 0),
    };
  }

  function sanitizeEvent(input = {}) {
    const event = {
      id: compactText(input.id || `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, 120),
      at: input.at || new Date().toISOString(),
      taskId: compactText(input.taskId, 300),
      attempt: Math.max(1, Number(input.attempt) || 1),
      type: compactText(input.type || "event", 100),
      status: compactText(input.status, 100),
      action: compactText(input.action, 200),
      target: compactText(input.target, 500),
      result: compactText(input.result, MAX_TEXT),
      errorCode: compactText(input.errorCode, 160),
      artifactRef: compactText(input.artifactRef, 500),
      evidenceType: compactText(input.evidenceType, 120),
    };
    const before = sanitizeSnapshot(input.before);
    const after = sanitizeSnapshot(input.after);
    if (before) event.before = before;
    if (after) event.after = after;
    return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== "" && value !== undefined));
  }

  function appendEvent(raw, runId, input = {}) {
    const ledger = normalizeLedger(raw);
    const run = ledger.runs[runId];
    if (!run) return ledger;
    const nextRun = clone(run);
    nextRun.events = [...(Array.isArray(nextRun.events) ? nextRun.events : []), sanitizeEvent(input)]
      .slice(-MAX_EVENTS_PER_RUN);
    nextRun.updatedAt = input.at || new Date().toISOString();
    const taskId = String(input.taskId || "").trim();
    if (taskId) {
      const previous = nextRun.tasks?.[taskId] || {};
      nextRun.tasks = { ...(nextRun.tasks || {}) };
      nextRun.tasks[taskId] = {
        ...previous,
        taskId,
        destinationKey: compactText(input.destinationKey || previous.destinationKey, 500),
        profileId: compactText(input.profileId || previous.profileId, 120),
        status: compactText(input.status || previous.status || "running", 100),
        attempt: Math.max(1, Number(input.attempt || previous.attempt) || 1),
        lastEventAt: input.at || new Date().toISOString(),
        errorCode: compactText(input.errorCode || previous.errorCode, 160),
        result: compactText(input.result || previous.result, MAX_TEXT),
        evidenceType: compactText(input.evidenceType || previous.evidenceType, 120),
        artifactRef: compactText(input.artifactRef || previous.artifactRef, 500),
      };
    }
    ledger.runs[runId] = nextRun;
    return ledger;
  }

  function finishRun(raw, runId, status, at = new Date().toISOString()) {
    const ledger = normalizeLedger(raw);
    const run = ledger.runs[runId];
    if (!run) return ledger;
    ledger.runs[runId] = {
      ...run,
      status: compactText(status || "finished", 100),
      updatedAt: at,
      finishedAt: ["finished", "stopped", "failed"].includes(status) ? at : run.finishedAt,
    };
    return ledger;
  }

  function differentPublicResult(input = {}) {
    if (input.publicationStatus !== "published" || !input.publicUrl) return false;
    try {
      const publicUrl = new URL(input.publicUrl);
      const destination = new URL(input.destinationUrl || input.publicUrl);
      return publicUrl.href !== destination.href && !/\/(submit|new)(?:[/?#]|$)/i.test(publicUrl.pathname);
    } catch {
      return false;
    }
  }

  function validateSuccessProof(input = {}) {
    const evidence = compactText(input.evidence, MAX_TEXT);
    if (input.confirmedBy === "manual") {
      return evidence
        ? { ok: true, evidence, evidenceType: "manual_confirmation" }
        : { ok: false, reason: "人工确认缺少说明" };
    }

    const signals = (Array.isArray(input.evidenceSignals) ? input.evidenceSignals : [])
      .filter((signal) => signal?.matched === true && compactText(signal.text));
    const signal = signals.find((item) => compactText(item.text) === evidence) || signals[0];
    if (!signal) return { ok: false, reason: "缺少页面、网络或公开结果的确定性证据" };

    const actionObserved = input.actionObserved === true;
    const deterministicSubmit = input.source === "deterministic_submit" && actionObserved;
    let signalMatchesPublicUrl = false;
    try {
      signalMatchesPublicUrl = Boolean(signal.url && input.publicUrl && new URL(signal.url).href === new URL(input.publicUrl).href);
    } catch {
      signalMatchesPublicUrl = false;
    }
    const publicResult = differentPublicResult(input)
      && signalMatchesPublicUrl
      && ["public_listing", "visible_confirmation"].includes(signal.type);
    const networkReceipt = input.networkEvidence?.matched === true && /^2\d\d$/.test(String(input.networkEvidence.status || ""));
    if (!deterministicSubmit && !publicResult && !networkReceipt) {
      return { ok: false, reason: "未观察到本次提交动作、成功响应或独立公开结果" };
    }

    return {
      ok: true,
      evidence: compactText(signal.text),
      evidenceType: networkReceipt ? "network_receipt" : publicResult ? "public_listing" : signal.type,
      evidenceUrl: compactText(signal.url || input.evidenceUrl || input.publicUrl, 1000),
    };
  }

  global.ExtLinkAutomationLedger = {
    SCHEMA_VERSION,
    MAX_RUNS,
    MAX_EVENTS_PER_RUN,
    normalizeLedger,
    startRun,
    appendEvent,
    finishRun,
    validateSuccessProof,
  };
})(self);
