# DeepSeek Form Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local DeepSeek-backed form agent so extension tasks are completed only after explicit success evidence is observed.

**Architecture:** A Python `local_agent` service stores `DEEPSEEK_API_KEY`, calls DeepSeek Chat Completions, and exposes `/health`, `/plan`, and `/judge`. The Chrome extension captures page snapshots, sends them through `background.js` to the local agent, executes structured actions in `content.js`, and marks tasks only from agent outcomes.

**Tech Stack:** Chrome extension Manifest V3, vanilla JavaScript, Python 3.9+, `aiohttp`, `python-dotenv`, DeepSeek Chat Completions at `https://api.deepseek.com/chat/completions`.

---

## File Structure

- Create `local_agent/server.py`: local HTTP service, DeepSeek client, JSON parsing, fallback local success heuristics.
- Create `local_agent/__init__.py`: package marker.
- Create `tests/local-agent.test.mjs`: static safety tests for local agent endpoints, env key handling, and DeepSeek request shape.
- Modify `requirements.txt`: add no new package if existing `aiohttp`, `requests`, and `python-dotenv` are enough.
- Modify `extension/content.js`: add `getPageSnapshot`, `executeActionPlan`, action helpers, success/captcha/login metadata in snapshots.
- Modify `extension/background.js`: add local agent calls, model-driven task loop, terminal statuses, and no timer-based `ok`.
- Modify `extension/manifest.json`: add `http://127.0.0.1:8787/*` to host permissions if needed for extension fetch.
- Modify `extension/popup.js`: show model-driven statuses without double-counting existing task state.
- Modify `extension/README.md`: document starting local agent and setting `DEEPSEEK_API_KEY`.
- Modify `tests/extension-content.test.mjs`: add regression checks for local agent integration and non-timer success.

## Task 1: Local Agent Skeleton

**Files:**
- Create: `local_agent/__init__.py`
- Create: `local_agent/server.py`
- Create: `tests/local-agent.test.mjs`

- [ ] **Step 1: Write the failing static test**

Add to `tests/local-agent.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const server = readFileSync(resolve(root, 'local_agent/server.py'), 'utf8');

assert.match(server, /DEEPSEEK_API_KEY/, 'local agent must read DEEPSEEK_API_KEY from environment');
assert.match(server, /async def handle_health/, 'local agent must expose a health endpoint handler');
assert.match(server, /async def handle_plan/, 'local agent must expose a plan endpoint handler');
assert.match(server, /async def handle_judge/, 'local agent must expose a judge endpoint handler');
assert.match(server, /web\.post\("\/plan"/, 'local agent must route POST /plan');
assert.match(server, /web\.post\("\/judge"/, 'local agent must route POST /judge');
assert.match(server, /web\.get\("\/health"/, 'local agent must route GET /health');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/local-agent.test.mjs
```

Expected: FAIL with `ENOENT` for `local_agent/server.py` or assertion failure if the file exists without handlers.

- [ ] **Step 3: Implement the minimal local agent skeleton**

Create `local_agent/__init__.py` as an empty file.

Create `local_agent/server.py`:

