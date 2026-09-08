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
    return page.error == null && !loadingSignal && (interactive || text.length >= MIN_READY_TEXT_LENGTH);
  }

  function isCustomLaunchPlaybook(playbook) {
    return playbook?.kind === "custom_launch";
  }

  function parkedTaskStatus(classificationStatus) {
    return classificationStatus === "needs_captcha" ? "captcha" : "needs_manual";
  }

  function shouldAutoSkipGate(autoSkipCaptcha, classificationStatus) {
    return autoSkipCaptcha === true && classificationStatus === "needs_captcha";
  }

  function stopTabDisposition({ entry, parkedTaskIds, taskStatus, customLaunch } = {}) {
    const parked = parkedTaskIds instanceof Set ? parkedTaskIds : new Set(parkedTaskIds || []);
    if (["ok", "skip", "err"].includes(taskStatus)) return "close_automated";
    const humanStatus = new Set([
      "needs_login",
      "needs_captcha",
      "needs_otp",
      "needs_manual",
      "captcha",
    ]).has(taskStatus);
    if (entry?.slotActive === false || parked.has(entry?.taskId) || humanStatus || customLaunch) {
      return "preserve_manual";
    }
    return "close_automated";
  }

  function createSerialExecutor() {
    let tail = Promise.resolve();
    return function execute(operation) {
      const current = tail.then(operation);
      tail = current.catch(() => {});
      return current;
    };
  }

  function contentFingerprint(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`;
  }

  global.ExtLinkBatchControls = {
    REQUIRED_STABLE_CHECKS,
    MIN_READY_TEXT_LENGTH,
    shouldProcessQueue,
    controlVisibility,
    isStableContentReady,
    hasContentReadySignal,
    isCustomLaunchPlaybook,
    parkedTaskStatus,
    shouldAutoSkipGate,
    stopTabDisposition,
    createSerialExecutor,
    contentFingerprint,
  };
})(typeof self !== "undefined" ? self : globalThis);
