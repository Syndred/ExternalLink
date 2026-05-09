import asyncio
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:
    from aiohttp import web as _aiohttp_web
except ModuleNotFoundError:
    aiohttp_stub = types.ModuleType("aiohttp")
    web_stub = types.ModuleType("aiohttp.web")

    class StubJsonResponse:
        def __init__(self, payload, status=200):
            self.status = status
            self.text = json.dumps(payload)

    def json_response(payload, status=200):
        return StubJsonResponse(payload, status=status)

    web_stub.json_response = json_response
    web_stub.Application = object
    aiohttp_stub.web = web_stub
    sys.modules["aiohttp"] = aiohttp_stub
    sys.modules["aiohttp.web"] = web_stub

try:
    from dotenv import load_dotenv as _load_dotenv
except ModuleNotFoundError:
    dotenv_stub = types.ModuleType("dotenv")

    def load_dotenv():
        return False

    dotenv_stub.load_dotenv = load_dotenv
    sys.modules["dotenv"] = dotenv_stub

try:
    import requests as _requests
except ModuleNotFoundError:
    requests_stub = types.ModuleType("requests")

    class RequestException(Exception):
        pass

    def post(*args, **kwargs):
        raise AssertionError("requests.post should be patched by tests")

    requests_stub.RequestException = RequestException
    requests_stub.post = post
    sys.modules["requests"] = requests_stub

from local_agent import server


