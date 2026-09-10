(function (global) {
  "use strict";
  function build(batch) {
    if (!batch?.runId) throw new Error("当前没有批次报告");
    const destinations = new Map((batch.destinations || []).map((row) => [Number(row[0]), row]));
    const groups = { success: [], manual: [], failed: [], skipped: [], remaining: [] };
    for (const raw of batch.tasks || []) {
      const destination = Array.isArray(raw) ? destinations.get(Number(raw[1])) || [] : [];
      const task = Array.isArray(raw) ? {
        index: raw[0], profile: raw[3] || raw[2], status: raw[4], reason: raw[7] || "",
        evidence: raw[8] || "", publicationStatus: raw[9] || "", publicUrl: raw[10] || "",
        evidenceUrl: raw[11] || "", url: destination[2] || "", domain: destination[3] || "",
      } : {
        index: raw.index, profile: raw.profileName || raw.profileId, status: raw.status,
        reason: raw.skipReason || "", evidence: raw.successEvidence || "",
        publicationStatus: raw.publicationStatus || "", publicUrl: raw.publicUrl || "",
        evidenceUrl: raw.evidenceUrl || "", url: raw.url || "", domain: raw.domain || "",
      };
      const bucket = task.status === "ok" ? "success" : task.status === "err" ? "failed"
        : task.status === "skip" ? "skipped" : ["pending", "running"].includes(task.status)
          ? "remaining" : "manual";
      groups[bucket].push(task);
    }
    const summary = Object.fromEntries(Object.entries(groups).map(([key, tasks]) => [key, tasks.length]));
    return { runId: batch.runId, status: batch.status, startedAt: batch.startedAt,
      finishedAt: batch.finishedAt || batch.stoppedAt || null, generatedAt: new Date().toISOString(),
      unattended: batch.config?.unattended === true,
      stopReason: batch.unattendedState?.stopReason || batch.pauseReason || "",
      deadlineAt: batch.unattendedState?.runDeadlineAt || null,
      modelCallsUsed: Number(batch.unattendedState?.modelCallsUsed) || 0,
      summary, groups };
  }
  function markdown(report) {
    const clean = (value) => String(value ?? "").replace(/[\r\n|]/g, " ");
    const lines = ["# 外链批次报告", "", `批次 ${report.runId} · 状态 ${report.status}`, "",
      "已提交不代表已收录，发布状态和回执见下表。", ""];
    if (report.stopReason) lines.push(`暂停原因：${clean(report.stopReason)}`, "");
    if (report.unattended) lines.push(`本轮模型调用：${report.modelCallsUsed}`, "");
    const labels = { success: "取得回执", manual: "待人工 / 待核验", failed: "失败", skipped: "跳过", remaining: "剩余" };
    for (const [key, tasks] of Object.entries(report.groups)) {
      lines.push(`## ${labels[key]}（${tasks.length}）`, "");
      if (!tasks.length) continue;
      lines.push("| 项目 | 站点 | 状态 | 原因 / 回执 | 证据链接 |", "| --- | --- | --- | --- | --- |");
      for (const task of tasks) lines.push(`| ${clean(task.profile)} | ${clean(task.url)} | ${clean(task.publicationStatus || task.status)} | ${clean(task.reason || task.evidence)} | ${clean(task.publicUrl || task.evidenceUrl)} |`);
      lines.push("");
    }
    return lines.join("\n");
  }
  global.ExtLinkBatchReport = { build, markdown };
})(typeof self !== "undefined" ? self : globalThis);
