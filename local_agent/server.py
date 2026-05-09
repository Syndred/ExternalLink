"""Local HTTP agent skeleton for browser-extension form automation."""

import asyncio
import json
import math
import os
import re
from json import JSONDecodeError
from typing import Any, Optional

from aiohttp import web
from dotenv import load_dotenv
import requests


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
CHAT_COMPLETIONS_PATH = "/chat/completions"
DEEPSEEK_TIMEOUT_SECONDS = 45

load_dotenv()

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-pro")
ALLOWED_PLAN_ACTIONS = {"fill", "click", "select", "check", "submit", "wait"}
PLAN_STATUSES = {"act", "needs_manual", "blocked"}
JUDGE_STATUSES = {"success", "incomplete", "blocked", "needs_manual"}
MAX_PLAN_ACTIONS = 6
MIN_WAIT_TIMEOUT_MS = 100
MAX_WAIT_TIMEOUT_MS = 5000
PLAN_ACTION_OUTPUT_KEYS = {
    "fill": {"type", "selector", "value"},
    "click": {"type", "selector"},
    "select": {"type", "selector", "value"},
    "check": {"type", "selector", "value"},
    "submit": {"type", "selector"},
    "wait": {"type", "timeout_ms"},
}

PLAN_PROMPT = """You plan browser actions for a local browser extension that fills public submission forms.

Return only one strict JSON object with this shape:
{
  "status": "act" | "needs_manual" | "blocked",
  "actions": [
    {"type": "fill", "selector": "CSS selector from the snapshot", "value": "text value"},
    {"type": "click", "selector": "CSS selector from the snapshot"},
    {"type": "select", "selector": "CSS selector from the snapshot", "value": "option value or label"},
    {"type": "check", "selector": "CSS selector from the snapshot", "value": true},
    {"type": "submit", "selector": "CSS selector from the snapshot"},
    {"type": "wait", "timeout_ms": 1000}
  ],
  "reason": "short explanation"
}

Allowed action types are exactly: fill, click, select, check, submit, wait.
Use selectors that appear in the supplied snapshot or stable selectors directly derived from a specific snapshot element.
Do not invent page state. Do not bypass CAPTCHA, login, email verification, payment, or other human-only gates.
Use "needs_manual" when a human must decide or provide missing information.
Use "blocked" when the page cannot be handled safely.
"""

SUCCESS_URL_PATTERNS = (
    re.compile(r"(?:^|[/?#&=_-])(?:success|thank[-_]?you|thanks|submitted|submission[-_]?complete)(?:[/?#&=_-]|$)"),
    re.compile(r"(?:^|[/?#&=_-])(?:submission[-_]?received|confirmation|confirmed|complete|completed)(?:[/?#&=_-]|$)"),
    re.compile(r"(?:^|[/?#&=_-])(?:pending[-_]?review|awaiting[-_]?review|received)(?:[/?#&=_-]|$)"),
)

SUCCESS_TEXT_PATTERNS = (
    re.compile(r"\bthank you for (?:submitting|your submission|contacting us)\b"),
    re.compile(r"\bthanks for (?:submitting|your submission|contacting us)\b"),
    re.compile(r"\b(?:successfully submitted|submitted successfully|has been submitted|was submitted)\b"),
    re.compile(r"\b(?:submission|application|request|message|listing|entry) (?:successful|was successful|accepted)\b"),
    re.compile(r"\b(?:submission|application|request|message|listing|entry) (?:received|sent|submitted)\b"),
    re.compile(r"\b(?:we|we have|we've) received (?:your|the) (?:submission|application|request|message|listing|entry)\b"),
    re.compile(r"\b(?:awaiting|pending|under) review\b"),
    re.compile(r"\b(?:sent|created|posted) successfully\b"),
)

BLOCKED_TEXT_PATTERNS = (
    re.compile(r"\b(?:captcha|recaptcha|hcaptcha|turnstile)\b"),
    re.compile(r"\b(?:verify you are human|human verification|security check)\b"),
    re.compile(r"\b(?:(?:must|please|need to|required to) log in|login required|sign in to continue|signin required|account required|authentication required)\b"),
    re.compile(r"\b(?:payment (?:is )?required|credit card|checkout|subscribe to continue|paid plan)\b"),
    re.compile(r"\b(?:verify your email|email verification|verification code|one[- ]time code|check your email)\b"),
    re.compile(r"\b(?:access denied|forbidden|not authorized|unauthorized|blocked|rate limit)\b"),
    re.compile(r"\b(?:submission failed|server error|something went wrong|try again later|cannot submit)\b"),
)

