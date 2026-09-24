import assert from "node:assert/strict";
import Worker from "../cloud/worker/src/index.mjs";

const originalFetch = globalThis.fetch;
const env = {
  ALLOWED_ORIGIN: "chrome-extension://test-extension",
  ALLOWED_WORKSPACE_ID: "default",
  APP_ACCESS_TOKEN: "test-token",
  DATABASE_URL: "postgresql://unused:unused@localhost/unused",
  DEEPSEEK_API_KEY: "test-key",
};

async function planWithProviderFailure(status, message) {
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
  return Worker.fetch(new Request("https://worker.example/v1/ai/plan", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      Origin: "chrome-extension://test-extension",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ task: {}, snapshot: {}, config: {} }),
  }), env);
}

try {
  const balanceResponse = await planWithProviderFailure(402, "Insufficient Balance");
  assert.equal(balanceResponse.status, 503);
  assert.deepEqual(await balanceResponse.json(), {
    ok: false,
    error: "AI 服务商账户余额或可用额度不足，云端表单规划暂不可用。",
    code: "AI_PROVIDER_BALANCE_EXHAUSTED",
    message: "AI 服务商账户余额或可用额度不足，云端表单规划暂不可用。",
    retryable: false,
  });

  const transientResponse = await planWithProviderFailure(429, "rate limit exceeded");
  assert.equal(transientResponse.status, 503);
  assert.deepEqual(await transientResponse.json(), {
    ok: false,
    error: "AI 服务商暂不可用：rate limit exceeded",
    code: "AI_PROVIDER_UNAVAILABLE",
    message: "AI 服务商暂不可用：rate limit exceeded",
    retryable: true,
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log("AI provider failure response tests passed");
