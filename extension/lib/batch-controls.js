// Shared batch lifecycle and readiness predicates.
(function (global) {
  "use strict";

  const REQUIRED_STABLE_CHECKS = 2;
  const MIN_READY_TEXT_LENGTH = 80;

  function shouldProcessQueue({ running, paused, stopped } = {}) {
    return running === true && paused !== true && stopped !== true;
  }

  function controlVisibility(status) {
    const schedulerActive = status === "running" || status === "paused";
    return {
      startHidden: schedulerActive,
      pauseHidden: status !== "running",
      resumeHidden: status !== "paused",
      stopHidden: !schedulerActive,
    };
  }

  function automatedTabIds(activeTabs, parkedTaskIds) {
    const parked = parkedTaskIds instanceof Set ? parkedTaskIds : new Set(parkedTaskIds || []);
    const ids = [];
    for (const [tabId, entry] of activeTabs?.entries?.() || []) {
      if (!entry || entry.slotActive === false || parked.has(entry.taskId)) continue;
      ids.push(tabId);
    }
    return ids;
  }

  function isStableContentReady({
    tabStatus,
    contentReady,
    stableChecks,
    requiredStableChecks = REQUIRED_STABLE_CHECKS,
  } = {}) {
    return (
      tabStatus === "complete" &&
      contentReady === true &&
      Number(stableChecks) >= Math.max(1, Number(requiredStableChecks) || REQUIRED_STABLE_CHECKS)
    );
  }

  function hasContentReadySignal({ snapshot = {}, detection = {} } = {}) {
    const page = snapshot && typeof snapshot === "object" ? snapshot : {};
    const probe = detection && typeof detection === "object" ? detection : {};
    const text = String(page.text || "").replace(/\s+/g, " ").trim();
    const loadingSignal = /\b(?:loading|please wait|just a moment|skeleton)\b|稍候|正在加载/i.test(text);
    const interactive = probe.operable === true || Number(probe.formFieldCount || 0) > 0;
    return page.error == null && (interactive || (text.length >= MIN_READY_TEXT_LENGTH && !loadingSignal));
  }

  function isCustomLaunchPlaybook(playbook) {
    return playbook?.kind === "custom_launch";
  }

  function parkedTaskStatus(classificationStatus) {
    return classificationStatus === "needs_captcha" ? "captcha" : "needs_manual";
  }

  global.ExtLinkBatchControls = {
    REQUIRED_STABLE_CHECKS,
    MIN_READY_TEXT_LENGTH,
    shouldProcessQueue,
    controlVisibility,
    automatedTabIds,
    isStableContentReady,
    hasContentReadySignal,
    isCustomLaunchPlaybook,
    parkedTaskStatus,
  };
})(typeof self !== "undefined" ? self : globalThis);