MANUAL_BLOCKED_TEXT_PATTERNS = (
    re.compile(r"\b(?:captcha|recaptcha|hcaptcha|turnstile)\b"),
    re.compile(r"\b(?:verify you are human|human verification|security check)\b"),
    re.compile(r"\b(?:(?:must|please|need to|required to) log in|login required|sign in to continue|signin required|account required|authentication required)\b"),
    re.compile(r"\b(?:payment (?:is )?required|credit card|checkout|subscribe to continue|paid plan)\b"),
    re.compile(r"\b(?:verify your email|email verification|verification code|one[- ]time code|check your email)\b"),
)

FORM_OVERRIDABLE_BLOCKED_TEXT_PATTERNS = (
    re.compile(r"\b(?:payment (?:is )?required|credit card|checkout|subscribe to continue|paid plan)\b"),
)

FORM_FIELD_TEXT_PATTERNS = (
    re.compile(r"\b(?:name|full name|email|e-mail|website|url|link|company|title|description|message|comment|subject|phone)\b"),
)

SUBMIT_TEXT_PATTERN = re.compile(r"\b(?:submit|send|save|apply|post|publish|continue|next)\b")

JUDGE_PROMPT = """Judge whether a browser form submission has succeeded from the supplied post-action page snapshot.

Return only one strict JSON object with this shape:
{
  "status": "success" | "incomplete" | "blocked" | "needs_manual",
  "reason": "short explanation citing visible page evidence or URL evidence"
}

Use "success" only when the URL or visible page content clearly confirms the submission was received, submitted, accepted, or is awaiting review.
Use "incomplete" when the form is still present, required fields remain visible, validation is still needed, or there is no clear confirmation.
Use "blocked" when the page reports a hard failure, access denial, rate limit, server error, or other condition automation cannot resolve.
Use "needs_manual" when CAPTCHA, login, payment, email verification, or a human decision is required.
Do not infer success from timers, navigation/footer marketing text, or generic words without submission evidence.
"""


class AgentError(Exception):
    """Raised when the local agent cannot produce a valid planning response."""

    def __init__(self, message: str, *, http_status: int = 500, plan_status: str = "error"):
        super().__init__(message)
        self.message = message
        self.http_status = http_status
        self.plan_status = plan_status


def get_deepseek_api_key() -> Optional[str]:
    """Return the configured DeepSeek API key from the live environment or startup snapshot."""
    return os.getenv("DEEPSEEK_API_KEY") or DEEPSEEK_API_KEY


def extract_json_object(text: str) -> dict[str, Any]:
    """Extract the first valid JSON object from plain text or fenced model output."""
    if not isinstance(text, str):
        raise AgentError("DeepSeek response content was not text", http_status=502)

    stripped = text.strip()
    if not stripped:
        raise AgentError("DeepSeek response was empty", http_status=502)

    try:
        parsed = json.loads(stripped)
    except JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        return parsed

    in_string = False
    escaped = False
    depth = 0
    start = None

    for index, char in enumerate(stripped):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            continue
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
            continue
        if char != "}" or depth == 0:
            continue

        depth -= 1
        if depth != 0 or start is None:
            continue

        candidate = stripped[start : index + 1]
        try:
            parsed = json.loads(candidate)
        except JSONDecodeError:
            start = None
            continue
        if isinstance(parsed, dict):
            return parsed
        start = None

    raise AgentError("DeepSeek response did not contain a valid JSON object", http_status=502)


