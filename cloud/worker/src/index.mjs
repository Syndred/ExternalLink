import { neon } from "@neondatabase/serverless";
import {
  mediaObjectKey,
  normalizeDocuments,
  normalizeWorkspaceId,
  parseBearerToken,
  secureEqual,
  STATE_DOCUMENT_KEYS,
  timelineAuditRows,
} from "./worker-core.mjs";

const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
const MAX_PAGE_TEXT_CHARS = 18000;
const MAX_AI_ACTIONS = 24;

function json(payload, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { ...init, headers });
}

function requestOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const configured = String(env.ALLOWED_ORIGIN || "").trim();
  return configured && origin === configured ? origin : "";
}

function corsHeaders(request, env) {
  const origin = requestOrigin(request, env);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, X-Asset-Name, X-Asset-Sha256, X-Profile-Id, X-Media-Kind, X-Media-Index",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

function unauthorized(request, env) {
  return withCors(json({ ok: false, error: "未授权的云端访问" }, { status: 401 }), request, env);
}

async function isAuthorised(request, env) {
  const expected = String(env.APP_ACCESS_TOKEN || "").trim();
  const supplied = parseBearerToken(request.headers.get("Authorization"));
  return Boolean(expected && supplied && (await secureEqual(expected, supplied)));
}

async function requestJson(request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求必须是 JSON 对象");
  return body;
}

function sqlFor(env) {
  if (!env.DATABASE_URL) throw new Error("Worker 未配置 DATABASE_URL");
  return neon(env.DATABASE_URL);
}

async function ensureWorkspace(sql, workspaceId) {
  await sql`
    insert into externallink_workspaces (workspace_id)
    values (${workspaceId})
    on conflict (workspace_id) do update set updated_at = now()
  `;
}

function snapshotFromRows(rows) {
  const documents = {};
  const revisions = {};
  for (const row of rows) {
    documents[row.document_key] = row.data;
    revisions[row.document_key] = Number(row.revision);
  }
  return { documents, revisions };
}

async function listSnapshot(sql, workspaceId) {
  const rows = await sql`
    select document_key, data, revision, updated_at
    from externallink_workspace_documents
    where workspace_id = ${workspaceId}
    order by document_key
  `;
  return snapshotFromRows(rows);
}

function normaliseContentType(value) {
  const type = String(value || "").split(";", 1)[0].trim().toLowerCase();
  if (!type.startsWith("image/")) throw new Error("媒体必须是图片格式");
  return type;
}

function safeAssetName(value, fallback) {
  const basename = String(value || fallback || "media")
    .trim()
    .split(/[\\/]/)
    .pop()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return basename.slice(0, 160) || fallback;
}

function safeProfileId(value) {
  const profileId = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/i.test(profileId)) throw new Error("无效的媒体 Profile");
  return profileId;
}

function safeMediaKind(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (!['logo', 'screenshot', 'featured'].includes(kind)) throw new Error("无效的媒体类型");
  return kind;
}

function safeMediaIndex(value) {
  if (value === null || value === undefined || value === "") return null;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index > 99) throw new Error("无效的媒体序号");
  return index;
}

function parseModelJson(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 对象");
  return JSON.parse(raw.slice(start, end + 1));
}

async function callDeepSeek(env, system, user) {
  const key = String(env.DEEPSEEK_API_KEY || "").trim();
  if (!key) throw new Error("Worker 未配置 DEEPSEEK_API_KEY");
  const base = String(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: String(env.DEEPSEEK_MODEL || "deepseek-chat"),
      temperature: 0.35,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `DeepSeek HTTP ${response.status}`);
  return parseModelJson(data?.choices?.[0]?.message?.content);
}

function normaliseDrafts(value, maxChars) {
  const drafts = Array.isArray(value?.drafts) ? value.drafts : [];
  const seen = new Set();
  return drafts
    .map((draft) => String(typeof draft === "object" ? draft.text || draft.content || "" : draft).trim())
    .filter((draft) => draft && draft.length <= maxChars && !seen.has(draft) && seen.add(draft))
    .slice(0, 5)
    .map((text, index) => ({ id: `cloud-${index + 1}`, text }));
}

