// Shared batch scheduler helpers for destination-grouped submission runs.
(function (global) {
  "use strict";

  function groupTasksByDestination(tasks) {
    const grouped = new Map();
    for (const task of tasks || []) {
      const key = task.destinationGroupKey || task.key || task.domain || task.url;
      if (!key) continue;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          url: task.url,
          domain: task.domain,
          status: "pending",
          tasks: [],
        });
      }
      grouped.get(key).tasks.push(task);
    }
    return [...grouped.values()];
  }

  function countProcessingSlots(entries) {
    let count = 0;
    for (const entry of entries?.values?.() || []) {
      if (entry.slotActive !== false) count += 1;
    }
    return count;
  }

  function resolveCursorIndex(groups, currentKey, currentIndex, delta) {
    if (!Array.isArray(groups) || !groups.length) return 0;
    const existing = groups.findIndex((group) => group.key === currentKey);
    if (existing >= 0) {
      return (existing + delta + groups.length) % groups.length;
    }
    if (delta < 0) return Math.max(0, Math.min(groups.length - 1, currentIndex - 1));
    return Math.max(0, Math.min(groups.length - 1, currentIndex));
  }

  function nextPendingTask(group, currentTaskIndex) {
    const tasks = group?.tasks || [];
    const start = tasks.findIndex((task) => task.index === currentTaskIndex);
    for (let index = Math.max(0, start + 1); index < tasks.length; index += 1) {
      if (tasks[index].status === "pending") return tasks[index];
    }
    return null;
  }

  function buildRestoredQueue(groups, parkedTaskIds) {
    const parked = new Set(parkedTaskIds || []);
    const parkedGroups = new Set();
    for (const group of groups || []) {
      if ((group.tasks || []).some((task) => parked.has(task.id))) parkedGroups.add(group.key);
    }
    return (groups || []).filter(
      (group) =>
        !parkedGroups.has(group.key) &&
        (group.tasks || []).some((task) => task.status === "pending"),
    );
  }

  global.ExtLinkScheduler = {
    groupTasksByDestination,
    countProcessingSlots,
    resolveCursorIndex,
    nextPendingTask,
    buildRestoredQueue,
  };
})(typeof self !== "undefined" ? self : window);