```python
import json
import os
from typing import Any, Dict

from aiohttp import web
from dotenv import load_dotenv


load_dotenv()

DEFAULT_PORT = int(os.getenv("LOCAL_AGENT_PORT", "8787"))
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-pro")


def json_response(data: Dict[str, Any], status: int = 200) -> web.Response:
    return web.json_response(data, status=status)


async def read_json(request: web.Request) -> Dict[str, Any]:
    try:
        return await request.json()
    except json.JSONDecodeError:
        raise web.HTTPBadRequest(text="Invalid JSON")


async def handle_health(request: web.Request) -> web.Response:
    return json_response({
        "ok": True,
        "model": DEEPSEEK_MODEL,
        "hasApiKey": bool(os.getenv("DEEPSEEK_API_KEY")),
    })


async def handle_plan(request: web.Request) -> web.Response:
    payload = await read_json(request)
    return json_response({
        "status": "needs_manual",
        "actions": [],
        "reason": "DeepSeek planning is not implemented yet",
        "receivedUrl": payload.get("snapshot", {}).get("url", ""),
    })


async def handle_judge(request: web.Request) -> web.Response:
    payload = await read_json(request)
    snapshot = payload.get("snapshot", {})
    return json_response({
        "status": "needs_action",
        "evidence": "",
        "reason": "DeepSeek judging is not implemented yet",
        "url": snapshot.get("url", ""),
    })


def create_app() -> web.Application:
    app = web.Application()
    app.add_routes([
        web.get("/health", handle_health),
        web.post("/plan", handle_plan),
        web.post("/judge", handle_judge),
    ])
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="127.0.0.1", port=DEFAULT_PORT)
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node tests/local-agent.test.mjs
python3 -m py_compile local_agent/server.py
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit**

```bash
git add local_agent tests/local-agent.test.mjs
git commit -m "feat: add local deepseek agent skeleton"
```

## Task 2: DeepSeek Client and JSON Planning

**Files:**
- Modify: `local_agent/server.py`
- Modify: `tests/local-agent.test.mjs`

- [ ] **Step 1: Write failing test for DeepSeek request shape**

Append to `tests/local-agent.test.mjs`:

```js
assert.match(server, /https:\/\/api\.deepseek\.com/, 'local agent should default to official DeepSeek base URL');
assert.match(server, /\/chat\/completions/, 'local agent should call DeepSeek chat completions endpoint');
assert.match(server, /response_format/, 'DeepSeek calls should request JSON object responses');
assert.match(server, /deepseek-v4-pro/, 'local agent should default to the current documented DeepSeek chat model');
assert.doesNotMatch(server, /sk-[A-Za-z0-9_-]{16,}/, 'local agent source must not contain a hard-coded API key');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/local-agent.test.mjs
```

Expected: FAIL because `server.py` does not call `/chat/completions` or set `response_format`.

- [ ] **Step 3: Implement DeepSeek helpers**

In `local_agent/server.py`, add imports:

```python
import re
import requests
```

Add these helpers below `read_json`:

```python
class AgentError(Exception):
    pass


def extract_json_object(text: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise AgentError("DeepSeek response did not contain JSON")
    parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise AgentError("DeepSeek JSON response was not an object")
    return parsed


def deepseek_chat_json(system_prompt: str, user_payload: Dict[str, Any]) -> Dict[str, Any]:
    api_key = os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise AgentError("DEEPSEEK_API_KEY is not set")

    response = requests.post(
        f"{DEEPSEEK_BASE_URL.rstrip('/')}/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": DEEPSEEK_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.1,
        },
        timeout=45,
    )
    response.raise_for_status()
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    return extract_json_object(content)
```

Replace `handle_plan` with:

```python
PLAN_PROMPT = """You plan browser form actions for an extension.
Return only JSON:
{
  "status": "act" | "needs_manual" | "blocked",
  "actions": [
    {"type": "fill", "selector": "string", "value": "string"},
    {"type": "select", "selector": "string", "value": "string"},
    {"type": "check", "selector": "string"},
    {"type": "click", "selector": "string"},
    {"type": "waitForNavigation", "timeoutMs": 10000},
    {"type": "noop", "reason": "string"}
  ],
  "reason": "short explanation"
}
Use only selectors present in the snapshot. Do not bypass CAPTCHA, login, email verification, or paid flows.
"""


async def handle_plan(request: web.Request) -> web.Response:
    payload = await read_json(request)
    try:
        plan = deepseek_chat_json(PLAN_PROMPT, payload)
        return json_response(normalize_plan(plan))
    except Exception as exc:
        return json_response({"status": "needs_manual", "actions": [], "reason": str(exc)}, status=200)
```

Add normalizer:

```python
ALLOWED_ACTIONS = {"fill", "select", "check", "click", "waitForNavigation", "noop"}


def normalize_plan(plan: Dict[str, Any]) -> Dict[str, Any]:
    status = plan.get("status")
    if status not in {"act", "needs_manual", "blocked"}:
        status = "needs_manual"
    actions = []
    for action in plan.get("actions", []):
        if isinstance(action, dict) and action.get("type") in ALLOWED_ACTIONS:
            actions.append(action)
    return {
        "status": status,
        "actions": actions if status == "act" else [],
        "reason": str(plan.get("reason", ""))[:500],
    }
```

- [ ] **Step 4: Run tests**

Run:

```bash
node tests/local-agent.test.mjs
python3 -m py_compile local_agent/server.py
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit**

```bash
git add local_agent/server.py tests/local-agent.test.mjs
git commit -m "feat: call deepseek for form action plans"
```

## Task 3: Success Judging

**Files:**
- Modify: `local_agent/server.py`
- Modify: `tests/local-agent.test.mjs`

- [ ] **Step 1: Write failing test for judge behavior**