async function handleComment(request, env) {
  const input = await requestJson(request);
  const count = Math.max(1, Math.min(Number(input.count) || 1, 5));
  const maxChars = Math.max(80, Math.min(Number(input.maxChars) || 700, 2000));
  const config = input.config && typeof input.config === "object" ? input.config : {};
  const result = await callDeepSeek(
    env,
    "You write specific, useful blog or forum comments. Return JSON only: {drafts:[{text:string}]}. Never claim personal experience you do not have. Do not use generic praise. Respect the requested language and character limit.",
    JSON.stringify({
      task: "Generate distinct comment candidates grounded in the page excerpt.",
      count,
      maxChars,
      allowLink: input.allowLink !== false,
      language: input.language || "auto",
      page: {
        url: String(input.pageUrl || "").slice(0, 1000),
        title: String(input.pageTitle || "").slice(0, 600),
        text: String(input.pageText || "").slice(0, MAX_PAGE_TEXT_CHARS),
      },
      brand: {
        name: String(config.brandName || "").slice(0, 300),
        domain: String(config.targetDomain || "").slice(0, 500),
        value: String(config.valueProposition || "").slice(0, 1200),
        audience: String(config.targetAudience || "").slice(0, 600),
      },
    }),
  );
  const drafts = normaliseDrafts(result, maxChars).slice(0, count);
  return { ok: drafts.length > 0, status: drafts.length ? "ok" : "rejected", drafts, rejected: [] };
}

async function handlePlan(request, env) {
  const input = await requestJson(request);
  const result = await callDeepSeek(
    env,
    "You are a cautious browser form-filling planner. Return JSON only in this shape: {status:'act'|'needs_manual'|'blocked', reason:string, actions:[{type:string, selector?:string, value?:string, index?:number}]}. Never submit a form, solve CAPTCHA, log in, pay, or bypass access controls. At most 24 actions. If uncertain, choose needs_manual.",
    JSON.stringify({
      task: input.task || {},
      snapshot: input.snapshot || {},
      config: input.config || {},
      fillOnly: input.fillOnly === true,
    }).slice(0, 60000),
  );
  const actions = Array.isArray(result.actions) ? result.actions.slice(0, MAX_AI_ACTIONS) : [];
  const status = ["act", "needs_manual", "blocked"].includes(result.status) ? result.status : "needs_manual";
  return { status, reason: String(result.reason || ""), actions };
}

function compactJson(value, maxChars = 60000) {
  return JSON.stringify(value || {}).slice(0, maxChars);
}

function textFromHtml(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PAGE_TEXT_CHARS);
}

function normaliseProfile(raw, sourceUrl = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const input = source.fields && typeof source.fields === "object" ? source.fields : source;
  const keys = [
    "Name", "Url", "Title", "Business mail", "Note", "Short description(20-30 words)",
    "Short Discription(100-150 words)", "Long description (250-500 words)",
    "Tags Keywords/Hashtags", "Feature description", "Featured image", "Pricing", "PRICING TYPE",
  ];
  const fields = Object.fromEntries(keys.map((key) => [key, String(input[key] || "").trim()]));
  const url = fields.Url || sourceUrl;
  if (url) fields.Url = /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, "")}`;
  const list = (value, limit) => [...new Set((Array.isArray(value) ? value : String(value || "").split(/[\n,;]+/))
    .map((item) => String(item || "").trim()).filter(Boolean))].slice(0, limit);
  const anchor = source.anchorRules && typeof source.anchorRules === "object" ? source.anchorRules : {};
  const blog = source.blogRules && typeof source.blogRules === "object" ? source.blogRules : {};
  const tone = ["helpful", "professional", "casual", "enthusiastic"].includes(String(blog.tone || "").toLowerCase())
    ? String(blog.tone).toLowerCase() : "helpful";
  const preferredAnchor = ["natural", "brand", "keyword", "url"].includes(String(blog.preferredAnchor || "").toLowerCase())
    ? String(blog.preferredAnchor).toLowerCase() : "natural";
  return {
    fields,
    anchorRules: {
      brandKeywords: list(anchor.brandKeywords, 12), urlKeywords: list(anchor.urlKeywords, 12),
      naturalExpressions: list(anchor.naturalExpressions, 8), keywordExpressions: list(anchor.keywordExpressions, 10),
      avoidWords: list(anchor.avoidWords, 8), allowExactMatch: Boolean(anchor.allowExactMatch),
    },
    blogRules: { tone, maxLinksPerDraft: Math.max(1, Math.min(Number(blog.maxLinksPerDraft) || 1, 5)), preferredAnchor },
    targetAudience: String(source.targetAudience || "").trim(),
    valueProposition: String(source.valueProposition || "").trim(),
    useCases: list(source.useCases, 8), sellablePoints: list(source.sellablePoints, 10), avoidContent: list(source.avoidContent, 8),
  };
}

async function handleExtractSite(request, env) {
  const input = await requestJson(request);
  let target;
  try { target = new URL(String(input.url || "").trim()); } catch { throw new Error("请输入有效的网站地址"); }
  if (!/^https?:$/.test(target.protocol)) throw new Error("仅支持 HTTP(S) 网站地址");
  const response = await fetch(target.href, { headers: { Accept: "text/html,application/xhtml+xml" }, redirect: "follow" });
  if (!response.ok) throw new Error(`网站读取失败: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|text\//i.test(contentType)) throw new Error("目标地址不是可读取的网页");
  const html = (await response.text()).slice(0, 500000);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const source = { requestedUrl: target.href, finalUrl: response.url || target.href, title, text: textFromHtml(html) };
  const result = await callDeepSeek(
    env,
    "Extract a product/site profile from the webpage. Return JSON only with fields, anchorRules, blogRules, targetAudience, valueProposition, useCases, sellablePoints, avoidContent. Use the input language when possible. Do not invent facts.",
    compactJson({ language: input.language || "auto", ...source }),
  );
  return { ok: true, status: "ok", profile: normaliseProfile(result, source.finalUrl), source };
}

