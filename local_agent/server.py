"""Local HTTP agent skeleton for browser-extension form automation."""

import asyncio
import base64
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from json import JSONDecodeError
from pathlib import Path
from typing import Any, Optional

from aiohttp import web
from dotenv import load_dotenv
import requests

try:
    from .google_sync import (
        GoogleSyncError,
        OAuthManager,
        build_sync_diff,
        push_ledger_for_oauth,
        read_snapshot_for_oauth,
        validate_sheet_id,
    )
except ImportError:  # pragma: no cover - supports `python local_agent/server.py`
    from google_sync import (  # type: ignore
        GoogleSyncError,
        OAuthManager,
        build_sync_diff,
        push_ledger_for_oauth,
        read_snapshot_for_oauth,
        validate_sheet_id,
    )


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = int(os.getenv("LOCAL_AGENT_PORT", "8790"))
CHAT_COMPLETIONS_PATH = "/chat/completions"
DEEPSEEK_TIMEOUT_SECONDS = 45

load_dotenv()

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-pro")
MEDIA_ROOT = Path(
    os.getenv("EXTERNALLINK_MEDIA_ROOT", "/Users/syndred/Desktop/projects/media")
).expanduser()
MEDIA_EXTENSIONS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}
MEDIA_MAX_BYTES = 8 * 1024 * 1024

COMMENT_MAX_DRAFTS = 5
COMMENT_DEFAULT_MAX_CHARS = 700
COMMENT_HARD_MAX_CHARS = 2000

RDAP_ENDPOINT = os.getenv("RDAP_ENDPOINT", "https://rdap.org/domain")
RDAP_TIMEOUT_SECONDS = 12
DOMAIN_METRICS_CACHE_TTL_SECONDS = 7 * 24 * 3600
_DOMAIN_METRICS_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}

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

PLAN_PROMPT = """You plan browser actions for a local browser extension that automatically fills and submits backlink/directory/product listing forms.

Goal: analyze the page snapshot, fill all relevant fields using config, then submit the form.
Each website has different field names and layout — infer the correct mapping from labels, placeholders, names, and nearby visible text.

Config includes:
- targetDomain, brandName, anchorText, email, username, commentTemplate, tags, pricing, note
- anchorRules: brandKeywords, urlKeywords, naturalExpressions, keywordExpressions — prefer naturalExpressions for comment/blog anchor text rotation
- blogRules: tone, maxLinksPerDraft, preferredAnchor
- projectFields: a dictionary of ALL product copy from the user's spreadsheet (Name, Url, Title, descriptions, tags, pricing, social links, etc.). Match form labels to the closest projectFields key and use that value. Prefer shorter fields for short inputs and longer fields for description/bio textareas.
- CRITICAL: Respect each field's maxlength, minlength, and word/character limits from the snapshot constraints. Never exceed maxLength. For question-style fields ("What made you choose", "Why did you pick", shoutout/review/testimonial), write 1-3 concise sentences answering the question — do NOT paste the full long product description.
- For <select> fields, the snapshot includes an "options" array — use type "select" with the option value or visible label. For category/industry dropdowns pick the closest match to config tags or "SaaS"/"AI"/"Software". For pricing pick Freemium/Free/Paid based on config.

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
Use "needs_manual" when login/sign-in is required, CAPTCHA/human verification is visible, email OTP is required, or the user must choose between ambiguous options.
Use "blocked" when the page cannot be handled safely.
When the form is ready and no human gate is present, include a submit action (type "submit" or click the submit button) to complete the submission automatically.
If the landing page has no form, click the best "Submit", "Add product", "List your tool", or similar link first, then fill on the next page.
"""

VALIDATE_FILL_PROMPT = """You review filled form field values on backlink/directory/product listing sites BEFORE the user submits.

You receive:
- filledFields: array of fields with label, value, length, wordCount, constraints (maxLength, maxWords, etc.), and any detected issues
- config: brandName, targetDomain, projectFields with short/long descriptions
- snapshot: page context

For EACH field that violates limits or mismatches intent, return a corrected value in "fields".
Rules:
- NEVER exceed maxLength or maxWords from constraints
- Question fields ("What made you choose", "Why did you pick", shoutout/review/testimonial, "alternatives you considered") need a direct 1-3 sentence answer about why the user chose this product — NOT the full long description
- Short inputs (title, tagline) use Title or brandName
- Description textareas use the appropriately sized description from projectFields
- Trim gracefully at word boundaries; end with proper punctuation
- If all fields are valid, return status "ok" with empty fields array

Return only strict JSON:
{
  "status": "ok" | "revise",
  "submitReady": true | false,
  "fields": [
    {"selector": "exact selector from filledFields", "value": "corrected text", "reason": "brief reason"}
  ],
  "issues": ["remaining blocker if submitReady is false"]
}
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

EXTRACT_SITE_PROMPT = """You analyze a website from fetched page content and extract structured marketing/submission metadata.

Return only one strict JSON object with this shape:
{
  "fields": {
    "Name": "brand or product name",
    "Url": "canonical homepage URL with https://",
    "Title": "SEO title or tagline",
    "Business mail": "support or contact email if visible, else empty string",
    "Note": "one-sentence product summary",
    "Short description(20-30 words)": "concise elevator pitch",
    "Short Discription(100-150 words)": "medium marketing description",
    "Long description (250-500 words)": "detailed product description for directory listings",
    "Tags Keywords/Hashtags": "comma-separated SEO keywords and optional hashtags",
    "Feature description": "bullet-style feature list as a single string",
    "Featured image": "absolute or relative URL to logo/featured image",
    "Pricing": "pricing summary if visible",
    "PRICING TYPE": "e.g. Free, Freemium, Subscription, Paid"
  },
  "anchorRules": {
    "brandKeywords": ["brand name variants, one per concept"],
    "urlKeywords": ["https URL and bare domain"],
    "naturalExpressions": ["natural phrases for contextual mentions in comments/blogs"],
    "keywordExpressions": ["SEO keyword phrases related to the product"],
    "avoidWords": ["spammy phrases to avoid, e.g. click here"]
  },
  "blogRules": {
    "tone": "helpful | professional | casual | enthusiastic",
    "maxLinksPerDraft": 1,
    "preferredAnchor": "natural | brand | keyword | url"
  },
  "targetAudience": "who the product is for",
  "valueProposition": "core value in one paragraph",
  "useCases": ["specific use case 1", "use case 2"],
  "sellablePoints": ["key selling point 1", "key selling point 2"],
  "avoidContent": ["topics or claims to avoid in generated copy"]
}