Append to `tests/local-agent.test.mjs`:

```js
assert.match(server, /SUCCESS_URL_PATTERNS/, 'judge should include deterministic success URL patterns');
assert.match(server, /SUCCESS_TEXT_PATTERNS/, 'judge should include deterministic success text patterns');
assert.match(server, /JUDGE_PROMPT/, 'judge should use a DeepSeek prompt when local heuristics are inconclusive');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/local-agent.test.mjs
```

Expected: FAIL because success patterns and `JUDGE_PROMPT` do not exist yet.

- [ ] **Step 3: Implement local heuristics and DeepSeek judge**

Add below `PLAN_PROMPT`:

```python
SUCCESS_URL_PATTERNS = [
    "/success", "/thank-you", "/thank_you", "/submitted", "/pending", "/complete",
]

SUCCESS_TEXT_PATTERNS = [
    "successfully submitted", "submission received", "thank you", "thanks for submitting",
    "pending review", "we received your submission", "your submission has been received",
    "submitted successfully",
]

BLOCKED_TEXT_PATTERNS = [
    "captcha", "verify you are human", "login required", "sign in to continue",
    "check your email", "email verification", "payment required",
]

JUDGE_PROMPT = """Judge a post-action browser page snapshot.
Return only JSON:
{
  "status": "success" | "needs_action" | "needs_manual" | "blocked" | "failed",
  "evidence": "exact visible text or URL evidence",
  "reason": "short explanation"
}
Only return success when the page clearly confirms submission or pending review. CAPTCHA, login, email verification, and paid flows are needs_manual or blocked.
"""


def lower_snapshot_text(snapshot: Dict[str, Any]) -> str:
    return " ".join([
        str(snapshot.get("url", "")),
        str(snapshot.get("title", "")),
        str(snapshot.get("visibleText", "")),
    ]).lower()


def local_judge(snapshot: Dict[str, Any]) -> Dict[str, Any] | None:
    url = str(snapshot.get("url", "")).lower()
    text = lower_snapshot_text(snapshot)
    for pattern in SUCCESS_URL_PATTERNS:
        if pattern in url:
            return {"status": "success", "evidence": pattern, "reason": "success URL pattern matched"}
    for pattern in SUCCESS_TEXT_PATTERNS:
        if pattern in text:
            return {"status": "success", "evidence": pattern, "reason": "success text pattern matched"}
    for pattern in BLOCKED_TEXT_PATTERNS:
        if pattern in text:
            return {"status": "needs_manual", "evidence": pattern, "reason": "manual intervention required"}
    return None
```

Replace `handle_judge` with:

```python
async def handle_judge(request: web.Request) -> web.Response:
    payload = await read_json(request)
    snapshot = payload.get("snapshot", {})
    heuristic = local_judge(snapshot)
    if heuristic:
        return json_response(heuristic)
    try:
        decision = deepseek_chat_json(JUDGE_PROMPT, payload)
        status = decision.get("status")
        if status not in {"success", "needs_action", "needs_manual", "blocked", "failed"}:
            status = "needs_manual"
        return json_response({
            "status": status,
            "evidence": str(decision.get("evidence", ""))[:500],
            "reason": str(decision.get("reason", ""))[:500],
        })
    except Exception as exc:
        return json_response({"status": "needs_manual", "evidence": "", "reason": str(exc)}, status=200)
```

- [ ] **Step 4: Run tests**

Run:

```bash
node tests/local-agent.test.mjs
python3 -m py_compile local_agent/server.py
```

Expected: both commands exit `0`.

- [ ] **Step 5: Commit**

```bash
git add local_agent/server.py tests/local-agent.test.mjs
git commit -m "feat: judge form submission success"
```

## Task 4: Content Snapshot and Action Execution

**Files:**
- Modify: `extension/content.js`
- Modify: `tests/extension-content.test.mjs`

- [ ] **Step 1: Write failing static test**

Append to `tests/extension-content.test.mjs`:

```js
assert.match(content, /msg\.action === 'getPageSnapshot'/, 'content script should expose getPageSnapshot');
assert.match(content, /msg\.action === 'executeActionPlan'/, 'content script should expose executeActionPlan');
assert.match(content, /function getPageSnapshot/, 'content script should implement page snapshots');
assert.match(content, /function executeActionPlan/, 'content script should implement model action execution');
assert.match(content, /data-extlink-selector/, 'snapshots should produce stable selectors for agent actions');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/extension-content.test.mjs
```