async function handleGenerateSite(request, env) {
  const input = await requestJson(request);
  if (!input.profile || typeof input.profile !== "object") throw new Error("缺少网站资料");
  const result = await callDeepSeek(
    env,
    "Improve the supplied partial product/site profile without inventing unavailable facts. Return JSON only with fields, anchorRules, blogRules, targetAudience, valueProposition, useCases, sellablePoints, avoidContent. Keep all valid supplied information.",
    compactJson({ language: input.language || "auto", profile: input.profile }),
  );
  return { ok: true, status: "ok", profile: normaliseProfile(result, input.profile?.fields?.Url || input.profile?.url || "") };
}

async function handleJudge(request, env) {
  const input = await requestJson(request);
  const result = await callDeepSeek(
    env,
    "Judge a backlink/directory submission browser snapshot. Return JSON only: {status:'success'|'incomplete'|'blocked'|'needs_manual',reason:string,message?:string,evidence?:string,publicationStatus?:'submitted'|'pending_moderation'|'published',publicUrl?:string}. Choose needs_manual for login, CAPTCHA, OTP, payment, or uncertainty. Never claim success without explicit page evidence.",
    compactJson(input),
  );
  const status = ["success", "incomplete", "blocked", "needs_manual"].includes(result.status) ? result.status : "needs_manual";
  return { ...result, status, reason: String(result.reason || result.message || ""), message: String(result.message || result.reason || "") };
}

async function handleValidateFill(request, env) {
  const input = await requestJson(request);
  const result = await callDeepSeek(
    env,
    "Review form fields before user submission. Return JSON only: {status:'ok'|'revise',submitReady:boolean,fields:[{selector:string,value:string,reason:string}],issues:string[]}. Correct only fields present in input, respect every maxLength/maxWords, never submit or bypass human verification.",
    compactJson(input),
  );
  return {
    status: result.status === "revise" ? "revise" : "ok",
    submitReady: result.submitReady !== false,
    fields: Array.isArray(result.fields) ? result.fields.slice(0, 50).map((field) => ({ selector: String(field?.selector || ""), value: String(field?.value || ""), reason: String(field?.reason || "") })).filter((field) => field.selector && field.value) : [],
    issues: Array.isArray(result.issues) ? result.issues.map((issue) => String(issue)).slice(0, 10) : [],
  };
}

function rdapEventDate(events, names) {
  const event = (Array.isArray(events) ? events : []).find((entry) =>
    names.includes(String(entry?.eventAction || "").toLowerCase()),
  );
  return event?.eventDate || "";
}

async function handleDomainMetrics(request) {
  const input = await requestJson(request);
  const domains = [...new Set((Array.isArray(input.domains) ? input.domains : []).map((value) => String(value || "").toLowerCase().trim()).filter((value) => /^[a-z0-9.-]+$/.test(value)))].slice(0, 20);
  const results = await Promise.all(domains.map(async (domain) => {
    try {
      const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { Accept: "application/rdap+json, application/json" } });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { domain, status: "unknown", message: `RDAP HTTP ${response.status}` };
      const createdAt = rdapEventDate(data.events, ["registration", "registered"]);
      const expiresAt = rdapEventDate(data.events, ["expiration", "expiry"]);
      const created = Date.parse(createdAt);
      const ageDays = Number.isFinite(created) ? Math.max(0, Math.floor((Date.now() - created) / 86400000)) : null;
      return { domain, status: "ok", createdAt, expiresAt, ageDays, ageMonths: ageDays === null ? null : Math.floor(ageDays / 30.4375) };
    } catch (error) {
      return { domain, status: "unknown", message: error.message };
    }
  }));
  return { ok: true, results };
}