Rules:
- Infer from page title, meta tags, headings, and body text only; do not invent features not supported by the content.
- Write marketing copy in the requested language (payload.language). Use "auto" to match the page's primary language.
- naturalExpressions should be varied phrases suitable for blog comments, not repetitive brand spam.
- keywordExpressions should be realistic SEO phrases for this product category.
- If information is missing, use empty string for text fields or empty arrays for lists.
"""

GENERATE_SITE_PROMPT = """You refine and expand partial website submission metadata for backlink/directory automation.

The user already has some fields filled in. Improve completeness, consistency, and marketing quality while staying truthful to supplied data.

Return the same JSON shape as extract-site:
{
  "fields": { ... same keys as extract ... },
  "anchorRules": { ... },
  "blogRules": { ... },
  "targetAudience": "...",
  "valueProposition": "...",
  "useCases": [...],
  "sellablePoints": [...],
  "avoidContent": [...]
}

Keep existing accurate values; expand thin sections; align tone with payload.language.
Do not invent pricing, emails, or features absent from the input unless clearly implied.
"""

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

COMMENT_PROMPT = """You write blog/forum comments that a real, knowledgeable reader would leave on the supplied page.

You receive:
- pageTitle, pageUrl, pageText: the article or thread the comment replies to
- config: brandName, targetDomain, anchorRules (naturalExpressions, keywordExpressions, avoidWords), blogRules (tone, preferredAnchor), targetAudience, valueProposition, useCases, sellablePoints, avoidContent
- count: how many distinct drafts to return
- maxChars: hard character cap per draft
- allowLink: whether a promotional link may appear at all
- language: "auto" to match the page language, otherwise the requested language

Hard rules:
- React to something SPECIFIC in pageText: a claim, number, example, tool, or trade-off the author actually mentioned. Quote or paraphrase it. A comment that would fit any article is a failure.
- Never open with "Great post", "Nice article", "Thanks for sharing", "Interesting read", or any other generic compliment.
- Add something the article did not say: a caveat, a counter-example, your own numbers, a failure mode, or a follow-up question that shows you read it.
- Write like a practitioner, not a marketer. No hype adjectives, no exclamation chains, no emoji unless the page itself uses them.
- Vary sentence length. Two to five sentences per draft is usually right.
- Each draft must be materially different from the others: a different angle, not a reworded version of the same point.
- Match blogRules.tone. Match the page's language when language is "auto".
- Respect maxChars strictly. Respect avoidWords and avoidContent absolutely.

Link rules:
- If allowLink is false, produce NO link and NO brand mention. Set anchorText and anchorUrl to "".
- If allowLink is true, mention the product only when it is genuinely relevant to the specific point you are making. Otherwise still return an empty anchorText — a linkless on-topic comment is far better than a forced plug.
- When you do link: keep it to ONE link, use targetDomain as anchorUrl, and pick anchorText from anchorRules.naturalExpressions or write a similarly natural phrase. Never use "click here", "check this out", bare URLs, or exact-match keyword spam.
- Put the mention inside a sentence that carries real information ("we hit the same problem and ended up building X to batch it"), never as a trailing advertisement.
- Set "placement" to "body" when the link sits inside the text, or "url_field" when the link belongs in the comment form's separate website/URL field instead of the body. Prefer "url_field" when the form has one, because comment bodies with links are more likely to be flagged as spam.

Return only one strict JSON object:
{
  "status": "ok" | "skip",
  "drafts": [
    {"text": "comment body", "anchorText": "", "anchorUrl": "", "placement": "body" | "url_field", "angle": "short label for this draft's angle"}
  ],
  "reason": "short explanation"
}

Use "skip" with an empty drafts array when pageText is too thin, unreadable, or off-topic to comment on honestly, or when the page is a login wall, error page, or pure navigation.
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


_GOOGLE_OAUTH_MANAGER: Optional[OAuthManager] = None


def get_google_oauth_manager() -> OAuthManager:
    """Return the process-local Google OAuth manager.

    The manager keeps only short-lived OAuth state in memory.  Authorized
    credentials are persisted by its keyring-first token store, never in the
    extension or in the repository.
    """
    global _GOOGLE_OAUTH_MANAGER
    if _GOOGLE_OAUTH_MANAGER is None:
        _GOOGLE_OAUTH_MANAGER = OAuthManager()
    return _GOOGLE_OAUTH_MANAGER


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