Expected: FAIL because message handlers and helpers do not exist.

- [ ] **Step 3: Add message handlers**

In `extension/content.js`, inside `chrome.runtime.onMessage.addListener`, add:

```js
    if (msg.action === 'getPageSnapshot') {
      sendResponse(getPageSnapshot());
      return true;
    }
    if (msg.action === 'executeActionPlan') {
      executeActionPlan(msg.actions || []).then(sendResponse);
      return true;
    }
```

- [ ] **Step 4: Add snapshot helpers**

Add before `// ==============================`:

```js
  function getPageSnapshot() {
    assignStableSelectors();
    const fields = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(isRelevantSnapshotElement)
      .slice(0, 80)
      .map(snapshotField);
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], a[href]'))
      .filter(isRelevantSnapshotElement)
      .slice(0, 80)
      .map(snapshotButton);

    return {
      url: location.href,
      title: document.title,
      visibleText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 6000),
      fields,
      buttons,
      captcha: detectCaptcha(),
      loginLikely: /login|sign in|signin/i.test(document.body.innerText || ''),
    };
  }

  function assignStableSelectors() {
    let index = 0;
    for (const el of document.querySelectorAll('input, textarea, select, button, a')) {
      if (!el.dataset.extlinkSelector) {
        el.dataset.extlinkSelector = String(++index);
      }
    }
  }

  function extSelector(el) {
    return `[data-extlink-selector="${el.dataset.extlinkSelector}"]`;
  }

  function snapshotField(el) {
    return {
      selector: extSelector(el),
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      name: el.name || '',
      id: el.id || '',
      label: getFieldHint(el).slice(0, 300),
      value: el.type === 'password' ? '' : String(el.value || '').slice(0, 300),
      required: !!el.required,
    };
  }

  function snapshotButton(el) {
    return {
      selector: extSelector(el),
      tag: el.tagName.toLowerCase(),
      type: el.type || '',
      text: getElementLabel(el).slice(0, 300),
      href: el.href || '',
    };
  }

  function isRelevantSnapshotElement(el) {
    if (!isVisible(el)) return false;
    if (el.disabled) return false;
    if (el.type && ['hidden', 'password', 'file'].includes(el.type)) return false;
    return true;
  }
```

- [ ] **Step 5: Add action executor**

Add below `getPageSnapshot` helpers:

```js
  async function executeActionPlan(actions) {
    const results = [];
    for (const action of actions.slice(0, 20)) {
      try {
        const result = await executeModelAction(action);
        results.push({ ok: true, action, result });
      } catch (err) {
        results.push({ ok: false, action, error: err.message });
        break;
      }
    }
    await sleep(1000);
    return { ok: results.every(r => r.ok), results, snapshot: getPageSnapshot() };
  }

  async function executeModelAction(action) {
    if (!action || !action.type) throw new Error('Invalid action');
    if (action.type === 'noop') return 'noop';
    if (action.type === 'waitForNavigation') {
      await sleep(Math.min(action.timeoutMs || 5000, 15000));
      return 'waited';
    }
    const el = document.querySelector(action.selector);
    if (!el) throw new Error(`Selector not found: ${action.selector}`);
    if (action.type === 'fill') {
      await simulateTyping(el, String(action.value || ''));
      return 'filled';
    }
    if (action.type === 'select') {
      setFieldValue(el, String(action.value || ''));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'selected';
    }
    if (action.type === 'check') {
      el.checked = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'checked';
    }
    if (action.type === 'click') {
      el.click();
      await sleep(2000);
      return 'clicked';
    }
    throw new Error(`Unsupported action type: ${action.type}`);
  }
```

- [ ] **Step 6: Run tests**

Run:

```bash
node tests/extension-content.test.mjs
node --check extension/content.js
```

Expected: both commands exit `0`.

- [ ] **Step 7: Commit**

```bash
git add extension/content.js tests/extension-content.test.mjs
git commit -m "feat: expose page snapshots and model actions"
```