async function router(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!(await isAuthorised(request, env))) return unauthorized(request, env);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const workspaceId = normalizeWorkspaceId(url.searchParams.get("workspace"));
  const sql = sqlFor(env);

  if (request.method === "GET" && path === "/v1/health") {
    await sql`select 1 as ready`;
    return json({ ok: true, workspaceId, documentKeys: STATE_DOCUMENT_KEYS.length });
  }

  if (request.method === "GET" && path === "/v1/snapshot") {
    const snapshot = await listSnapshot(sql, workspaceId);
    return json({ ok: true, workspaceId, ...snapshot });
  }

  if (request.method === "POST" && path === "/v1/migrate") {
    const input = await requestJson(request);
    const documents = normalizeDocuments(input.documents);
    const existing = await sql`
      select count(*)::int as count
      from externallink_workspace_documents
      where workspace_id = ${workspaceId}
    `;
    if (Number(existing[0]?.count || 0) > 0 && input.replace !== true) {
      return json({ ok: false, error: "云端工作区已有数据；拒绝覆盖。请先拉取或明确恢复。" }, { status: 409 });
    }
    await ensureWorkspace(sql, workspaceId);
    if (input.replace === true) {
      await sql`delete from externallink_workspace_documents where workspace_id = ${workspaceId}`;
      await sql`delete from externallink_timeline_revisions where workspace_id = ${workspaceId}`;
    }
    for (const [key, data] of Object.entries(documents)) {
      await sql`
        insert into externallink_workspace_documents (workspace_id, document_key, data)
        values (${workspaceId}, ${key}, ${JSON.stringify(data)}::jsonb)
        on conflict (workspace_id, document_key) do update
          set data = excluded.data, revision = externallink_workspace_documents.revision + 1, updated_at = now()
      `;
    }
    const timeline = documents.submissionTimeline || {};
    for (const audit of timelineAuditRows({}, timeline)) {
      await sql`
        insert into externallink_timeline_revisions (workspace_id, event_id, operation, event)
        values (${workspaceId}, ${audit.eventId}, ${audit.operation}, ${JSON.stringify(audit.event)}::jsonb)
      `;
    }
    return json({ ok: true, workspaceId, importedDocuments: Object.keys(documents).length, timelineEvents: timelineAuditRows({}, timeline).length });
  }

  const stateMatch = path.match(/^\/v1\/state\/([a-zA-Z0-9_-]+)$/);
  if (request.method === "PUT" && stateMatch) {
    const key = stateMatch[1];
    if (!STATE_DOCUMENT_KEYS.includes(key)) return json({ ok: false, error: "不支持的状态文档" }, { status: 404 });
    const input = await requestJson(request);
    const docs = normalizeDocuments({ [key]: input.data });
    const currentRows = await sql`
      select data, revision from externallink_workspace_documents
      where workspace_id = ${workspaceId} and document_key = ${key}
    `;
    const current = currentRows[0] || null;
    const expectedRevision = Number(input.revision);
    if (Number.isFinite(expectedRevision) && expectedRevision > 0 && Number(current?.revision || 0) !== expectedRevision) {
      return json({ ok: false, error: "云端数据已被其他客户端更新", revision: Number(current?.revision || 0), data: current?.data }, { status: 409 });
    }
    await ensureWorkspace(sql, workspaceId);
    const rows = await sql`
      insert into externallink_workspace_documents (workspace_id, document_key, data)
      values (${workspaceId}, ${key}, ${JSON.stringify(docs[key])}::jsonb)
      on conflict (workspace_id, document_key) do update
        set data = excluded.data, revision = externallink_workspace_documents.revision + 1, updated_at = now()
      returning revision, updated_at
    `;
    if (key === "submissionTimeline") {
      for (const audit of timelineAuditRows(current?.data || {}, docs[key])) {
        await sql`
          insert into externallink_timeline_revisions (workspace_id, event_id, operation, event)
          values (${workspaceId}, ${audit.eventId}, ${audit.operation}, ${JSON.stringify(audit.event)}::jsonb)
        `;
      }
    }
    return json({ ok: true, documentKey: key, revision: Number(rows[0]?.revision || 1), updatedAt: rows[0]?.updated_at || "" });
  }

  if (request.method === "GET" && path === "/v1/media") {
    const assets = await sql`
      select asset_id, profile_id, media_kind, media_index, file_name, content_type, byte_length, sha256, created_at, updated_at
      from externallink_media_assets where workspace_id = ${workspaceId}
      order by file_name
    `;
    return json({ ok: true, assets });
  }

  const mediaMatch = path.match(/^\/v1\/media\/([a-zA-Z0-9._-]+)$/);
  if (mediaMatch && request.method === "PUT") {
    const assetId = mediaMatch[1];
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("媒体必须介于 1 字节和 6MB 之间");
    const contentType = normaliseContentType(request.headers.get("Content-Type"));
    const fileName = safeAssetName(request.headers.get("X-Asset-Name"), assetId);
    const sha256 = String(request.headers.get("X-Asset-Sha256") || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("媒体缺少有效的 SHA-256 校验值");
    const profileId = safeProfileId(request.headers.get("X-Profile-Id"));
    const mediaKind = safeMediaKind(request.headers.get("X-Media-Kind"));
    const mediaIndex = safeMediaIndex(request.headers.get("X-Media-Index"));
    const objectKey = mediaObjectKey(workspaceId, assetId);
    await ensureWorkspace(sql, workspaceId);
    await env.MEDIA_BUCKET.put(objectKey, bytes, {
      httpMetadata: { contentType, cacheControl: "private, max-age=3600" },
      sha256,
    });
    await sql`
      insert into externallink_media_assets (workspace_id, asset_id, profile_id, media_kind, media_index, object_key, file_name, content_type, byte_length, sha256)
      values (${workspaceId}, ${assetId}, ${profileId}, ${mediaKind}, ${mediaIndex}, ${objectKey}, ${fileName}, ${contentType}, ${bytes.byteLength}, ${sha256})
      on conflict (workspace_id, asset_id) do update set
        profile_id = excluded.profile_id, media_kind = excluded.media_kind, media_index = excluded.media_index,
        object_key = excluded.object_key, file_name = excluded.file_name, content_type = excluded.content_type,
        byte_length = excluded.byte_length, sha256 = excluded.sha256, updated_at = now()
    `;
    return json({ ok: true, assetId, ref: `cloud-media://${assetId}`, byteLength: bytes.byteLength, contentType });
  }

  if (mediaMatch && request.method === "GET") {
    const assetId = mediaMatch[1];
    const rows = await sql`
      select object_key, file_name, content_type, byte_length
      from externallink_media_assets
      where workspace_id = ${workspaceId} and asset_id = ${assetId}
    `;
    const asset = rows[0];
    if (!asset) return json({ ok: false, error: "媒体不存在" }, { status: 404 });
    const object = await env.MEDIA_BUCKET.get(asset.object_key);
    if (!object) return json({ ok: false, error: "媒体对象不存在" }, { status: 404 });
    return new Response(object.body, {
      headers: {
        "Content-Type": asset.content_type,
        "Content-Length": String(asset.byte_length),
        "Content-Disposition": `inline; filename="${asset.file_name.replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  if (request.method === "POST" && path === "/v1/ai/comment") return json(await handleComment(request, env));
  if (request.method === "POST" && path === "/v1/ai/plan") return json(await handlePlan(request, env));
  if (request.method === "POST" && path === "/v1/ai/extract-site") return json(await handleExtractSite(request, env));
  if (request.method === "POST" && path === "/v1/ai/generate-site") return json(await handleGenerateSite(request, env));
  if (request.method === "POST" && path === "/v1/ai/judge") return json(await handleJudge(request, env));
  if (request.method === "POST" && path === "/v1/ai/validate-fill") return json(await handleValidateFill(request, env));
  if (request.method === "POST" && path === "/v1/domain/metrics") return json(await handleDomainMetrics(request));

  return json({ ok: false, error: "未找到接口" }, { status: 404 });
}

export default {
  async fetch(request, env) {
    try {
      return withCors(await router(request, env), request, env);
    } catch (error) {
      return withCors(json({ ok: false, error: error?.message || "云端请求失败" }, { status: 500 }), request, env);
    }
  },
};