def normalize_validate_fill(result: dict[str, Any]) -> dict[str, Any]:
    """Return a safe validate-fill response."""
    if not isinstance(result, dict):
        raise AgentError("Validate-fill response was not a JSON object", http_status=502)

    status = str(result.get("status") or "revise").strip().lower()
    if status not in {"ok", "revise"}:
        status = "revise"

    raw_fields = result.get("fields", [])
    if not isinstance(raw_fields, list):
        raw_fields = []

    fields = []
    for item in raw_fields:
        if not isinstance(item, dict):
            continue
        selector = normalize_selector(item.get("selector"))
        if not selector or "value" not in item:
            continue
        fields.append(
            {
                "selector": selector,
                "value": str(item.get("value") or ""),
                "reason": str(item.get("reason") or "")[:200],
            }
        )

    issues = result.get("issues", [])
    if not isinstance(issues, list):
        issues = []
    issues = [str(i)[:300] for i in issues if i]

    submit_ready = bool(result.get("submitReady", status == "ok" and not fields))
    if fields:
        status = "revise"
    elif status != "ok":
        submit_ready = False

    return {
        "status": status,
        "submitReady": submit_ready,
        "fields": fields,
        "issues": issues,
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
            "media_root": str(MEDIA_ROOT),
            "media_root_exists": MEDIA_ROOT.is_dir(),
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


FETCH_TIMEOUT_SECONDS = 20
FETCH_MAX_BYTES = 500_000
FETCH_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


def strip_html(html: str) -> str:
    """Return rough visible text from HTML, capped for LLM context."""
    if not html:
        return ""
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    text = re.sub(r"(?is)<!--.*?-->", " ", text)
    text = re.sub(r"(?i)<title[^>]*>(.*?)</title>", r" TITLE: \1 ", text)
    for tag in ("h1", "h2", "h3", "meta", "link"):
        text = re.sub(rf"(?is)<{tag}[^>]*>(.*?)</{tag}>", rf" {tag.upper()}: \1 ", text)
    text = re.sub(r"(?is)<meta[^>]+>", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:12000]


def fetch_page_text(url: str) -> dict[str, str]:
    """Fetch a URL and return title plus flattened visible text."""
    if not isinstance(url, str) or not url.strip():
        raise AgentError("url is required", http_status=400, plan_status="error")

    normalized = url.strip()
    if not normalized.startswith(("http://", "https://")):
        normalized = f"https://{normalized.lstrip('/')}"

    try:
        response = requests.get(
            normalized,
            headers={"User-Agent": FETCH_USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
            timeout=FETCH_TIMEOUT_SECONDS,
            allow_redirects=True,
        )
    except requests.RequestException as exc:
        raise AgentError(f"Failed to fetch URL: {exc}", http_status=502, plan_status="error") from exc

    if not 200 <= response.status_code < 400:
        raise AgentError(
            f"URL fetch returned HTTP {response.status_code}",
            http_status=502,
            plan_status="error",
        )

    content_type = (response.headers.get("Content-Type") or "").lower()
    if "html" not in content_type and "text/" not in content_type:
        raise AgentError(
            f"Unsupported content type: {content_type or 'unknown'}",
            http_status=400,
            plan_status="error",
        )

    raw = response.content[:FETCH_MAX_BYTES]
    encoding = response.encoding or "utf-8"
    try:
        html = raw.decode(encoding, errors="replace")
    except LookupError:
        html = raw.decode("utf-8", errors="replace")

    final_url = (response.url or normalized).strip()
    title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    title = re.sub(r"\s+", " ", title_match.group(1)).strip() if title_match else ""
    return {
        "requestedUrl": normalized,
        "finalUrl": final_url,
        "title": title,
        "text": strip_html(html),
    }


def normalize_string_list(value: Any, *, limit: int = 12) -> list[str]:
    """Return a trimmed list of non-empty strings."""
    if isinstance(value, str):
        items = [part.strip() for part in re.split(r"[\n,;]+", value) if part.strip()]
    elif isinstance(value, list):
        items = [str(item).strip() for item in value if str(item).strip()]
    else:
        items = []
    deduped = []
    seen = set()
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
        if len(deduped) >= limit:
            break
    return deduped


def normalize_site_profile(raw: dict[str, Any], *, source_url: str = "") -> dict[str, Any]:
    """Normalize extract/generate output into a stable site profile object."""
    fields_raw = raw.get("fields") if isinstance(raw.get("fields"), dict) else raw
    if not isinstance(fields_raw, dict):
        fields_raw = {}

    field_keys = (
        "Name",
        "Url",
        "Title",
        "Business mail",
        "Note",
        "Short description(20-30 words)",
        "Short Discription(100-150 words)",
        "Long description (250-500 words)",
        "Tags Keywords/Hashtags",
        "Feature description",
        "Featured image",
        "Pricing",
        "PRICING TYPE",
    )
    fields = {key: str(fields_raw.get(key) or "").strip() for key in field_keys}

    url = fields.get("Url") or source_url
    if url and not url.startswith("http"):
        url = f"https://{url.lstrip('/')}"
    if url:
        fields["Url"] = url

    anchor_raw = raw.get("anchorRules") if isinstance(raw.get("anchorRules"), dict) else {}
    blog_raw = raw.get("blogRules") if isinstance(raw.get("blogRules"), dict) else {}

    tone = str(blog_raw.get("tone") or "helpful").strip().lower()
    if tone not in {"helpful", "professional", "casual", "enthusiastic"}:
        tone = "helpful"

    preferred = str(blog_raw.get("preferredAnchor") or "natural").strip().lower()
    if preferred not in {"natural", "brand", "keyword", "url"}:
        preferred = "natural"

    try:
        max_links = int(blog_raw.get("maxLinksPerDraft", 1))
    except (TypeError, ValueError):
        max_links = 1
    max_links = max(1, min(max_links, 5))

    return {
        "fields": fields,
        "anchorRules": {
            "brandKeywords": normalize_string_list(anchor_raw.get("brandKeywords")),
            "urlKeywords": normalize_string_list(anchor_raw.get("urlKeywords")),
            "naturalExpressions": normalize_string_list(anchor_raw.get("naturalExpressions"), limit=8),
            "keywordExpressions": normalize_string_list(anchor_raw.get("keywordExpressions"), limit=10),
            "avoidWords": normalize_string_list(anchor_raw.get("avoidWords"), limit=8),
            "allowExactMatch": bool(anchor_raw.get("allowExactMatch")),
        },
        "blogRules": {
            "tone": tone,
            "maxLinksPerDraft": max_links,
            "preferredAnchor": preferred,
        },
        "targetAudience": str(raw.get("targetAudience") or "").strip(),
        "valueProposition": str(raw.get("valueProposition") or "").strip(),
        "useCases": normalize_string_list(raw.get("useCases"), limit=8),
        "sellablePoints": normalize_string_list(raw.get("sellablePoints"), limit=10),
        "avoidContent": normalize_string_list(raw.get("avoidContent"), limit=8),
    }


async def handle_extract_site(request):
    """Fetch a URL and extract structured site metadata with DeepSeek."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        return web.json_response(
            {"status": "error", "message": "Request body must be a JSON object"},
            status=400,
        )

    if not isinstance(payload, dict):
        return web.json_response(
            {"status": "error", "message": "Request body must be a JSON object"},
            status=400,
        )

    url = payload.get("url")
    language = str(payload.get("language") or "auto").strip() or "auto"

    try:
        page = await asyncio.to_thread(fetch_page_text, url)
        llm_payload = {
            "language": language,
            "requestedUrl": page["requestedUrl"],
            "finalUrl": page["finalUrl"],
            "pageTitle": page["title"],
            "pageText": page["text"],
        }
        extracted = await asyncio.to_thread(deepseek_chat_json, EXTRACT_SITE_PROMPT, llm_payload)
        profile = normalize_site_profile(extracted, source_url=page["finalUrl"])
        return web.json_response({"status": "ok", "profile": profile, "source": page})
    except AgentError as exc:
        return web.json_response(
            {"status": "error", "message": exc.message},
            status=exc.http_status,
        )


async def handle_generate_site(request):
    """Expand/refine partial site metadata with DeepSeek."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        return web.json_response(
            {"status": "error", "message": "Request body must be a JSON object"},
            status=400,
        )

    if not isinstance(payload, dict):
        return web.json_response(
            {"status": "error", "message": "Request body must be a JSON object"},
            status=400,
        )

    profile = payload.get("profile")
    if not isinstance(profile, dict):
        return web.json_response(
            {"status": "error", "message": "profile object is required"},
            status=400,
        )

    language = str(payload.get("language") or "auto").strip() or "auto"

    try:
        generated = await asyncio.to_thread(
            deepseek_chat_json,
            GENERATE_SITE_PROMPT,
            {"language": language, "profile": profile},
        )
        normalized = normalize_site_profile(
            generated,
            source_url=str(profile.get("fields", {}).get("Url") or profile.get("url") or ""),
        )
        return web.json_response({"status": "ok", "profile": normalized})
    except AgentError as exc:
        return web.json_response(
            {"status": "error", "message": exc.message},
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


async def handle_validate_fill(request):
    """Review filled form values and return corrections that respect field constraints."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        return web.json_response(
            {"status": "error", "submitReady": False, "fields": [], "issues": ["Invalid JSON body"]},
            status=400,
        )

    if not isinstance(payload, dict):
        return web.json_response(
            {"status": "error", "submitReady": False, "fields": [], "issues": ["Payload must be object"]},
            status=400,
        )

    try:
        result = await asyncio.to_thread(deepseek_chat_json, VALIDATE_FILL_PROMPT, payload)
        return web.json_response(normalize_validate_fill(result))
    except AgentError as exc:
        return web.json_response(
            {
                "status": "error",
                "submitReady": False,
                "fields": [],
                "issues": [exc.message],
            },
            status=exc.http_status,
        )


async def _read_request_object(request, *, error_message: str = "Request body must be a JSON object"):
    """Parse a JSON request body for the Google endpoints."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        return None, web.json_response({"status": "error", "message": error_message}, status=400)
    if not isinstance(payload, dict):
        return None, web.json_response({"status": "error", "message": error_message}, status=400)
    return payload, None


def _google_error_response(error: GoogleSyncError):
    return web.json_response(
        {"status": "error", "message": error.message},
        status=error.http_status,
    )


async def handle_google_status(request):
    """Return local Google configuration/auth status without exposing tokens."""
    try:
        status = get_google_oauth_manager().status()
        return web.json_response({"status": "ok", **status})
    except GoogleSyncError as exc:
        return _google_error_response(exc)


async def handle_google_auth_start(request):
    """Create a loopback Google OAuth URL for the user to approve."""
    try:
        result = await asyncio.to_thread(get_google_oauth_manager().start)
        if result.get("authorizationUrl") and not result.get("authUrl"):
            result["authUrl"] = result["authorizationUrl"]
        return web.json_response({"status": "ok", **result})
    except GoogleSyncError as exc:
        return _google_error_response(exc)


async def handle_google_auth_callback(request):
    """Finish OAuth in the local browser tab without returning credentials."""
    query = getattr(request, "query", {})
    error = str(query.get("error", "") or "").strip()
    if error:
        message = "Google OAuth 被取消或拒绝授权"
        return web.Response(
            text=(
                "<!doctype html><meta charset='utf-8'><title>ExternalLink OAuth</title>"
                f"<p>{message}</p><p>可以关闭此标签页并回到 ExternalLink。</p>"
            ),
            content_type="text/html",
            status=400,
        )

    state = str(query.get("state", "") or "").strip()
    code = str(query.get("code", "") or "").strip()
    try:
        await asyncio.to_thread(get_google_oauth_manager().complete, state=state, code=code)
    except GoogleSyncError as exc:
        return web.Response(
            text=(
                "<!doctype html><meta charset='utf-8'><title>ExternalLink OAuth</title>"
                f"<p>授权失败：{exc.message}</p><p>可以关闭此标签页后重新连接。</p>"
            ),
            content_type="text/html",
            status=exc.http_status,
        )
    return web.Response(
        text=(
            "<!doctype html><meta charset='utf-8'><title>ExternalLink OAuth</title>"
            "<p>ExternalLink 已完成 Google 授权。</p>"
            "<p>可以关闭此标签页并回到扩展设置。</p>"
        ),
        content_type="text/html",
    )


async def handle_google_sync_preview(request):
    """Read the configured sheet and return a pull diff for the extension."""
    payload, response = await _read_request_object(request)
    if response is not None:
        return response
    try:
        spreadsheet_id = payload.get("spreadsheetId")
        validate_sheet_id(spreadsheet_id)
        remote = await asyncio.to_thread(
            read_snapshot_for_oauth,
            get_google_oauth_manager(),
            spreadsheet_id=spreadsheet_id,
        )
        return web.json_response(
            {
                "status": "ok",
                "spreadsheetId": remote.get("spreadsheetId"),
                "snapshot": remote,
                "snapshotHash": remote.get("hash", ""),
                "diff": build_sync_diff(payload.get("localSnapshot"), remote),
            }
        )
    except GoogleSyncError as exc:
        return _google_error_response(exc)
    except Exception as exc:  # noqa: BLE001 - keep the local API JSON-shaped
        return web.json_response(
            {"status": "error", "message": f"Google Sheet 预览失败: {exc}"},
            status=502,
        )


async def handle_google_ledger_push(request):
    """Append/update only explicit success records in the Sheet records tab."""
    payload, response = await _read_request_object(request)
    if response is not None:
        return response
    records = payload.get("records")
    if not isinstance(records, list):
        return web.json_response(
            {"status": "error", "message": "records must be an array"},
            status=400,
        )
    try:
        spreadsheet_id = payload.get("spreadsheetId")
        validate_sheet_id(spreadsheet_id)
        result = await asyncio.to_thread(
            push_ledger_for_oauth,
            get_google_oauth_manager(),
            records=records,
            spreadsheet_id=spreadsheet_id,
            base_hash=str(payload.get("baseHash") or ""),
        )
        if "pushedKeys" not in result:
            result["pushedKeys"] = [
                *(result.get("applied") or []),
                *(result.get("alreadyApplied") or []),
            ]
        return web.json_response({"status": "ok", **result})
    except GoogleSyncError as exc:
        return _google_error_response(exc)
    except Exception as exc:  # noqa: BLE001 - keep the local API JSON-shaped
        return web.json_response(
            {"status": "error", "message": f"Google Sheet 回写失败: {exc}"},
            status=502,
        )


async def handle_google_disconnect(request):
    """Forget local Google credentials and pending OAuth state."""
    try:
        result = await asyncio.to_thread(get_google_oauth_manager().disconnect)
        return web.json_response({"status": "ok", **result})
    except GoogleSyncError as exc:
        return _google_error_response(exc)


GENERIC_COMMENT_OPENERS = (
    re.compile(r"^\s*(?:great|nice|good|excellent|awesome|amazing|wonderful|solid|interesting)\b[^.!?]{0,40}(?:post|article|write[- ]?up|read|insight|content|breakdown|analysis)", re.I),
    re.compile(r"^\s*thanks?\s+(?:so much\s+)?for\s+(?:sharing|this|posting|putting)", re.I),
    re.compile(r"^\s*(?:this is )?(?:exactly|just)\s+what\s+i\s+(?:was|needed)", re.I),
    re.compile(r"^\s*(?:very|really)\s+(?:informative|helpful|useful)\b", re.I),
    re.compile(r"^\s*(?:i )?(?:really )?(?:love|loved|enjoyed)\s+(?:this|your)\b", re.I),
)

SPAM_ANCHOR_PATTERNS = (
    re.compile(r"^\s*click\s+here\s*$", re.I),
    re.compile(r"^\s*(?:check|read)\s+(?:this|it)\s+out\s*$", re.I),
    re.compile(r"^\s*here\s*$", re.I),
    re.compile(r"^\s*https?://", re.I),
    re.compile(r"^\s*www\.", re.I),
)


def trim_to_chars(text: str, limit: int) -> str:
    """Trim text to a character budget at a sentence or word boundary."""
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if limit <= 0 or len(clean) <= limit:
        return clean

    window = clean[:limit]
    sentence_end = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
    if sentence_end >= limit * 0.5:
        return window[: sentence_end + 1].strip()

    word_end = window.rfind(" ")
    trimmed = window[:word_end] if word_end >= limit * 0.5 else window
    return trimmed.rstrip(" ,;:-") + "."


def looks_generic_comment(text: str) -> bool:
    """Return True when a draft opens with a template-style generic compliment."""
    return any(pattern.search(text) for pattern in GENERIC_COMMENT_OPENERS)


def normalize_comment_drafts(
    raw: dict[str, Any],
    *,
    max_chars: int,
    allow_link: bool,
    count: int,
    avoid_words: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Validate and clean DeepSeek comment drafts before the extension uses them."""
    status = str(raw.get("status") or "ok").strip().lower()
    if status not in {"ok", "skip"}:
        status = "ok"

    reason = str(raw.get("reason") or "").strip()[:400]
    raw_drafts = raw.get("drafts")
    if not isinstance(raw_drafts, list):
        raw_drafts = []

    banned = [word.strip().lower() for word in (avoid_words or []) if str(word).strip()]
    drafts: list[dict[str, Any]] = []
    rejected: list[str] = []
    seen: set[str] = set()

    for item in raw_drafts:
        if not isinstance(item, dict):
            continue
        text = trim_to_chars(item.get("text"), max_chars)
        if len(text) < 40:
            rejected.append("too short")
            continue
        if looks_generic_comment(text):
            rejected.append("generic opener")
            continue

        lowered = text.lower()
        hit = next((word for word in banned if word in lowered), None)
        if hit:
            rejected.append(f"contains avoided word: {hit}")
            continue

        dedupe_key = re.sub(r"[^a-z0-9]+", "", lowered)[:120]
        if dedupe_key in seen:
            rejected.append("duplicate draft")
            continue
        seen.add(dedupe_key)

        anchor_text = re.sub(r"\s+", " ", str(item.get("anchorText") or "")).strip()[:120]
        anchor_url = str(item.get("anchorUrl") or "").strip()[:300]
        placement = str(item.get("placement") or "url_field").strip().lower()
        if placement not in {"body", "url_field"}:
            placement = "url_field"

        if not allow_link:
            anchor_text = ""
            anchor_url = ""
            placement = "url_field"
        else:
            if anchor_text and any(p.search(anchor_text) for p in SPAM_ANCHOR_PATTERNS):
                anchor_text = ""
            if anchor_url and not anchor_url.startswith(("http://", "https://")):
                anchor_url = f"https://{anchor_url.lstrip('/')}"
            if not anchor_text:
                anchor_url = ""

        drafts.append(
            {
                "text": text,
                "anchorText": anchor_text,
                "anchorUrl": anchor_url if anchor_text else "",
                "placement": placement,
                "angle": re.sub(r"\s+", " ", str(item.get("angle") or "")).strip()[:80],
                "chars": len(text),
            }
        )
        if len(drafts) >= count:
            break

    if not drafts:
        status = "skip"
        if not reason:
            reason = "No draft survived validation: " + (
                ", ".join(dict.fromkeys(rejected)) if rejected else "model returned no drafts"
            )

    return {
        "status": status,
        "drafts": drafts,
        "reason": reason,
        "rejected": list(dict.fromkeys(rejected))[:8],
    }


async def handle_comment(request):
    """Return page-aware comment drafts for blog/forum backlink placement."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        return web.json_response(
            {"status": "error", "drafts": [], "message": "Request body must be a JSON object"},
            status=400,
        )

    if not isinstance(payload, dict):
        return web.json_response(
            {"status": "error", "drafts": [], "message": "Request body must be a JSON object"},
            status=400,
        )

    page_text = normalize_text(payload.get("pageText"))
    if len(page_text) < 120:
        return web.json_response(
            {
                "status": "skip",
                "drafts": [],
                "reason": "Page text too thin to write an on-topic comment",
            }
        )

    config = payload.get("config") if isinstance(payload.get("config"), dict) else {}
    anchor_rules = config.get("anchorRules") if isinstance(config.get("anchorRules"), dict) else {}
    avoid_words = [
        *normalize_string_list(anchor_rules.get("avoidWords")),
        *normalize_string_list(config.get("avoidContent")),
    ]

    try:
        count = max(1, min(int(payload.get("count", 1)), COMMENT_MAX_DRAFTS))
    except (TypeError, ValueError):
        count = 1
    try:
        max_chars = int(payload.get("maxChars") or COMMENT_DEFAULT_MAX_CHARS)
    except (TypeError, ValueError):
        max_chars = COMMENT_DEFAULT_MAX_CHARS
    max_chars = max(120, min(max_chars, COMMENT_HARD_MAX_CHARS))
    allow_link = payload.get("allowLink") is not False

    llm_payload = {
        "language": str(payload.get("language") or "auto").strip() or "auto",
        "pageTitle": normalize_text(payload.get("pageTitle"))[:300],
        "pageUrl": str(payload.get("pageUrl") or "")[:500],
        "pageText": page_text[:9000],
        "count": count,
        "maxChars": max_chars,
        "allowLink": allow_link,
        "config": {
            "brandName": str(config.get("brandName") or ""),
            "targetDomain": str(config.get("targetDomain") or ""),
            "anchorRules": anchor_rules,
            "blogRules": config.get("blogRules") if isinstance(config.get("blogRules"), dict) else {},
            "targetAudience": str(config.get("targetAudience") or ""),
            "valueProposition": str(config.get("valueProposition") or ""),
            "useCases": normalize_string_list(config.get("useCases")),
            "sellablePoints": normalize_string_list(config.get("sellablePoints")),
            "avoidContent": normalize_string_list(config.get("avoidContent")),
        },
    }

    try:
        result = await asyncio.to_thread(deepseek_chat_json, COMMENT_PROMPT, llm_payload)
        return web.json_response(
            normalize_comment_drafts(
                result,
                max_chars=max_chars,
                allow_link=allow_link,
                count=count,
                avoid_words=avoid_words,
            )
        )
    except AgentError as exc:
        return web.json_response(
            {"status": "error", "drafts": [], "message": exc.message},
            status=exc.http_status,
        )


def media_profile_dir(profile: str) -> Path:
    """Resolve a profile media directory, refusing anything outside MEDIA_ROOT."""
    token = str(profile or "").strip()
    if not token or token in {".", ".."} or "/" in token or "\\" in token:
        raise AgentError("profile is invalid", http_status=400, plan_status="error")

    root = MEDIA_ROOT.resolve()
    candidate = (root / token).resolve()
    if candidate != root and root not in candidate.parents:
        raise AgentError("profile escapes the media root", http_status=400, plan_status="error")
    return candidate


def classify_media_name(name: str) -> str:
    """Label a media filename as logo, screenshot, or other."""
    stem = Path(name).stem.lower()
    if "logo" in stem or "icon" in stem or "avatar" in stem:
        return "logo"
    # Screenshots are stored as an ordered `NN` prefix, optionally with a label: 01-home.png
    if re.match(r"^\d{1,2}(?:[-_.\s]|$)", stem) or "screenshot" in stem or "screen" in stem:
        return "screenshot"
    return "other"


def list_media_profiles() -> list[dict[str, Any]]:
    """Return the local media library grouped by profile directory."""
    root = MEDIA_ROOT.resolve()
    if not root.is_dir():
        return []

    profiles = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        files = []
        for item in sorted(entry.iterdir()):
            if not item.is_file() or item.name.startswith("."):
                continue
            suffix = item.suffix.lower()
            if suffix not in MEDIA_EXTENSIONS:
                continue
            try:
                size = item.stat().st_size
            except OSError:
                continue
            files.append(
                {
                    "name": item.name,
                    "kind": classify_media_name(item.name),
                    "mime": MEDIA_EXTENSIONS[suffix],
                    "bytes": size,
                }
            )
        if files:
            profiles.append({"profile": entry.name, "files": files})
    return profiles


async def handle_media_list(request):
    """List locally available submission media without exposing absolute paths."""
    try:
        profiles = await asyncio.to_thread(list_media_profiles)
    except OSError as exc:
        return web.json_response(
            {"status": "error", "message": f"Failed to read media root: {exc}"},
            status=500,
        )
    return web.json_response(
        {
            "status": "ok",
            "mediaRoot": str(MEDIA_ROOT),
            "mediaRootExists": MEDIA_ROOT.is_dir(),
            "profiles": profiles,
        }
    )


def read_media_file(profile: str, name: str, kind: str, index: int) -> dict[str, Any]:
    """Return one media file as base64 bytes, resolved by name or by kind+index."""
    directory = media_profile_dir(profile)
    if not directory.is_dir():
        raise AgentError(f"No local media for profile {profile}", http_status=404, plan_status="error")

    requested = str(name or "").strip()
    if requested:
        if "/" in requested or "\\" in requested or requested.startswith("."):
            raise AgentError("name is invalid", http_status=400, plan_status="error")
        target = (directory / requested).resolve()
        if target.parent != directory or not target.is_file():
            raise AgentError(f"Media file not found: {requested}", http_status=404, plan_status="error")
    else:
        wanted = str(kind or "logo").strip().lower()
        candidates = [
            item
            for item in sorted(directory.iterdir())
            if item.is_file()
            and item.suffix.lower() in MEDIA_EXTENSIONS
            and classify_media_name(item.name) == wanted
        ]
        if wanted == "logo":
            # Raster logos upload more reliably than SVG on directory forms.
            candidates.sort(key=lambda item: item.suffix.lower() == ".svg")
        if not candidates:
            raise AgentError(
                f"No {wanted} media for profile {profile}", http_status=404, plan_status="error"
            )
        position = max(0, index)
        target = candidates[position] if position < len(candidates) else candidates[0]

    suffix = target.suffix.lower()
    if suffix not in MEDIA_EXTENSIONS:
        raise AgentError("Unsupported media type", http_status=400, plan_status="error")

    size = target.stat().st_size
    if size > MEDIA_MAX_BYTES:
        raise AgentError(
            f"Media file exceeds {MEDIA_MAX_BYTES // (1024 * 1024)}MB", http_status=413, plan_status="error"
        )

    mime = MEDIA_EXTENSIONS[suffix]
    encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    return {
        "status": "ok",
        "profile": profile,
        "name": target.name,
        "kind": classify_media_name(target.name),
        "mime": mime,
        "bytes": size,
        "dataUrl": f"data:{mime};base64,{encoded}",
    }


async def handle_media_file(request):
    """Return one local media file as a data URL for DataTransfer upload injection."""
    query = getattr(request, "query", {})
    try:
        index = int(query.get("index", 0) or 0)
    except (TypeError, ValueError):
        index = 0

    try:
        result = await asyncio.to_thread(
            read_media_file,
            str(query.get("profile", "") or ""),
            str(query.get("name", "") or ""),
            str(query.get("kind", "logo") or "logo"),
            index,
        )
        return web.json_response(result)
    except AgentError as exc:
        return web.json_response({"status": "error", "message": exc.message}, status=exc.http_status)
    except OSError as exc:
        return web.json_response(
            {"status": "error", "message": f"Failed to read media file: {exc}"},
            status=500,
        )


def normalize_domain(value: str) -> str:
    """Reduce a URL or hostname to a bare registrable-looking domain."""
    raw = str(value or "").strip().lower()
    if not raw:
        raise AgentError("domain is required", http_status=400, plan_status="error")
    raw = re.sub(r"^[a-z][a-z0-9+.-]*://", "", raw)
    raw = raw.split("/")[0].split("?")[0].split("#")[0]
    raw = raw.split("@")[-1].split(":")[0]
    raw = raw.strip(".")
    if raw.startswith("www."):
        raw = raw[4:]
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", raw):
        raise AgentError(f"domain is invalid: {value}", http_status=400, plan_status="error")
    return raw


def registrable_domain(domain: str) -> str:
    """Return a best-effort registrable domain for RDAP lookups."""
    parts = domain.split(".")
    if len(parts) <= 2:
        return domain
    # Handle common two-label public suffixes (co.uk, com.cn, com.au, ...).
    if len(parts[-2]) <= 3 and parts[-2] in {"co", "com", "net", "org", "gov", "edu", "ac"}:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def parse_rdap_events(payload: dict[str, Any]) -> dict[str, str]:
    """Extract registration/expiry dates from an RDAP domain response."""
    events = payload.get("events")
    found: dict[str, str] = {}
    if not isinstance(events, list):
        return found
    for event in events:
        if not isinstance(event, dict):
            continue
        action = str(event.get("eventAction") or "").strip().lower()
        date = str(event.get("eventDate") or "").strip()
        if action and date and action not in found:
            found[action] = date
    return found


def parse_rdap_datetime(value: str) -> Optional[datetime]:
    """Parse an RDAP event date, tolerating registry-specific timestamp shapes.

    Registries emit variations `datetime.fromisoformat` rejects on older Python,
    notably a trailing `Z` and fractional seconds with 1, 2, or 7+ digits.
    """
    raw = str(value or "").strip()
    if not raw:
        return None

    normalized = re.sub(r"[Zz]$", "+00:00", raw)
    fractional = re.search(r"\.(\d+)", normalized)
    if fractional:
        digits = fractional.group(1)[:6].ljust(6, "0")
        normalized = f"{normalized[: fractional.start()]}.{digits}{normalized[fractional.end() :]}"

    for candidate in (normalized, normalized.split(".")[0], raw[:10]):
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            continue
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def months_between(then: datetime, now: datetime) -> int:
    """Return whole months elapsed between two datetimes."""
    return max(0, (now.year - then.year) * 12 + (now.month - then.month) - (1 if now.day < then.day else 0))


def fetch_domain_metrics(domain: str) -> dict[str, Any]:
    """Look up domain registration age over RDAP, with a process-local cache."""
    normalized = normalize_domain(domain)
    lookup = registrable_domain(normalized)

    cached = _DOMAIN_METRICS_CACHE.get(lookup)
    if cached and time.time() - cached[0] < DOMAIN_METRICS_CACHE_TTL_SECONDS:
        return {**cached[1], "domain": normalized, "cached": True}

    result: dict[str, Any] = {
        "status": "ok",
        "domain": normalized,
        "lookupDomain": lookup,
        "createdAt": "",
        "expiresAt": "",
        "ageMonths": None,
        "ageDays": None,
        "source": "rdap",
        "cached": False,
    }

    try:
        response = requests.get(
            f"{RDAP_ENDPOINT.rstrip('/')}/{lookup}",
            headers={"Accept": "application/rdap+json, application/json", "User-Agent": FETCH_USER_AGENT},
            timeout=RDAP_TIMEOUT_SECONDS,
            allow_redirects=True,
        )
    except requests.RequestException as exc:
        result.update({"status": "unknown", "message": f"RDAP request failed: {exc}"})
        return result

    if response.status_code == 404:
        result.update({"status": "unknown", "message": "RDAP has no record for this domain"})
        return result
    if not 200 <= response.status_code < 300:
        result.update({"status": "unknown", "message": f"RDAP HTTP {response.status_code}"})
        return result

    try:
        payload = response.json()
    except ValueError:
        result.update({"status": "unknown", "message": "RDAP response was not JSON"})
        return result

    if not isinstance(payload, dict):
        result.update({"status": "unknown", "message": "RDAP response shape was unexpected"})
        return result

    events = parse_rdap_events(payload)
    created_raw = events.get("registration") or events.get("created") or events.get("last changed")
    expires_raw = events.get("expiration")

    if created_raw:
        created = parse_rdap_datetime(created_raw)
        if created is None:
            result.update(
                {
                    "status": "unknown",
                    "message": f"Unparsable registration date: {created_raw}",
                }
            )
        else:
            now = datetime.now(timezone.utc)
            result["createdAt"] = created.isoformat()
            result["ageMonths"] = months_between(created, now)
            result["ageDays"] = max(0, (now - created).days)
    else:
        result.update({"status": "unknown", "message": "RDAP record had no registration event"})

    if expires_raw:
        expires = parse_rdap_datetime(expires_raw)
        result["expiresAt"] = expires.isoformat() if expires else expires_raw

    if result["status"] == "ok" and result["ageMonths"] is not None:
        _DOMAIN_METRICS_CACHE[lookup] = (time.time(), {**result, "cached": False})
    return result


async def handle_domain_metrics(request):
    """Return registration age for one or more domains so targets can be pre-filtered."""
    try:
        payload = await request.json()
    except (JSONDecodeError, ValueError):
        return web.json_response(
            {"status": "error", "message": "Request body must be a JSON object"},
            status=400,
        )

    if not isinstance(payload, dict):
        return web.json_response(
            {"status": "error", "message": "Request body must be a JSON object"},
            status=400,
        )

    requested = payload.get("domains")
    if isinstance(requested, str):
        requested = [requested]
    if not isinstance(requested, list):
        single = payload.get("domain")
        requested = [single] if single else []

    targets = [str(item).strip() for item in requested if str(item or "").strip()][:25]
    if not targets:
        return web.json_response(
            {"status": "error", "message": "domain or domains is required"},
            status=400,
        )

    async def lookup(value: str) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(fetch_domain_metrics, value)
        except AgentError as exc:
            return {"status": "error", "domain": value, "message": exc.message}

    results = await asyncio.gather(*(lookup(target) for target in targets))
    return web.json_response({"status": "ok", "results": list(results)})


def create_app():
    """Create and configure the aiohttp application."""
    app = web.Application()
    router = app.router
    router.add_get("/health", handle_health)
    router.add_post("/plan", handle_plan)
    router.add_post("/validate-fill", handle_validate_fill)
    router.add_post("/judge", handle_judge)
    router.add_post("/extract-site", handle_extract_site)
    router.add_post("/generate-site", handle_generate_site)
    router.add_post("/comment", handle_comment)
    router.add_get("/media/list", handle_media_list)
    router.add_get("/media/file", handle_media_file)
    router.add_post("/domain/metrics", handle_domain_metrics)
    router.add_get("/google/status", handle_google_status)
    router.add_post("/google/status", handle_google_status)
    router.add_get("/google/auth/start", handle_google_auth_start)
    router.add_post("/google/auth/start", handle_google_auth_start)
    router.add_get("/google/auth/callback", handle_google_auth_callback)
    router.add_get("/google/callback", handle_google_auth_callback)
    router.add_post("/google/sync/preview", handle_google_sync_preview)
    router.add_post("/google/ledger/push", handle_google_ledger_push)
    router.add_post("/google/disconnect", handle_google_disconnect)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host=DEFAULT_HOST, port=DEFAULT_PORT)