## Task 5: Background Local Agent Loop

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/manifest.json`
- Modify: `tests/extension-content.test.mjs`

- [ ] **Step 1: Write failing static test**

Append to `tests/extension-content.test.mjs`:

```js
const manifest = readFileSync(resolve(root, 'extension/manifest.json'), 'utf8');
assert.match(background, /LOCAL_AGENT_URL/, 'background should define local agent URL');
assert.match(background, /callLocalAgent/, 'background should call the local DeepSeek agent');
assert.match(background, /runAgentLoop/, 'background should run plan-execute-judge loop');
assert.match(background, /getPageSnapshot/, 'background should request page snapshots from content script');
assert.match(background, /executeActionPlan/, 'background should send model actions to content script');
assert.match(background, /status === "success"/, 'background should mark ok only from success status');
assert.doesNotMatch(background, /task\.status = "ok"[\s\S]{0,160}result && result\.ok/, 'legacy content ok should not be the model-driven completion path');
assert.match(manifest, /127\.0\.0\.1:8787/, 'manifest should allow local agent requests');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/extension-content.test.mjs
```

Expected: FAIL because background does not define the agent loop or manifest permission.

- [ ] **Step 3: Add manifest permission**

In `extension/manifest.json`, change `host_permissions` to:

```json
  "host_permissions": ["https://*/*", "http://*/*", "http://127.0.0.1:8787/*"],
