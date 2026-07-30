import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const serverPath = resolve("local_agent/server.py");
const source = readFileSync(serverPath, "utf8");

assert.match(source, /DEEPSEEK_API_KEY/);
assert.match(source, /https:\/\/api\.deepseek\.com/);
assert.match(source, /\/chat\/completions/);
assert.match(source, /response_format/);
assert.match(source, /deepseek-v4-pro/);
assert.match(source, /PLAN_PROMPT/);
assert.match(source, /SUCCESS_URL_PATTERNS/);
assert.match(source, /SUCCESS_TEXT_PATTERNS/);
assert.match(source, /BLOCKED_TEXT_PATTERNS/);
assert.match(source, /JUDGE_PROMPT/);
assert.match(source, /import\s+asyncio/);
assert.match(source, /MAX_PLAN_ACTIONS/);
assert.match(source, /MIN_WAIT_TIMEOUT_MS/);
assert.match(source, /MAX_WAIT_TIMEOUT_MS/);
assert.match(source, /PLAN_ACTION_OUTPUT_KEYS/);
assert.match(source, /def\s+get_deepseek_api_key/);
assert.match(source, /def\s+deepseek_chat_json/);
assert.match(source, /def\s+normalize_plan/);
assert.match(source, /def\s+local_judge/);
assert.match(source, /async\s+def\s+handle_health/);
assert.match(source, /async\s+def\s+handle_plan/);
assert.match(source, /async\s+def\s+handle_judge/);
assert.match(
  source,
  /await\s+asyncio\.to_thread\(\s*deepseek_chat_json,\s*PLAN_PROMPT,\s*payload\s*\)/,
);
assert.match(source, /local_judge\(\s*payload\s*\)/);
assert.match(
  source,
  /await\s+asyncio\.to_thread\(\s*deepseek_chat_json,\s*JUDGE_PROMPT,\s*payload\s*\)/,
);
assert.match(source, /router\.add_get\(["']\/health["'],\s*handle_health\)/);
assert.match(source, /router\.add_post\(["']\/plan["'],\s*handle_plan\)/);
assert.match(source, /router\.add_post\(["']\/judge["'],\s*handle_judge\)/);
assert.match(source, /router\.add_post\(["']\/extract-site["'],\s*handle_extract_site\)/);
assert.match(source, /router\.add_post\(["']\/generate-site["'],\s*handle_generate_site\)/);
assert.match(source, /EXTRACT_SITE_PROMPT/);
assert.match(source, /def\s+fetch_page_text/);
assert.match(source, /def\s+normalize_site_profile/);

const sourceWithoutEnvName = source
  .replaceAll("DEEPSEEK_API_KEY", "")
  .replaceAll("get_deepseek_api_key", "");
assert.doesNotMatch(sourceWithoutEnvName, /deepseek[_-]api[_-]key/i);
assert.doesNotMatch(sourceWithoutEnvName, /sk-[A-Za-z0-9_-]{16,}/);