class StubResponse:
    def __init__(self, status_code, payload, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.reason = "stub reason"

    def json(self):
        return self._payload


class LocalAgentUnitTests(unittest.TestCase):
    def test_extract_json_object_handles_text_around_object(self):
        extracted = server.extract_json_object(
            'Planner said:\n{"status":"blocked","actions":[],"reason":"captcha"}\nDone.'
        )

        self.assertEqual(
            extracted,
            {"status": "blocked", "actions": [], "reason": "captcha"},
        )

    def test_normalize_plan_whitelists_schema_drops_malformed_and_bounds_wait(self):
        raw_plan = {
            "status": "act",
            "actions": [
                {
                    "type": "fill",
                    "selector": "#email",
                    "value": 123,
                    "secret": "drop me",
                },
                {"type": "click", "selector": "   "},
                {"type": "select", "selector": "#country", "value": "US", "extra": 1},
                {"type": "check", "selector": "#agree", "extra": "drop"},
                {"type": "check", "selector": "#opt-out", "value": "false"},
                {"type": "wait", "timeout_ms": -50, "selector": "#not-allowed"},
                {"type": "wait", "timeout_ms": 999999, "extra": True},
                {"type": "submit", "selector": "#form", "value": "not allowed"},
                {"type": "unknown", "selector": "#bad"},
                {"type": "fill", "value": "missing selector"},
                "not an action",
                {"type": "click", "selector": ".after-cap"},
            ],
            "reason": "ok",
        }

        normalized = server.normalize_plan(raw_plan)

        self.assertEqual(normalized["status"], "act")
        self.assertEqual(normalized["reason"], "ok")
        self.assertLessEqual(len(normalized["actions"]), server.MAX_PLAN_ACTIONS)
        self.assertEqual(
            normalized["actions"],
            [
                {"type": "fill", "selector": "#email", "value": "123"},
                {"type": "select", "selector": "#country", "value": "US"},
                {"type": "check", "selector": "#agree", "value": True},
                {"type": "check", "selector": "#opt-out", "value": False},
                {"type": "wait", "timeout_ms": server.MIN_WAIT_TIMEOUT_MS},
                {"type": "wait", "timeout_ms": server.MAX_WAIT_TIMEOUT_MS},
            ],
        )
        for action in normalized["actions"]:
            self.assertLessEqual(set(action), server.PLAN_ACTION_OUTPUT_KEYS[action["type"]])

    def test_normalize_plan_bounds_non_finite_wait_timeouts(self):
        raw_plan = {
            "status": "act",
            "actions": [
                {"type": "wait", "timeout_ms": float("inf")},
                {"type": "wait", "timeout_ms": float("-inf")},
                {"type": "wait", "timeout_ms": 10**400},
            ],
            "reason": "ok",
        }

        normalized = server.normalize_plan(raw_plan)

        self.assertEqual(
            normalized["actions"],
            [
                {"type": "wait", "timeout_ms": server.MAX_WAIT_TIMEOUT_MS},
                {"type": "wait", "timeout_ms": server.MIN_WAIT_TIMEOUT_MS},
                {"type": "wait", "timeout_ms": server.MAX_WAIT_TIMEOUT_MS},
            ],
        )

    def test_deepseek_chat_json_missing_api_key_does_not_call_requests(self):
        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}, clear=False):
            with mock.patch.object(server, "DEEPSEEK_API_KEY", None):
                with mock.patch.object(server.requests, "post") as post:
                    with self.assertRaisesRegex(server.AgentError, "DEEPSEEK_API_KEY"):
                        server.deepseek_chat_json("prompt", {"task": "fill form"})

        post.assert_not_called()

    def test_deepseek_chat_json_non_2xx_status_raises_agent_error(self):
        payload = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {"status": "blocked", "actions": [], "reason": "looks json"}
                        )
                    }
                }
            ]
        }
        response = StubResponse(302, payload, text="redirect body")

        with mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key"}, clear=False):
            with mock.patch.object(server.requests, "post", return_value=response):
                with self.assertRaisesRegex(server.AgentError, "DeepSeek HTTP 302"):
                    server.deepseek_chat_json("prompt", {"task": "fill form"})

    def test_handle_plan_offloads_deepseek_call_to_thread(self):
        async def run_test():
            class StubRequest:
                async def json(self):
                    return {"task": "fill form"}

            expected = {"status": "blocked", "actions": [], "reason": "done"}

            async def fake_to_thread(func, *args):
                self.assertIs(func, server.deepseek_chat_json)
                self.assertEqual(args, (server.PLAN_PROMPT, {"task": "fill form"}))
                return expected

            with mock.patch.object(server.asyncio, "to_thread", side_effect=fake_to_thread) as offload:
                response = await server.handle_plan(StubRequest())

            self.assertEqual(offload.call_count, 1)
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.text), expected)

        asyncio.run(run_test())

    def test_local_judge_success_by_url(self):
        judgment = server.local_judge(
            {
                "url": "https://example.com/forms/thank-you?submission=123",
                "title": "Thank you",
                "bodyText": "Your request was received.",
            }
        )

        self.assertEqual(judgment["status"], "success")
        self.assertIn("url", judgment["reason"].lower())

    def test_local_judge_success_by_confirmation_text(self):
        judgment = server.local_judge(
            {
                "url": "https://example.com/contact",
                "title": "Contact",
                "bodyText": "Thank you. Your application has been submitted and is awaiting review.",
            }
        )

        self.assertEqual(judgment["status"], "success")
        self.assertIn("confirmation", judgment["reason"].lower())

    def test_local_judge_blocked_by_captcha_login_payment_verification_and_error_text(self):
        blocked_payloads = [
            {"bodyText": "Please complete the CAPTCHA challenge to continue."},
            {"bodyText": "You must log in before submitting this application."},
            {"bodyText": "Payment is required before this form can be sent."},
            {"bodyText": "Email verification is required to continue."},
            {"bodyText": "Submission failed due to a server error. Please try again."},
        ]

        for payload in blocked_payloads:
            with self.subTest(payload=payload):
                judgment = server.local_judge(payload)
                self.assertIn(judgment["status"], {"blocked", "needs_manual"})
                self.assertTrue(judgment["reason"])

    def test_local_judge_incomplete_when_form_fields_still_present(self):
        judgment = server.local_judge(
            {
                "url": "https://example.com/contact",
                "title": "Contact us",
                "bodyText": "Home Success stories Contact us Name Email Message Submit",
                "forms": [{"selector": "form#contact"}],
                "fields": [
                    {"selector": "#name", "type": "text", "label": "Name"},
                    {"selector": "#email", "type": "email", "label": "Email"},
                    {"selector": "#message", "type": "textarea", "label": "Message"},
                ],
                "buttons": [{"selector": "button[type=submit]", "text": "Submit"}],
            }
        )

        self.assertEqual(judgment["status"], "incomplete")
        self.assertIn("form", judgment["reason"].lower())

    def test_local_judge_fillable_form_overrides_payment_marketing_text(self):
        judgment = server.local_judge(
            {
                "url": "https://example.com/submit",
                "title": "Submit your listing",
                "bodyText": "Submit your AI tool. Payment required only for featured placement. Name Email Website Submit",
                "fields": [
                    {"selector": "#name", "type": "text", "label": "Name", "required": True},
                    {"selector": "#email", "type": "email", "label": "Email", "required": True},
                    {"selector": "#website", "type": "url", "label": "Website", "required": True},
                ],
                "buttons": [{"selector": "button[type=submit]", "text": "Submit"}],
            }
        )

        self.assertEqual(judgment["status"], "incomplete")
        self.assertIn("form", judgment["reason"].lower())

    def test_local_judge_visible_fields_override_success_url(self):
        judgment = server.local_judge(
            {
                "url": "https://example.com/submit?complete=false",
                "title": "Submit your listing",
                "bodyText": "Name Email Website Submit",
                "fields": [
                    {"selector": "#name", "type": "text", "label": "Name", "required": True},
                    {"selector": "#email", "type": "email", "label": "Email", "required": True},
                ],
                "buttons": [{"selector": "button[type=submit]", "text": "Submit"}],
            }
        )

        self.assertEqual(judgment["status"], "incomplete")
        self.assertIn("form", judgment["reason"].lower())

    def test_local_judge_generic_thank_you_without_submission_evidence_is_undecided(self):
        judgment = server.local_judge(
            {
                "url": "https://example.com/about",
                "title": "About us",
                "bodyText": "Thank you for visiting. Read our latest success stories.",
            }
        )

        self.assertIsNone(judgment)

    def test_local_judge_validation_error_with_visible_form_is_incomplete(self):
        judgment = server.local_judge(
            {
                "url": "https://example.com/submit",
                "title": "Submit your listing",
                "bodyText": "Validation error. Please enter your email address. Email Submit",
                "fields": [
                    {"selector": "#email", "type": "email", "label": "Email", "required": True},
                ],
                "buttons": [{"selector": "button[type=submit]", "text": "Submit"}],
            }
        )

        self.assertEqual(judgment["status"], "incomplete")
        self.assertIn("form", judgment["reason"].lower())

    def test_handle_judge_offloads_to_deepseek_when_local_judge_is_undecided(self):
        async def run_test():
            class StubRequest:
                async def json(self):
                    return {
                        "url": "https://example.com/status",
                        "title": "Processing",
                        "bodyText": "We are checking your entry.",
                    }

            expected = {"status": "success", "reason": "model saw confirmation"}

            async def fake_to_thread(func, *args):
                self.assertIs(func, server.deepseek_chat_json)
                self.assertEqual(
                    args,
                    (
                        server.JUDGE_PROMPT,
                        {
                            "url": "https://example.com/status",
                            "title": "Processing",
                            "bodyText": "We are checking your entry.",
                        },
                    ),
                )
                return expected

            with mock.patch.object(server.asyncio, "to_thread", side_effect=fake_to_thread) as offload:
                response = await server.handle_judge(StubRequest())

            self.assertEqual(offload.call_count, 1)
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.text), expected)

        asyncio.run(run_test())


if __name__ == "__main__":
    unittest.main()