```

- [ ] **Step 4: Add local agent helpers to background**

In `extension/background.js`, add constants:

```js
const LOCAL_AGENT_URL = "http://127.0.0.1:8787";
const MAX_AGENT_LOOPS = 4;
```

Add helpers before `handleContentReady`:

```js
async function callLocalAgent(path, payload) {
  const response = await fetch(LOCAL_AGENT_URL + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Local agent ${path} failed: ${response.status}`);
  return response.json();
}

async function getTabSnapshot(tabId) {
  return chrome.tabs.sendMessage(tabId, { action: "getPageSnapshot" });
}

async function executeTabActions(tabId, actions) {
  return chrome.tabs.sendMessage(tabId, { action: "executeActionPlan", actions });
}

function agentPayload(task, snapshot) {
  return {
    task: { url: task.url, platformType: task.platformType },
    config: state.config,
    snapshot,
  };
}
```

- [ ] **Step 5: Add agent loop**

Add:

```js
async function runAgentLoop(tabId, task, entry) {
  for (let i = 0; i < MAX_AGENT_LOOPS; i++) {
    resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
    const snapshot = await getTabSnapshot(tabId);
    const judge = await callLocalAgent("/judge", agentPayload(task, snapshot));

    if (judge.status === "success") {
      task.status = "ok";
      task.successEvidence = judge.evidence || judge.reason || "";
      log(`${task.domain}: 提交成功 - ${task.successEvidence}`, "ok");
      broadcastTaskUpdate(task);
      delayCloseTab(tabId, POST_SUCCESS_CLOSE_DELAY_MS);
      return;
    }
    if (["needs_manual", "blocked", "failed"].includes(judge.status)) {
      task.status = judge.status === "failed" ? "err" : "captcha";
      task.skipReason = judge.reason || judge.evidence || judge.status;
      log(`${task.domain}: ${judge.status} - ${task.skipReason}`, "warn");
      broadcastTaskUpdate(task);
      clearEntryTimeout(entry);
      return;
    }

    const plan = await callLocalAgent("/plan", agentPayload(task, snapshot));
    if (plan.status !== "act" || !Array.isArray(plan.actions) || plan.actions.length === 0) {
      task.status = "captcha";
      task.skipReason = plan.reason || "agent returned no actions";
      log(`${task.domain}: 等待人工处理 - ${task.skipReason}`, "warn");
      broadcastTaskUpdate(task);
      clearEntryTimeout(entry);
      return;
    }

    log(`${task.domain}: 执行 DeepSeek 动作 ${plan.actions.length} 个`, "");
    const execution = await executeTabActions(tabId, plan.actions);
    if (!execution || !execution.ok) {
      task.status = "captcha";
      task.skipReason = "action execution failed";
      log(`${task.domain}: 动作执行失败，等待人工处理`, "warn");
      broadcastTaskUpdate(task);
      clearEntryTimeout(entry);
      return;
    }
  }

  task.status = "captcha";
  task.skipReason = "agent loop limit reached";
  log(`${task.domain}: 达到 DeepSeek 循环上限，等待人工确认`, "warn");
  broadcastTaskUpdate(task);
  clearEntryTimeout(entry);
}
```

- [ ] **Step 6: Replace legacy completion path in `handleContentReady`**

After logging page ready and resetting timeout, replace the body of `try` with:

```js
    await runAgentLoop(tab.id, task, entry);
    return;
```

Keep the `catch` block and final `closeTab(tab.id)` only for hard errors. For the first implementation, remove or bypass the old `executeSubmit` path from `handleContentReady`; keep `manualSubmit` for the existing page banner flow.

- [ ] **Step 7: Run tests**

Run:

```bash
node tests/extension-content.test.mjs
node --check extension/background.js
node --check extension/content.js
```

Expected: all commands exit `0`.

- [ ] **Step 8: Commit**

```bash
git add extension/background.js extension/manifest.json tests/extension-content.test.mjs
git commit -m "feat: route tasks through local deepseek agent"
```

## Task 6: Popup Statuses and README

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write failing static test**

Add to `tests/extension-content.test.mjs`:

```js
const popup = readFileSync(resolve(root, 'extension/popup.js'), 'utf8');
const readme = readFileSync(resolve(root, 'extension/README.md'), 'utf8');
assert.match(popup, /needs_manual|captcha/, 'popup should display model/manual intervention statuses');
assert.match(readme, /DEEPSEEK_API_KEY/, 'README should document DeepSeek API key setup');
assert.match(readme, /python3 -m local_agent\.server/, 'README should document starting local agent');
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node tests/extension-content.test.mjs
```

Expected: FAIL because README does not document local agent.

- [ ] **Step 3: Update `.env.example`**

Append:

```env
DEEPSEEK_API_KEY=your_deepseek_api_key_here
DEEPSEEK_MODEL=deepseek-v4-pro
LOCAL_AGENT_PORT=8787
```

- [ ] **Step 4: Update README**

Add a section near the top of `extension/README.md`:

```markdown
## DeepSeek 本地 Agent

自动智能填表需要先启动本地服务，API key 不会写入 Chrome extension。

1. 在项目根目录配置 `.env`：

```env
DEEPSEEK_API_KEY=your_deepseek_api_key_here
DEEPSEEK_MODEL=deepseek-v4-pro
LOCAL_AGENT_PORT=8787
```

2. 安装依赖：

```bash
pip install -r requirements.txt
```

3. 启动本地 agent：

```bash
python3 -m local_agent.server
```

4. 重新加载 Chrome extension。

任务只有在页面出现成功证据，或本地 agent 判断提交成功后，才会被标记为完成。验证码、登录、邮箱验证、付费提交会进入人工处理状态并保持标签页打开。
```

- [ ] **Step 5: Run tests**

Run:

```bash
node tests/extension-content.test.mjs
```

Expected: command exits `0`.

- [ ] **Step 6: Commit**

```bash
git add .env.example extension/README.md extension/popup.js tests/extension-content.test.mjs
git commit -m "docs: document deepseek local agent setup"
```

## Task 7: End-to-End Manual Verification

**Files:**
- No code files required unless verification exposes defects.

- [ ] **Step 1: Start local agent**

Run:

```bash
DEEPSEEK_API_KEY=test-key python3 -m local_agent.server
```

Expected: service starts on `http://127.0.0.1:8787`.

- [ ] **Step 2: Health check**

In a second terminal:

```bash
curl http://127.0.0.1:8787/health
```

Expected: JSON with `"ok": true` and `"hasApiKey": true`.

- [ ] **Step 3: Run static checks**

Run:

```bash
node tests/local-agent.test.mjs
node tests/extension-content.test.mjs
python3 -m py_compile local_agent/server.py
node --check extension/content.js
node --check extension/background.js
node --check extension/popup.js
```

Expected: all commands exit `0`.

- [ ] **Step 4: Manual browser check**

1. Open `chrome://extensions/`.
2. Reload the unpacked extension from `extension/`.
3. Start the local agent with a real `DEEPSEEK_API_KEY`.
4. Run one known simple submit form target.
5. Confirm popup logs show:

```text
页面就绪
执行 DeepSeek 动作
提交成功
```

or a non-success terminal/manual state:

```text
needs_manual
blocked
failed
```

Expected: no task is marked successful unless success evidence is logged.

- [ ] **Step 5: Commit verification notes if docs changed**

If README troubleshooting notes were added during verification:

```bash
git add extension/README.md
git commit -m "docs: add deepseek agent troubleshooting notes"
```

## Self-Review

- Spec coverage: The plan covers local agent API, DeepSeek key handling, action schema, snapshot collection, action execution, success judging, non-timer completion, and setup docs.
- Placeholder scan: No task uses `TBD`, `TODO`, or vague implementation-only instructions. Each code task includes concrete snippets and commands.
- Type consistency: Status names match the spec: `success`, `needs_action`, `needs_manual`, `blocked`, `failed`, and plan status `act`.

