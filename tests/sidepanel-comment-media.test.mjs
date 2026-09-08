import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("extension/sidepanel.html", "utf8");
const js = readFileSync("extension/sidepanel.js", "utf8");
const css = readFileSync("extension/sidepanel.css", "utf8");

// Comment studio: generation, selection, editing and history are separate UI states.
for (const id of [
  "commentTone",
  "btnRegenComment",
  "commentDraftList",
  "spCommentText",
  "commentCharCount",
  "commentCharLimit",
  "commentRemaining",
  "commentLengthHint",
  "btnRestoreComment",
  "commentHistory",
]) {
  assert.match(html, new RegExp(`id="${id}"`), `sidepanel should expose #${id}`);
}
assert.match(js, /action:\s*["']generateCommentDrafts["']/);
assert.match(js, /count:\s*3/);
assert.match(js, /function\s+selectCommentDraft\s*\(/);
assert.match(js, /loadCommentTemplate\(\{\s*force:\s*true\s*\}\)/);
assert.match(js, /表单校验未通过，已让 AI 补填/);
assert.doesNotMatch(js, /commentTemplate:\s*items\.cfgCommentTemplate/);
assert.match(js, /function\s+captureCommentState\s*\(/);
assert.match(js, /function\s+commentIsOverLimit\s*\(/);
assert.match(js, /请先生成或编辑评论，再点击填入评论/);
assert.match(js, /getPageSnapshot/);
assert.match(js, /commentFieldInfo\.maxLength/);
assert.match(js, /commentRemaining/);
assert.match(html, />生成 3 条</);
assert.match(html, />填入评论</);

// Cloud media preflight and post-fill upload evidence reuse existing messages.
for (const id of ["btnRefreshMedia", "mediaLibraryStatus", "mediaPreflightList", "mediaUploadResult"]) {
  assert.match(html, new RegExp(`id="${id}"`), `sidepanel should expose #${id}`);
}
assert.match(js, /action:\s*["']listCloudSubmissionMedia["']/);
assert.match(js, /action:\s*["']fetchCloudSubmissionMedia["']/);
assert.match(html, /云端 Logo 和截图/);
assert.match(js, /action === ["']mediaUploadStatus["']/);
assert.match(js, /function\s+refreshMediaUploadResult\s*\(/);
assert.match(js, /function\s+renderMediaUploadResult\s*\(/);
assert.match(js, /实际上传成功/);
assert.match(js, /media-file-thumb/);

// Queue quality and project statuses are visible in the page insight card.
for (const id of ["queueQuality", "queueQualityScore", "queueQualityTier", "queueProjectStatus"]) {
  assert.match(html, new RegExp(`id="${id}"`), `sidepanel should expose #${id}`);
}
assert.match(js, /function\s+renderQueueQuality\s*\(/);
assert.match(js, /task\.quality/);
assert.match(js, /task\.profiles/);

assert.doesNotMatch(js, /innerHTML\s*=/);
assert.match(css, /comment-draft-option\.selected/);
assert.match(css, /@media \(max-width: 520px\)[\s\S]*grid-template-columns: repeat\(2, 1fr\)/);
assert.match(css, /comment-studio \.card-head-row[\s\S]*flex-wrap: wrap/);
assert.match(css, /comment-length-hint\.err/);
assert.match(css, /media-file-item/);
assert.match(css, /queue-quality-score/);

console.log("Sidepanel comment/media tests passed");
