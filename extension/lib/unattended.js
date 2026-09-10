// Pure helpers for bounded, resumable unattended batch runs.
(function (global) {
  "use strict";

  const DEFAULTS = Object.freeze({
    maxHours: 8,
    maxTasks: 100,
    maxAgentCalls: 200,
    maxConsecutiveFailures: 5,
    maxManualTabs: 20,
    watchdogMinutes: 1,
    taskMaxMinutes: 5,
  });

  function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function normalizeConfig(raw = {}) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      ...source,
      unattended: source.unattended === true,
      unattendedMaxHours: clampInt(source.unattendedMaxHours, DEFAULTS.maxHours, 1, 24),
      unattendedMaxTasks: clampInt(source.unattendedMaxTasks, DEFAULTS.maxTasks, 1, 1000),
      unattendedMaxAgentCalls: clampInt(
        source.unattendedMaxAgentCalls,
        DEFAULTS.maxAgentCalls,
        1,
        2000,
      ),
      unattendedMaxConsecutiveFailures: clampInt(
        source.unattendedMaxConsecutiveFailures,
        DEFAULTS.maxConsecutiveFailures,
        1,
        50,
      ),
      unattendedMaxManualTabs: clampInt(
        source.unattendedMaxManualTabs,
        DEFAULTS.maxManualTabs,
        1,
        100,
      ),
      unattendedWatchdogMinutes: clampInt(
        source.unattendedWatchdogMinutes,
        DEFAULTS.watchdogMinutes,
        1,
        5,
      ),
      unattendedTaskMaxMinutes: clampInt(
        source.unattendedTaskMaxMinutes,
        DEFAULTS.taskMaxMinutes,
        1,
        120,
      ),
    };
  }

  function validTimestamp(value) {
    const timestamp = typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value)
      ? Date.parse(value)
      : Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
  }

  function createCheckpoint(config = {}, now = Date.now(), previous = {}) {
    const normalized = normalizeConfig(config);
    const old = previous && typeof previous === "object" ? previous : {};
    const startedAt = validTimestamp(old.startedAt) || now;
    const runDeadlineAt = validTimestamp(old.runDeadlineAt) ||
      startedAt + normalized.unattendedMaxHours * 60 * 60 * 1000;
    return {
      enabled: normalized.unattended,
      startedAt,
      runDeadlineAt,
      maxHours: normalized.unattendedMaxHours,
      maxTasks: normalized.unattendedMaxTasks,
      maxAgentCalls: normalized.unattendedMaxAgentCalls,
      maxConsecutiveFailures: normalized.unattendedMaxConsecutiveFailures,
      maxManualTabs: normalized.unattendedMaxManualTabs,
      manualTabCount: Math.max(0, Number(old.manualTabCount) || 0),
      manualTabLimit: normalized.unattendedMaxManualTabs,
      waitReason: String(old.waitReason || ""),
      waitReasonAt: validTimestamp(old.waitReasonAt) || 0,
      watchdogMinutes: normalized.unattendedWatchdogMinutes,
      taskMaxMinutes: normalized.unattendedTaskMaxMinutes,
      taskBudgetUsed: Math.max(0, Number(old.taskBudgetUsed) || 0),
      modelCallsUsed: Math.max(0, Number(old.modelCallsUsed) || 0),
      consecutiveFailures: Math.max(0, Number(old.consecutiveFailures) || 0),
      manualTodoIds: [...new Set(Array.isArray(old.manualTodoIds) ? old.manualTodoIds.filter(Boolean) : [])],
      lastFailureAt: validTimestamp(old.lastFailureAt) || 0,
      lastFailureReason: String(old.lastFailureReason || ""),
      lastWatchdogAt: validTimestamp(old.lastWatchdogAt) || 0,
      stopReason: String(old.stopReason || ""),
    };
  }

  function isExpired(checkpoint, now = Date.now()) {
    return Boolean(checkpoint?.enabled && validTimestamp(checkpoint.runDeadlineAt) <= now);
  }

  function canStartTask(checkpoint, now = Date.now()) {
    if (!checkpoint?.enabled) return { ok: true, reason: "disabled" };
    if (isExpired(checkpoint, now)) return { ok: false, reason: "deadline" };
    if (Number(checkpoint.taskBudgetUsed) >= Number(checkpoint.maxTasks)) {
      return { ok: false, reason: "task_budget" };
    }
    return { ok: true, reason: "" };
  }

  function claimTask(checkpoint, now = Date.now()) {
    const decision = canStartTask(checkpoint, now);
    if (!decision.ok) return decision;
    return { ok: true, reason: "", next: { ...checkpoint, taskBudgetUsed: checkpoint.taskBudgetUsed + 1 } };
  }

  function taskAlreadyClaimed(task = {}) {
    return task.unattendedClaimed === true;
  }

  function reserveModelCall(checkpoint, now = Date.now()) {
    if (!checkpoint?.enabled) return { ok: true, reason: "disabled", next: checkpoint };
    if (isExpired(checkpoint, now)) return { ok: false, reason: "deadline" };
    if (Number(checkpoint.modelCallsUsed) >= Number(checkpoint.maxAgentCalls)) {
      return { ok: false, reason: "model_budget" };
    }
    return {
      ok: true,
      reason: "",
      next: { ...checkpoint, modelCallsUsed: checkpoint.modelCallsUsed + 1 },
    };
  }

  function noteFailure(checkpoint, reason, now = Date.now()) {
    const next = {
      ...checkpoint,
      consecutiveFailures: Math.max(0, Number(checkpoint?.consecutiveFailures) || 0) + 1,
      lastFailureAt: now,
      lastFailureReason: String(reason || ""),
    };
    return {
      next,
      pause: Boolean(next.enabled && next.consecutiveFailures >= next.maxConsecutiveFailures),
    };
  }

  function noteSuccess(checkpoint) {
    if (!checkpoint?.enabled || !checkpoint.consecutiveFailures) return checkpoint;
    return { ...checkpoint, consecutiveFailures: 0, lastFailureReason: "" };
  }

  function taskDeadline(checkpoint, now = Date.now()) {
    if (!checkpoint?.enabled) return 0;
    const perTask = now + Math.max(1, Number(checkpoint.taskMaxMinutes) || DEFAULTS.taskMaxMinutes) * 60 * 1000;
    return Math.min(validTimestamp(checkpoint.runDeadlineAt) || perTask, perTask);
  }

  function addManualTodo(checkpoint, taskId) {
    if (!checkpoint || !taskId) return checkpoint;
    if (checkpoint.manualTodoIds?.includes(taskId)) return checkpoint;
    return { ...checkpoint, manualTodoIds: [...(checkpoint.manualTodoIds || []), taskId] };
  }

  function removeManualTodo(checkpoint, taskId) {
    if (!checkpoint || !taskId) return checkpoint;
    return { ...checkpoint, manualTodoIds: (checkpoint.manualTodoIds || []).filter((id) => id !== taskId) };
  }

  function noteManualCapacity(checkpoint, manualTabCount, now = Date.now()) {
    if (!checkpoint) return checkpoint;
    const count = Math.max(0, Number(manualTabCount) || 0);
    const limit = Math.max(1, Number(checkpoint.maxManualTabs) || DEFAULTS.maxManualTabs);
    const blocked = count >= limit;
    const wasBlocked = checkpoint.waitReason === "manual_capacity";
    return {
      ...checkpoint,
      manualTabCount: count,
      manualTabLimit: limit,
      waitReason: blocked ? "manual_capacity" : wasBlocked ? "" : String(checkpoint.waitReason || ""),
      waitReasonAt: blocked
        ? (wasBlocked && validTimestamp(checkpoint.waitReasonAt) ? checkpoint.waitReasonAt : now)
        : 0,
    };
  }

  function pendingGroups(groups = [], parkedTaskIds = []) {
    const parked = new Set(parkedTaskIds || []);
    return (groups || []).filter((group) =>
      (group?.tasks || []).some((task) => task?.status === "pending" && !parked.has(task.id)),
    );
  }

  function interruptedTaskStatus(task = {}) {
    if (task.status !== "running") return null;
    return {
      status: task.submissionAttempted === true ? "submitted_unconfirmed" : "needs_manual",
      reason: task.submissionAttempted === true
        ? "后台中断，提交结果不确定，请人工核验"
        : "后台中断，未确认是否提交，请人工核验后再继续",
    };
  }

  global.ExtLinkUnattended = {
    DEFAULTS,
    clampInt,
    normalizeConfig,
    createCheckpoint,
    isExpired,
    canStartTask,
    claimTask,
    taskAlreadyClaimed,
    reserveModelCall,
    noteFailure,
    noteSuccess,
    taskDeadline,
    addManualTodo,
    removeManualTodo,
    noteManualCapacity,
    pendingGroups,
    interruptedTaskStatus,
  };
})(typeof self !== "undefined" ? self : globalThis);