def deepseek_chat_json(system_prompt: str, user_payload: dict[str, Any]) -> dict[str, Any]:
    """Call DeepSeek Chat Completions and return the JSON object from the assistant."""
    api_key = get_deepseek_api_key()
    if not api_key:
        raise AgentError(
            "DEEPSEEK_API_KEY is not set for the local agent",
            http_status=503,
            plan_status="error",
        )

    try:
        response = requests.post(
            f"{DEEPSEEK_BASE_URL.rstrip('/')}{CHAT_COMPLETIONS_PATH}",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": DEEPSEEK_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": json.dumps(user_payload, ensure_ascii=False),
                    },
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.1,
            },
            timeout=DEEPSEEK_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise AgentError(f"DeepSeek request failed: {exc}", http_status=502) from exc

    if not 200 <= response.status_code < 300:
        detail = response.text.strip()[:500] or response.reason
        raise AgentError(
            f"DeepSeek HTTP {response.status_code}: {detail}",
            http_status=502,
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise AgentError("DeepSeek HTTP response was not valid JSON", http_status=502) from exc

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise AgentError(
            "DeepSeek response JSON did not include choices[0].message.content",
            http_status=502,
        ) from exc

    return extract_json_object(content)


def normalize_selector(value: Any) -> Optional[str]:
    """Return a non-empty selector string or None for malformed selector values."""
    if not isinstance(value, str):
        return None
    selector = value.strip()
    return selector or None


def normalize_wait_timeout(value: Any) -> int:
    """Return a bounded wait timeout in milliseconds."""
    if isinstance(value, bool):
        timeout_ms = MIN_WAIT_TIMEOUT_MS
    elif isinstance(value, int):
        timeout_ms = value
    elif isinstance(value, float):
        if not math.isfinite(value):
            timeout_ms = MAX_WAIT_TIMEOUT_MS if value > 0 else MIN_WAIT_TIMEOUT_MS
        else:
            timeout_ms = int(value)
    else:
        try:
            timeout_ms = int(value)
        except (OverflowError, TypeError, ValueError):
            timeout_ms = MIN_WAIT_TIMEOUT_MS
    return max(MIN_WAIT_TIMEOUT_MS, min(timeout_ms, MAX_WAIT_TIMEOUT_MS))


def normalize_check_value(value: Any) -> bool:
    """Return a boolean checkbox value, defaulting to true for missing values."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"false", "0", "no", "off"}:
            return False
        if lowered in {"true", "1", "yes", "on"}:
            return True
    return bool(value)


def normalize_plan_action(action: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Normalize one planner action into the local agent action schema."""
    action_type = action.get("type")
    if action_type not in ALLOWED_PLAN_ACTIONS:
        return None

    if action_type == "wait":
        return {
            "type": "wait",
            "timeout_ms": normalize_wait_timeout(action.get("timeout_ms")),
        }

    selector = normalize_selector(action.get("selector"))
    if selector is None:
        return None

    if action_type in {"click", "submit"}:
        return {"type": action_type, "selector": selector}
    if action_type in {"fill", "select"}:
        if "value" not in action:
            return None
        return {
            "type": action_type,
            "selector": selector,
            "value": str(action.get("value")),
        }
    if action_type == "check":
        return {
            "type": "check",
            "selector": selector,
            "value": normalize_check_value(action.get("value", True)),
        }

    return None


def normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Return a safe plan object containing only supported browser actions."""
    if not isinstance(plan, dict):
        raise AgentError("Planner response was not a JSON object", http_status=502)

    status = plan.get("status")
    reason = str(plan.get("reason") or plan.get("message") or "")[:500]
    if status not in PLAN_STATUSES:
        status = "blocked"
        reason = reason or "Planner returned an unsupported status"

    raw_actions = plan.get("actions", [])
    if not isinstance(raw_actions, list):
        raw_actions = []

    actions = []
    if status == "act":
        for action in raw_actions:
            if not isinstance(action, dict):
                continue
            normalized_action = normalize_plan_action(action)
            if normalized_action is None:
                continue
            actions.append(normalized_action)
            if len(actions) >= MAX_PLAN_ACTIONS:
                break

        if not actions:
            status = "blocked"
            reason = reason or "Planner returned no supported actions"

    return {
        "status": status,
        "actions": actions if status == "act" else [],
        "reason": reason,
    }


def iter_snapshot_dicts(payload: dict[str, Any]):
    """Yield top-level and nested snapshot dictionaries from a judge payload."""
    if isinstance(payload, dict):
        yield payload
        snapshot = payload.get("snapshot")
        if isinstance(snapshot, dict):
            yield snapshot


def iter_text_values(value: Any):
    """Yield string-like values from snapshot structures."""
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            yield stripped
        return

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        yield str(value)
        return

    if isinstance(value, dict):
        for nested_value in value.values():
            yield from iter_text_values(nested_value)
        return

    if isinstance(value, list):
        for item in value:
            yield from iter_text_values(item)


def normalize_text(value: Any) -> str:
    """Return whitespace-normalized lowercase text."""
    return re.sub(r"\s+", " ", " ".join(iter_text_values(value))).strip().lower()


def snapshot_text(payload: dict[str, Any]) -> str:
    """Flatten relevant visible snapshot text from a judge payload."""
    keys = (
        "url",
        "title",
        "bodyText",
        "body_text",
        "visibleText",
        "innerText",
        "text",
        "forms",
        "fields",
        "buttons",
    )
    parts = []
    for snapshot in iter_snapshot_dicts(payload):
        for key in keys:
            if key in snapshot:
                parts.extend(iter_text_values(snapshot[key]))
    return normalize_text(parts)


def snapshot_url(payload: dict[str, Any]) -> str:
    """Return the first URL available in the judge payload."""
    for snapshot in iter_snapshot_dicts(payload):
        url = snapshot.get("url")
        if isinstance(url, str) and url.strip():
            return url.strip().lower()
    return ""


def snapshot_items(payload: dict[str, Any], key: str) -> list[Any]:
    """Return combined top-level and nested snapshot items for a list-like key."""
    items = []
    for snapshot in iter_snapshot_dicts(payload):
        value = snapshot.get(key)
        if isinstance(value, list):
            items.extend(value)
        elif value:
            items.append(value)
    return items


def pattern_match(patterns, text: str):
    """Return the first regex match across patterns, or None."""
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match
    return None


def field_looks_fillable(field: Any) -> bool:
    """Return true when a field object looks like a user-editable form control."""
    if isinstance(field, dict):
        field_type = str(field.get("type", "")).strip().lower()
        if field_type in {"hidden", "submit", "button", "reset", "image"}:
            return False
        if field.get("disabled") is True or field.get("visible") is False:
            return False

        field_text = normalize_text(
            [
                field.get("name"),
                field.get("id"),
                field.get("label"),
                field.get("placeholder"),
                field.get("ariaLabel"),
                field.get("text"),
                field.get("selector"),
                field_type,
            ]
        )
        if any(token in field_text for token in ("captcha", "honeypot", "csrf", "nonce")):
            return False
        if field_type in {"text", "email", "url", "textarea", "tel", "number", "select", "select-one"}:
            return True
        return bool(pattern_match(FORM_FIELD_TEXT_PATTERNS, field_text))

    field_text = normalize_text(field)
    if any(token in field_text for token in ("captcha", "honeypot", "csrf", "nonce")):
        return False
    return bool(pattern_match(FORM_FIELD_TEXT_PATTERNS, field_text))


def button_looks_submit(button: Any) -> bool:
    """Return true when a button object looks like a form submission control."""
    button_text = normalize_text(button)
    return bool(SUBMIT_TEXT_PATTERN.search(button_text))


def count_fillable_fields(payload: dict[str, Any]) -> int:
    """Count visible fillable controls in fields and forms."""
    count = sum(1 for field in snapshot_items(payload, "fields") if field_looks_fillable(field))
    for form in snapshot_items(payload, "forms"):
        if not isinstance(form, dict):
            if field_looks_fillable(form):
                count += 1
            continue

        inputs = form.get("inputs") or form.get("fields") or []
        if isinstance(inputs, list):
            count += sum(1 for field in inputs if field_looks_fillable(field))
        elif field_looks_fillable(inputs):
            count += 1
    return count


def has_submit_control(payload: dict[str, Any]) -> bool:
    """Return true when the snapshot still exposes a likely submit control."""
    if any(button_looks_submit(button) for button in snapshot_items(payload, "buttons")):
        return True

    for form in snapshot_items(payload, "forms"):
        if not isinstance(form, dict):
            if button_looks_submit(form):
                return True
            continue
        if button_looks_submit(form.get("text")) or button_looks_submit(form.get("html")):
            return True
        inputs = form.get("inputs") or []
        if isinstance(inputs, list) and any(button_looks_submit(input_field) for input_field in inputs):
            return True

    return False


def has_visible_form_fields(payload: dict[str, Any], text: str) -> bool:
    """Return true when the post-submit snapshot still looks like an active form."""
    fillable_count = count_fillable_fields(payload)
    if fillable_count >= 2:
        return True
    if fillable_count >= 1 and has_submit_control(payload):
        return True
    if pattern_match(FORM_FIELD_TEXT_PATTERNS, text) and SUBMIT_TEXT_PATTERN.search(text):
        return True
    return False


def normalize_judge(judgment: dict[str, Any]) -> dict[str, Any]:
    """Return a judge response with a supported status and compact reason."""
    if not isinstance(judgment, dict):
        raise AgentError(
            "Judge response was not a JSON object",
            http_status=502,
            plan_status="needs_manual",
        )

    raw_status = str(judgment.get("status") or "").strip().lower()
    status_aliases = {
        "needs_action": "incomplete",
        "act": "incomplete",
        "failed": "blocked",
        "failure": "blocked",
        "manual": "needs_manual",
        "human": "needs_manual",
    }
    status = status_aliases.get(raw_status, raw_status)
    reason = str(judgment.get("reason") or judgment.get("message") or judgment.get("evidence") or "")[:500]

    if status not in JUDGE_STATUSES:
        reason = reason or f"Judge returned unsupported status: {raw_status or 'missing'}"
        status = "needs_manual"

    if not reason:
        reason = "Judge returned no reason"

    return {"status": status, "reason": reason}


def local_judge(payload: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Return a decisive local judgment for obvious post-submit page states."""
    if not isinstance(payload, dict):
        return None

    url = snapshot_url(payload)
    text = snapshot_text(payload)
    blocked_match = pattern_match(BLOCKED_TEXT_PATTERNS, text)
    has_form_fields = has_visible_form_fields(payload, text)
    if blocked_match:
        matched_text = blocked_match.group(0)
        status = "needs_manual" if pattern_match(MANUAL_BLOCKED_TEXT_PATTERNS, matched_text) else "blocked"
        if has_form_fields and pattern_match(FORM_OVERRIDABLE_BLOCKED_TEXT_PATTERNS, matched_text):
            return {
                "status": "incomplete",
                "reason": "Form fields are still visible after submission",
            }
        return {
            "status": status,
            "reason": f"Blocked page text matched: {matched_text}",
        }

    if has_form_fields:
        return {
            "status": "incomplete",
            "reason": "Form fields are still visible after submission",
        }

    success_url_match = pattern_match(SUCCESS_URL_PATTERNS, url)
    if success_url_match:
        return {
            "status": "success",
            "reason": f"Success URL pattern matched: {success_url_match.group(0)}",
        }

    success_text_match = pattern_match(SUCCESS_TEXT_PATTERNS, text)
    if success_text_match:
        return {
            "status": "success",
            "reason": f"Confirmation text matched: {success_text_match.group(0)}",
        }

    return None


async def handle_health(request):
    """Return basic process health and DeepSeek configuration status."""
    return web.json_response(
        {
            "status": "ok",
            "deepseek_configured": bool(get_deepseek_api_key()),
            "deepseek_base_url": DEEPSEEK_BASE_URL,
            "deepseek_model": DEEPSEEK_MODEL,
        }
    )


async def handle_plan(request):
    """Return a DeepSeek-backed action plan for a browser snapshot/task payload."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        error = AgentError(
            "Request body for /plan must be a JSON object",
            http_status=400,
            plan_status="error",
        )
        return web.json_response(
            {"status": error.plan_status, "actions": [], "message": error.message},
            status=error.http_status,
        )

    if not isinstance(payload, dict):
        return web.json_response(
            {
                "status": "error",
                "actions": [],
                "message": "Request body for /plan must be a JSON object",
            },
            status=400,
        )

    try:
        plan = await asyncio.to_thread(deepseek_chat_json, PLAN_PROMPT, payload)
        return web.json_response(normalize_plan(plan))
    except AgentError as exc:
        return web.json_response(
            {"status": exc.plan_status, "actions": [], "message": exc.message},
            status=exc.http_status,
        )


async def handle_judge(request):
    """Return a local or DeepSeek-backed success judgment for a browser snapshot."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        return web.json_response(
            {
                "status": "needs_manual",
                "message": "Request body for /judge must be a JSON object",
            },
            status=400,
        )

    if not isinstance(payload, dict):
        return web.json_response(
            {
                "status": "needs_manual",
                "message": "Request body for /judge must be a JSON object",
            },
            status=400,
        )

    local_result = local_judge(payload)
    if local_result is not None:
        return web.json_response(normalize_judge(local_result))

    try:
        judgment = await asyncio.to_thread(deepseek_chat_json, JUDGE_PROMPT, payload)
        return web.json_response(normalize_judge(judgment))
    except AgentError as exc:
        return web.json_response(
            {"status": "needs_manual", "message": exc.message},
            status=exc.http_status,
        )
    except Exception as exc:
        return web.json_response(
            {
                "status": "needs_manual",
                "message": f"Judge failed unexpectedly: {exc}",
            },
            status=500,
        )


def create_app():
    """Create and configure the aiohttp application."""
    app = web.Application()
    router = app.router
    router.add_get("/health", handle_health)
    router.add_post("/plan", handle_plan)
    router.add_post("/judge", handle_judge)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host=DEFAULT_HOST, port=DEFAULT_PORT)
