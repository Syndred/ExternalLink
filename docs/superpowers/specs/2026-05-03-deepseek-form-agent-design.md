# DeepSeek Form Agent Design

## Goal

Replace timer-based form completion with a local DeepSeek-assisted form agent. The extension should only mark a task complete after it observes success evidence on the page.

## Non-Goals

- Do not put the DeepSeek API key inside the Chrome extension.
- Do not rely on fixed delays as the definition of success.
- Do not add a full MCP browser stack in the first version. The local HTTP agent is the first stable boundary; MCP can be added behind it later.
- Do not attempt to bypass CAPTCHA, login walls, email verification, or paid submissions.

## Architecture

The system has three parts:

- `extension/content.js`: Collects a page snapshot, executes field-fill and click actions, and returns post-action snapshots.
- `extension/background.js`: Owns task lifecycle, calls the local agent, sends action plans to the tab, and marks tasks based on explicit outcomes.
- `local_agent/`: A local service on `http://127.0.0.1:8787` that stores the DeepSeek API key and turns page snapshots into structured plans and success decisions.

The extension never calls DeepSeek directly. It only talks to the local service.

## Data Flow

1. Background opens a target tab.
2. Content script reports `contentReady`.
3. Background asks content script for a `pageSnapshot`.
4. Background POSTs the snapshot and user config to `local_agent`.
5. Local agent calls DeepSeek and returns a JSON action plan.
6. Background sends the action plan to content script.
7. Content script executes actions and returns an updated snapshot.
8. Background asks local agent to judge whether the current page is successful, blocked, needs manual help, or needs another action loop.
9. Background marks the task only when the agent returns `success` or a hard terminal state such as `blocked`.

## Local Agent API

`POST /plan`

Request:

```json
{
  "task": {
    "url": "https://example.com/submit",
    "platformType": "auto"
  },
  "config": {
    "targetDomain": "https://example.com",
    "brandName": "Example",
    "anchorText": "Example",
    "email": "team@example.com",
    "username": "Alex Johnson",
    "commentTemplate": ""
  },
  "snapshot": {
    "url": "https://directory.test/submit",
    "title": "Submit your tool",
    "forms": [],
    "fields": [],
    "buttons": [],
    "visibleText": "Submit your product..."
  }
}
```

Response:

```json
{
  "status": "act",
  "actions": [
    { "type": "fill", "selector": "input[name='url']", "value": "https://example.com" },
    { "type": "fill", "selector": "input[name='name']", "value": "Example" },
    { "type": "click", "selector": "button[type='submit']" }
  ],
  "reason": "Detected product submission form"
}
```

`POST /judge`

Response statuses:

- `success`: Page has clear success evidence.
- `needs_action`: Another plan/action loop is useful.
- `needs_manual`: CAPTCHA, login, email verification, missing required human-only data, or ambiguous submit button.
- `blocked`: The site cannot be handled by the extension.
- `failed`: Submission clearly failed.

## Action Schema

Supported actions:

- `fill`: Set an input or textarea value and dispatch browser input/change events.
- `select`: Pick an option in a select field.
- `check`: Check a checkbox or radio button.
- `click`: Click a button or link.
- `waitForNavigation`: Wait for URL or DOM change.
- `noop`: Log the reason and keep the page open.

Every action must use a selector from the snapshot or a stable selector derived from a specific snapshot element. The local agent cannot invent arbitrary selectors without evidence.

## Success Detection

A task is complete only if the post-submit snapshot contains success evidence. Evidence can be:

- URL contains `/success`, `/thank-you`, `/submitted`, `/pending`, or similar.
- Visible text contains phrases such as `successfully submitted`, `submission received`, `thank you`, `pending review`, `we received your submission`.
- DeepSeek judges the post-submit page as successful and returns the exact evidence text.

The background worker should not close a task tab because a timer expired. Timers can prevent infinite hangs, but timeout status must be `needs_manual` or `blocked`, not `ok`.

## Error Handling

- If local agent is offline, background logs `DeepSeek local agent unavailable` and keeps the tab open for manual handling.
- If DeepSeek returns invalid JSON, local agent retries once with a stricter repair prompt.
- If action execution fails on a selector, content script reports the failed action and current snapshot.
- If CAPTCHA/login/email verification is detected, the task becomes `needs_manual` and the tab stays open.

## Security

- Store `DEEPSEEK_API_KEY` only in the local agent environment.
- Restrict local agent CORS to the extension origin where possible.
- Do not send cookies or localStorage values in snapshots.
- Truncate visible text and field metadata to avoid sending unnecessary page content.

## Testing

Use Node tests for static extension safety:

- Extension must not contain a DeepSeek API key.
- Background must call the local agent before model-driven actions.
- Content script must expose snapshot and action execution message handlers.
- Background must not mark `ok` from timers alone.

Use local fixture pages for behavioral tests:

- Simple product submission form reaches success page.
- React-like controlled input keeps model-filled values.
- CAPTCHA fixture becomes `needs_manual`.
- Failed submission page does not become `ok`.

