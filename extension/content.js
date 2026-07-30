// ExternalLink Extension - Content Script (Form Filling Engine)
"use strict";

(function () {
  // Re-bind listener after extension reload (old listener becomes dead)
  if (window.__extLinkMessageHandler) {
    try {
      chrome.runtime.onMessage.removeListener(window.__extLinkMessageHandler);
    } catch (_) {
      /* previous extension context gone */
    }
  }

  const PLATFORMS = {
    // ====== Profile / Website Field ======
    profile: {
      match: () => detectProfilePage(),
      submit: submitProfileLink,
    },
    // ====== WordPress Comment ======
    wp_comment: {
      match: () => detectWPComment(),
      submit: submitWPComment,
    },
    // ====== Forum Profile (phpBB, Discuz, etc) ======
    forum: {
      match: () => detectForum(),
      submit: submitForumProfile,
    },
    // ====== SaaS Directory Submit ======
    directory: {
      match: () => detectDirectory(),
      submit: submitDirectoryLink,
    },
    // ====== Article / Blog Post Comment ======
    article: {
      match: () => detectArticleComment(),
      submit: submitArticleComment,
    },
    // ====== Guest Post / Submission Form ======
    submission: {
      match: () => detectSubmissionForm(),
      submit: submitGenericForm,
    },
  };
  const SNAPSHOT_SELECTOR_ATTR = "data-extlink-selector";
  const SNAPSHOT_SELECTOR_PREFIX = "extlink";
  const SNAPSHOT_TEXT_LIMIT = 1500;
  const ACTION_WAIT_LIMIT_MS = 5000;
  const SENSITIVE_URL_PARAM_PATTERN = /token|key|secret|code|session|csrf|nonce/i;

  // ─── Message Handler (registered at end of IIFE) ───
  function onExtensionMessage(msg, sender, sendResponse) {
    if (msg.action === "ping") {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "smartFill") {
      smartFillFromConfig(msg.config || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.action === "showFillBanner") {
      showFillCompleteBanner(msg.config || {});
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "collectFillLearnings") {
      sendResponse(collectFillLearnings(msg.config || {}));
      return true;
    }
    if (msg.action === "countEmptyFields") {
      sendResponse(countEmptyFillableFields());
      return true;
    }
    if (msg.action === "getFilledFieldsReport") {
      sendResponse(collectFilledFieldsReport());
      return true;
    }
    if (msg.action === "applyFieldCorrections") {
      applyFieldCorrections(msg.corrections || [])
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.action === "detectPage") {
      try {
        const snapshot = getPageSnapshot();
        const platform = identifyPlatform();
        const hasComment = detectWPComment() || detectArticleComment();
        const scopedFields = queryFillableElements();
        const operable = !!(platform || scopedFields.length > 0 || hasComment);
        sendResponse({
          url: location.href,
          hostname: location.hostname,
          platform: platform || snapshot.meta.platform,
          operable,
          commentFound: hasComment,
          formFieldCount: scopedFields.length,
          formCount: snapshot.meta.formCount,
          hasCaptcha: snapshot.meta.hasCaptcha,
          inModal: getActiveFillScope() !== document,
          fields: scopedFields.slice(0, 20).map((el) => ({
            label: getSnapshotLabel(el),
            name: el.getAttribute("name") || "",
            type: el.getAttribute("type") || el.tagName.toLowerCase(),
          })),
        });
      } catch (err) {
        sendResponse({ error: err.message });
      }
      return true;
    }
    if (msg.type === "getPageSnapshot" || msg.action === "getPageSnapshot") {
      try {
        sendResponse(getPageSnapshot());
      } catch (err) {
        sendResponse({
          url: redactSnapshotUrl(location.href),
          title: document.title,
          error: err.message,
        });
      }
      return true;
    }
    if (msg.type === "executeActionPlan" || msg.action === "executeActionPlan") {
      executeActionPlan(msg.actions)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({ ok: false, results: [], error: err.message });
        });
      return true;
    }
    if (msg.action === "executeSubmit") {
      executeSubmit(msg.config, msg.platformType, msg.taskIndex).then(sendResponse);
      return true; // keep channel open for async
    }
    if (msg.action === "finalizeSubmit") {
      finalizeSubmit(msg.config, msg.taskIndex).then(sendResponse);
      return true;
    }
    if (msg.action === "trySubmit") {
      // User clicked "继续填表" from overlay banner
      removeWaitingBanner();
      executeSubmit(msg.config, msg.platformType, msg.taskIndex).then(sendResponse);
      return true;
    }
    if (msg.action === "showManualWaitBanner") {
      showManualWaitBanner(msg.config, msg.taskIndex, msg.reason, msg.timeoutSec, msg.platformType);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "removeManualWaitBanner") {
      removeManualWaitBanner();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  }

  window.__extLinkMessageHandler = onExtensionMessage;
  chrome.runtime.onMessage.addListener(onExtensionMessage);

  function maybeRequestAutoFill() {
    const mode = identifyPlatform();
    const hasForm =
      !!mode ||
      hasLikelySubmissionFields() ||
      document.querySelectorAll("form input, form textarea, form select").length > 2;
    if (hasForm && window.__extLinkAutoFillUrl !== location.href) {
      window.__extLinkAutoFillUrl = location.href;
      chrome.runtime.sendMessage({ action: "requestAutoFill", url: location.href }).catch(() => {});
    }
    return mode;
  }

  function onPageNavigation() {
    setTimeout(() => {
      const mode = identifyPlatform();
      chrome.runtime
        .sendMessage({
          action: "contentReady",
          mode: mode || "unknown",
        })
        .catch(() => {});
    }, 500);
  }

  if (!window.__extLinkBootstrapped) {
    window.__extLinkBootstrapped = true;
    onPageNavigation();

    const pushState = history.pushState;
    history.pushState = function (...args) {
      pushState.apply(this, args);
      onPageNavigation();
    };
    const replaceState = history.replaceState;
    history.replaceState = function (...args) {
      replaceState.apply(this, args);
      onPageNavigation();
    };
    window.addEventListener("popstate", onPageNavigation);
  }

  // ─── Main Execution ───
  async function executeSubmit(config, platformType, taskIndex) {
    try {
      // Determine platform
      let platform = platformType;
      if (platform === "auto" || !platform) {
        platform = identifyPlatform();
      }

      if (!platform) {
        const submissionLink = findSubmissionLink();
        if (submissionLink) {
          logStep(`🔗 找到提交入口: ${submissionLink.label}`);
          return {
            navigating: true,
            url: submissionLink.url,
            label: submissionLink.label,
          };
        }

        // No form or usable submit link on current page — show overlay banner, wait for user to navigate
        showWaitingBanner(config, platformType, taskIndex);
        return { waiting: true, skipReason: "无表单 — 等待用户导航到提交页" };
      }

      // Execute platform-specific form filling
      const handler = PLATFORMS[platform];
      if (!handler) {
        return { error: "unknown_platform", skipReason: "不支持的平台类型: " + platform };
      }

      const result = await handler.submit(config);

      if (result && result.captcha) {
        // Mark captcha area and notify user
        highlightCaptchaArea();
        chrome.runtime
          .sendMessage({ action: "log", msg: "🤖 请手动完成验证码", cls: "warn" })
          .catch(() => {});
        return { captcha: true };
      }

      // Verify rel after submission
      if (result && result.ok) {
        const relResult = await verifyRel(config.targetDomain);
        result.isDofollow = relResult.isDofollow;
        result.rel = relResult.rel;
      }

      return result;
    } catch (err) {
      return { error: err.message, skipReason: "执行异常: " + err.message };
    }
  }

  // ─── Platform Detection ───
  function identifyPlatform() {
    for (const [name, handler] of Object.entries(PLATFORMS)) {
      if (handler.match()) return name;
    }
    // Generic detection
    if (document.querySelector('textarea[name="comment"], #comment, textarea.comment'))
      return "wp_comment";
    if (
      document.querySelector(
        'input[name="url"], input[name="website"], input[name="pf_phpbb_website"]',
      )
    )
      return "profile";
    if (document.querySelector('form[action*="submit"], form[action*="add"], form.submit-tool'))
      return "directory";
    if (document.querySelector("form") && hasLikelySubmissionFields()) return "submission";
    return null;
  }

  // ==============================
  //  PLATFORM DETECTORS
  // ==============================

  function detectProfilePage() {
    // phpBB "Edit Profile" page
    if (document.querySelector('#pf_phpbb_website, input[name="pf_phpbb_website"]')) return true;
    // Discuz
    if (document.querySelector('input[name="site"]')) return true;
    if (location.href.includes("op=info") && document.querySelector('input[name="site"]'))
      return true;
    // Generic profile edit
    if (
      document.querySelector('input[name="url"]') &&
      (document.body.textContent.includes("profile") ||
        document.body.textContent.includes("Profile"))
    )
      return true;
    if (
      document.querySelector('input[name="website"]') &&
      (document.body.textContent.includes("Edit") || document.body.textContent.includes("Settings"))
    )
      return true;
    return false;
  }

  function detectWPComment() {
    return !!document.querySelector(
      '#commentform, form.comment-form, textarea[name="comment"], #comment, ' +
        ".comment-respond, .wp-block-comments",
    );
  }

  function detectForum() {
    if (document.querySelector('#pf_phpbb_website, input[name="pf_phpbb_website"]')) return true;
    if (document.querySelector('input[name="site"]')) return true;
    if (document.querySelector(".profile") && document.querySelector('input[name="url"]'))
      return true;
    return false;
  }

  function detectDirectory() {
    // SaaS directory submission forms
    const body = document.body.textContent;
    const hasDirectoryKeyword =
      /submit.*tool|submit.*product|submit.*startup|submit.*saas|add.*tool|add.*product|list.*startup|list.*product|get listed/i.test(
        body,
      );
    const hasUrlField = !!document.querySelector(
      'input[name="url"], input[name="website"], input[name="link"], ' +
        'input[name="product_url"], input[type="url"], input[placeholder*="https"], ' +
        'input[placeholder*="URL" i], input[placeholder*="website" i]',
    );
    const hasDirectoryForm = !!document.querySelector(
      'form[action*="submit"], form[action*="add"], form.submit-tool',
    );
    const hasProductFields = !!document.querySelector(
      'input[name="product_name"], input[name="tool_name"], input[name="title"], ' +
        'textarea[name="description"], textarea[name="summary"]',
    );

    if (hasDirectoryForm && (hasUrlField || hasProductFields)) return true;
    if (hasDirectoryKeyword && hasUrlField) return true;
    return false;
  }

  function detectArticleComment() {
    // Article/blog comment forms (non-WP)
    return !!document.querySelector(
      'form[action*="comment"], form[action*="post"], ' +
        ".comment-form:not(.wp-block-comments), " +
        "#comment-form:not(#commentform)",
    );
  }

  function detectSubmissionForm() {
    return (
      !!document.querySelector(
        'form[action*="submit"], form[action*="contact"], form[action*="send"]',
      ) ||
      (!!document.querySelector("form") && hasLikelySubmissionFields())
    );
  }

  function hasLikelySubmissionFields() {
    return !!document.querySelector(
      'input[type="url"], input[type="email"], input[name*="url" i], input[id*="url" i], ' +
        'input[name*="website" i], input[id*="website" i], input[name*="link" i], input[id*="link" i], ' +
        'input[name*="product" i], input[id*="product" i], input[name*="title" i], input[id*="title" i], ' +
        'textarea[name*="description" i], textarea[id*="description" i], textarea[name*="message" i]',
    );
  }

  // ─── Waiting banner overlay (injected into page DOM) ───
  function showWaitingBanner(config, platformType, taskIndex) {
    if (document.getElementById("__extlink_wait_banner")) return;

    const banner = document.createElement("div");
    banner.id = "__extlink_wait_banner";
    banner.innerHTML = `
      <style>
        #__extlink_wait_banner {
          position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          color: #e0e0e0; padding: 14px 24px;
          display: flex; align-items: center; justify-content: center; gap: 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px; box-shadow: 0 4px 24px rgba(0,0,0,0.5);
          animation: __extlink_slideDown 0.35s ease-out;
        }
        @keyframes __extlink_slideDown {
          from { transform: translateY(-100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        #__extlink_wait_banner .__extlink_msg { flex: 1; text-align: center; line-height: 1.5; }
        #__extlink_wait_banner .__extlink_msg strong { color: #eab308; }
        #__extlink_wait_banner .__extlink_skip {
          background: transparent; border: 1px solid #555; color: #999;
          padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
          transition: all 0.2s; white-space: nowrap;
        }
        #__extlink_wait_banner .__extlink_skip:hover { border-color: #e74c3c; color: #e74c3c; }
        #__extlink_wait_banner .__extlink_go {
          background: #2563eb; border: none; color: #fff;
          padding: 8px 22px; border-radius: 6px; cursor: pointer; font-size: 14px;
          font-weight: 600; transition: all 0.2s; white-space: nowrap;
        }
        #__extlink_wait_banner .__extlink_go:hover { background: #1d4ed8; transform: scale(1.03); }
      </style>
      <div class="__extlink_msg">
        ⚠️ 当前页面无提交表单 — 请手动导航到<strong>提交/注册页面</strong>，然后点击 <strong>"继续填表"</strong>
      </div>
      <button class="__extlink_skip" id="__extlink_skip_btn">跳过</button>
      <button class="__extlink_go" id="__extlink_go_btn">▶ 继续填表</button>
    `;
    document.body.appendChild(banner);

    document.getElementById("__extlink_go_btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        action: "manualSubmit",
        taskIndex: taskIndex,
        config: config,
        platformType: platformType,
      });
    });
    document.getElementById("__extlink_skip_btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        action: "manualSkip",
        taskIndex: taskIndex,
      });
      removeWaitingBanner();
    });

    // Auto-detect: poll every 2s — if a form appears on current page, auto-trigger
    window.__extlink_waitPoll = setInterval(() => {
      const p = identifyPlatform();
      if (p) {
        clearInterval(window.__extlink_waitPoll);
        removeWaitingBanner();
        // Re-scan and submit
        chrome.runtime.sendMessage({
          action: "manualSubmit",
          taskIndex: taskIndex,
          config: config,
          platformType: platformType,
        });
      }
    }, 2000);
  }

  function removeWaitingBanner() {
    const banner = document.getElementById("__extlink_wait_banner");
    if (banner) banner.remove();
    if (window.__extlink_waitPoll) {
      clearInterval(window.__extlink_waitPoll);
      delete window.__extlink_waitPoll;
    }
  }

  function showManualWaitBanner(config, taskIndex, reason, timeoutSec, platformType) {
    removeManualWaitBanner();
    removeWaitingBanner();

    const waitSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 0;
    let remaining = waitSec;

    const banner = document.createElement("div");
    banner.id = "__extlink_manual_banner";
    banner.innerHTML = `
      <style>
        #__extlink_manual_banner {
          position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
          background: linear-gradient(135deg, #422006 0%, #713f12 100%);
          color: #fef3c7; padding: 14px 24px;
          display: flex; align-items: center; justify-content: center; gap: 16px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px; box-shadow: 0 4px 24px rgba(0,0,0,0.45);
        }
        #__extlink_manual_banner .__extlink_msg { flex: 1; text-align: center; line-height: 1.5; }
        #__extlink_manual_banner .__extlink_msg strong { color: #fde047; }
        #__extlink_manual_banner .__extlink_countdown { color: #fdba74; font-weight: 700; min-width: 72px; text-align: center; }
        #__extlink_manual_banner .__extlink_skip {
          background: transparent; border: 1px solid #a8a29e; color: #e7e5e4;
          padding: 6px 16px; border-radius: 6px; cursor: pointer; font-size: 13px;
        }
        #__extlink_manual_banner .__extlink_go {
          background: #2563eb; border: none; color: #fff;
          padding: 8px 22px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
        }
        #__extlink_manual_banner .__extlink_success {
          background: #15803d; border: none; color: #fff;
          padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
        }
      </style>
      <div class="__extlink_msg">
        ⏸ <strong>需要人工处理</strong>：<span id="__extlink_manual_reason"></span><br>
        完成登录/验证码后点击 <strong>继续下一步</strong>，AI 会自动继续填表并提交。
      </div>
      <div class="__extlink_countdown" id="__extlink_manual_countdown"></div>
      <button class="__extlink_skip" id="__extlink_manual_skip_btn">跳过</button>
      <button class="__extlink_success" id="__extlink_manual_success_btn">✓ 确认已提交成功</button>
      <button class="__extlink_go" id="__extlink_manual_go_btn">▶ 继续下一步</button>
    `;
    document.body.appendChild(banner);
    const brand = config && config.brandName ? `【${config.brandName}】` : "";
    document.getElementById("__extlink_manual_reason").textContent =
      `${brand}${reason || "登录或验证码"}`;

    const countdownEl = document.getElementById("__extlink_manual_countdown");
    if (!waitSec) countdownEl.textContent = "停放中，不会自动关闭";
    function renderCountdown() {
      countdownEl.textContent = `${remaining}s`;
    }
    if (waitSec) {
      renderCountdown();
      window.__extlink_manualCountdown = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          countdownEl.textContent = "等待人工处理";
          clearInterval(window.__extlink_manualCountdown);
          delete window.__extlink_manualCountdown;
          return;
        }
        renderCountdown();
      }, 1000);
    }

    document.getElementById("__extlink_manual_go_btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        action: "manualContinue",
        taskIndex: taskIndex,
        config: config,
        platformType: platformType,
      });
      removeManualWaitBanner();
    });
    document.getElementById("__extlink_manual_skip_btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "manualSkip", taskIndex: taskIndex });
      removeManualWaitBanner();
    });
    document.getElementById("__extlink_manual_success_btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        action: "confirmSubmissionSuccess",
        taskIndex: taskIndex,
        evidence: "user confirmed from page banner",
      });
      removeManualWaitBanner();
    });
  }

  function removeManualWaitBanner() {
    const banner = document.getElementById("__extlink_manual_banner");
    if (banner) banner.remove();
    if (window.__extlink_manualCountdown) {
      clearInterval(window.__extlink_manualCountdown);
      delete window.__extlink_manualCountdown;
    }
  }

  function isFillOnly(config) {
    return !!(config && config.fillOnly);
  }

  function showFillCompleteBanner() {
    /* Status shown in side panel only — no page overlay. */
  }

  async function returnAfterFill(config, platform) {
    logStep("✅ 表单已填写 — 请手动检查并提交");
    return { ok: true, fillOnly: true, manual: true, platform, reason: "fill_only" };
  }

  function findSubmissionLink() {
    const candidates = Array.from(document.querySelectorAll("a[href], area[href]"))
      .map((link) => scoreSubmissionLink(link))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return candidates[0] || null;
  }

  function scoreSubmissionLink(link) {
    const href = link.getAttribute("href");
    if (
      !href ||
      href.startsWith("#") ||
      /^javascript:/i.test(href) ||
      /^mailto:/i.test(href) ||
      /^tel:/i.test(href)
    ) {
      return null;
    }

    let url;
    try {
      url = new URL(href, location.href);
    } catch (e) {
      return null;
    }

    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.href.replace(/#.*$/, "") === location.href.replace(/#.*$/, "")) return null;

    const label = getElementLabel(link);
    const path = `${url.pathname} ${url.search}`.toLowerCase().replace(/[-_]/g, " ");
    const haystack = `${label} ${path}`;

    const negativeTerms = [
      "login",
      "log in",
      "signin",
      "sign in",
      "privacy",
      "terms",
      "cookie",
      "pricing",
      "newsletter",
      "facebook",
      "twitter",
      "linkedin",
      "instagram",
      "youtube",
      "github",
      "discord",
      "rss",
    ];
    if (negativeTerms.some((term) => haystack.includes(term))) return null;

    const strongTerms = [
      "submit your",
      "add your",
      "list your",
      "get listed",
      "submit tool",
      "submit product",
      "submit startup",
      "submit saas",
      "add tool",
      "add product",
      "add startup",
      "list product",
      "list startup",
      "post your",
      "share your",
      "contribute",
    ];
    const mediumTerms = [
      "submit",
      "submission",
      "add",
      "list",
      "post",
      "create",
      "register",
      "join",
      "publish",
      "upload",
      "new product",
      "new tool",
    ];

    let score = 0;
    for (const term of strongTerms) {
      if (haystack.includes(term)) score += 20;
    }
    for (const term of mediumTerms) {
      if (haystack.includes(term)) score += 5;
    }
    if (url.origin === location.origin) score += 3;
    if (/submit|add|list|get-listed|contribute|publish|new/i.test(url.pathname)) score += 8;

    if (score < 8) return null;

    return {
      url: url.href,
      label: (link.textContent || link.getAttribute("aria-label") || url.pathname || url.href)
        .trim()
        .slice(0, 80),
      score,
    };
  }

  // ==============================
  //  SUBMISSION HANDLERS
  // ==============================

  function logStep(msg) {
    chrome.runtime.sendMessage({ action: "log", msg, cls: "" }).catch(() => {});
  }

  // ─── Profile Link Submission ───
  async function submitProfileLink(config) {
    logStep("🔍 检测到个人资料页 — 查找 URL 字段…");
    const selectors = [
      "#pf_phpbb_website",
      'input[name="pf_phpbb_website"]',
      'input[name="site"]',
      'input[name="url"]',
      'input[name="website"]',
      'input[id*="website"]',
    ];

    let input = null;
    for (const sel of selectors) {
      input = document.querySelector(sel);
      if (input) break;
    }

    if (!input) {
      logStep("❌ 未找到 URL 输入框");
      return { error: "no_url_field", skipReason: "未找到 URL 输入框" };
    }

    logStep(`✏️ 填充外链 → ${config.targetDomain}`);
    // phpBB needs pressSequentially simulation
    if (input.name === "pf_phpbb_website") {
      await simulateTyping(input, config.targetDomain);
    } else {
      input.value = config.targetDomain;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Try to find and click submit
    const submitBtn = findSubmitButton(
      'input[type="submit"], button[type="submit"], input[name="submit"], input[value*="Save"], input[value*="Update"]',
      ["save", "update", "submit"],
    );

    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "profile");
      logStep("🚀 点击提交…");
      submitBtn.click();
      await sleep(3000);
    } else {
      if (isFillOnly(config)) return returnAfterFill(config, "profile");
      logStep("⚠️ 未找到提交按钮，已填字段请手动提交");
      return { manual: true, platform: "profile", reason: "no_submit_button" };
    }

    return { ok: true, platform: "profile" };
  }

  // ─── WordPress Comment Submission ───
  async function submitWPComment(config) {
    logStep("🔍 检测到 WordPress 评论表单");
    // Step 1: Fill author name
    const authorField = document.querySelector(
      '#author, input[name="author"], input[name*="author"], ' +
        'input[aria-label*="Name"], input[placeholder*="name" i], input[placeholder*="Name"]',
    );
    if (authorField) {
      logStep(`✏️ 填写作者名 → ${config.username}`);
      await simulateTyping(authorField, config.username);
    }

    // Step 2: Fill email
    const emailField = document.querySelector(
      '#email, input[name="email"], input[type="email"], ' +
        'input[aria-label*="Email"], input[placeholder*="email" i], input[placeholder*="Email"]',
    );
    if (emailField) {
      logStep(`✏️ 填写邮箱 → ${config.email}`);
      await simulateTyping(emailField, config.email);
    }

    // Step 3: Fill URL (link goes HERE, not in body - Akismet bypass)
    const urlField = document.querySelector(
      '#url, input[name="url"], input[name="website"], ' +
        'input[aria-label*="Website"], input[placeholder*="website" i]',
    );
    if (urlField) {
      logStep(`✏️ 填写外链 → ${config.targetDomain}`);
      await simulateTyping(urlField, config.targetDomain);
    }

    // Step 4: Generate comment text (no URL in body!)
    const commentText = generateComment(config);
    const commentField = document.querySelector(
      '#comment, textarea[name="comment"], textarea.comment, ' +
        'textarea[aria-label*="Comment"], textarea[placeholder*="comment" i]',
    );
    if (commentField) {
      logStep("✏️ 填写评论文本…");
      await simulateTyping(commentField, commentText);
    }

    // Step 5: Check for captcha before submitting
    if (detectCaptcha()) {
      logStep("🤖 检测到验证码 — 请手动完成");
      highlightCaptchaArea();
      return { captcha: true };
    }

    // Step 6: Submit
    const submitBtn = findSubmitButton(
      '#submit, input[type="submit"][name="submit"], button[type="submit"], input.comment-submit, button.comment-submit, .form-submit input[type="submit"]',
      ["post comment", "submit", "comment"],
    );
    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "wp_comment");
      logStep("🚀 提交评论…");
      submitBtn.click();
      await sleep(3000);
    } else {
      if (isFillOnly(config)) return returnAfterFill(config, "wp_comment");
      logStep("⚠️ 未找到评论提交按钮，已填字段请手动提交");
      return { manual: true, platform: "wp_comment", reason: "no_submit_button" };
    }

    return { ok: true, platform: "wp_comment" };
  }

  // ─── Forum Profile Link ───
  async function submitForumProfile(config) {
    logStep("🔍 检测到论坛个人资料页 — 查找 URL 字段…");
    // Try phpBB website field first
    let input = document.querySelector('#pf_phpbb_website, input[name="pf_phpbb_website"]');

    // Discuz site field
    if (!input) input = document.querySelector('input[name="site"]');

    // Generic
    if (!input) input = document.querySelector('input[name="url"], input[name="website"]');

    if (!input) {
      logStep("❌ 未找到论坛个人信息字段");
      return { error: "no_forum_field", skipReason: "未找到论坛个人信息字段" };
    }

    logStep(`✏️ 填充外链 → ${config.targetDomain}`);
    await simulateTyping(input, config.targetDomain);
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const submitBtn = findSubmitButton(
      'input[name="submit"], button[type="submit"], input[type="submit"]',
      ["submit", "save", "update"],
    );
    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "forum");
      logStep("🚀 点击提交…");
      submitBtn.click();
      await sleep(3000);
    } else {
      if (isFillOnly(config)) return returnAfterFill(config, "forum");
      logStep("⚠️ 未找到提交按钮，已填字段请手动提交");
      return { manual: true, platform: "forum", reason: "no_submit_button" };
    }

    return { ok: true, platform: "forum" };
  }

  // ─── SaaS Directory Submission ───
  async function submitDirectoryLink(config) {
    logStep("🔍 检测到目录提交表单");
    const result = await smartFillFromConfig(config);
    if (result.filledCount === 0) {
      const submissionLink = findSubmissionLink();
      if (submissionLink) {
        logStep(`🔗 当前页没有可填字段，打开提交入口: ${submissionLink.label}`);
        return { navigating: true, url: submissionLink.url, label: submissionLink.label };
      }
      return { error: "no_directory_fields", skipReason: "未找到目录提交字段" };
    }

    if (result.skippedFiles?.length) {
      logStep(`⚠️ 图片字段需手动上传: ${result.skippedFiles.join(", ")}`);
    }

    if (detectCaptcha()) {
      logStep("🤖 检测到验证码 — 请手动完成");
      highlightCaptchaArea();
      return { captcha: true };
    }

    const submitBtn = findSubmitButton('button[type="submit"], input[type="submit"]', [
      "submit",
      "add",
      "list",
      "publish",
    ]);
    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "directory");
      logStep("🚀 提交目录…");
      submitBtn.click();
      await sleep(3000);
    } else {
      if (isFillOnly(config)) return returnAfterFill(config, "directory");
      logStep("⚠️ 未找到目录提交按钮，已填字段请手动提交");
      return { manual: true, platform: "directory", reason: "no_submit_button" };
    }

    return { ok: true, platform: "directory", ...result };
  }

  // ─── Article Comment Submission ───
  async function submitArticleComment(config) {
    logStep("🔍 检测到文章评论表单");
    // Similar to WP but with generic selectors
    const nameField = document.querySelector(
      'input[name="author"], input[name="name"], ' +
        'input[placeholder*="name" i], input[placeholder*="Name"]',
    );
    if (nameField) {
      logStep(`✏️ 填写名称 → ${config.username}`);
      await simulateTyping(nameField, config.username);
    }

    const emailField = document.querySelector(
      'input[name="email"], input[type="email"], ' +
        'input[placeholder*="email" i], input[placeholder*="Email"]',
    );
    if (emailField) {
      logStep(`✏️ 填写邮箱 → ${config.email}`);
      await simulateTyping(emailField, config.email);
    }

    const urlField = document.querySelector(
      'input[name="url"], input[name="website"], ' +
        'input[placeholder*="website" i], input[placeholder*="URL"]',
    );
    if (urlField) {
      logStep(`✏️ 填写外链 → ${config.targetDomain}`);
      await simulateTyping(urlField, config.targetDomain);
    }

    const commentField = document.querySelector(
      'textarea[name="comment"], textarea.comment, ' +
        'textarea[name="body"], textarea[placeholder*="comment" i]',
    );
    if (commentField) {
      logStep("✏️ 填写评论文本…");
      await simulateTyping(commentField, generateComment(config));
    }

    if (detectCaptcha()) {
      logStep("🤖 检测到验证码 — 请手动完成");
      highlightCaptchaArea();
      return { captcha: true };
    }

    const submitBtn = findSubmitButton('input[type="submit"], button[type="submit"]', [
      "post",
      "submit",
      "comment",
    ]);
    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "article");
      logStep("🚀 提交评论…");
      submitBtn.click();
      await sleep(3000);
    } else {
      if (isFillOnly(config)) return returnAfterFill(config, "article");
      logStep("⚠️ 未找到评论提交按钮，已填字段请手动提交");
      return { manual: true, platform: "article", reason: "no_submit_button" };
    }

    return { ok: true, platform: "article" };
  }

  // ─── Generic Form Submission ───
  async function submitGenericForm(config) {
    logStep("🔍 检测到通用提交表单");
    let filledCount = 0;
    // Fill all visible text inputs with relevant data
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="url"], input[type="email"], input:not([type])',
    );
    for (const input of inputs) {
      if (!isFillableField(input)) continue;
      const name = getFieldHint(input);
      if (name.includes("url") || name.includes("website") || name.includes("link")) {
        await simulateTyping(input, config.targetDomain);
        filledCount++;
      } else if (name.includes("name") || name.includes("author")) {
        await simulateTyping(input, config.username);
        filledCount++;
      } else if (name.includes("email")) {
        await simulateTyping(input, config.email);
        filledCount++;
      } else if (name.includes("title") || name.includes("subject")) {
        await simulateTyping(input, config.brandName);
        filledCount++;
      } else if (input.type === "url") {
        await simulateTyping(input, config.targetDomain);
        filledCount++;
      } else if (input.type === "email") {
        await simulateTyping(input, config.email);
        filledCount++;
      }
    }

    const textareas = document.querySelectorAll("textarea");
    for (const ta of textareas) {
      if (!isFillableField(ta)) continue;
      const name = getFieldHint(ta);
      if (name.includes("comment") || name.includes("body") || name.includes("message")) {
        await simulateTyping(ta, generateComment(config));
        filledCount++;
      } else if (name.includes("desc") || name.includes("summary")) {
        await simulateTyping(ta, config.commentTemplate || generateDescription(config));
        filledCount++;
      }
    }

    logStep(`✏️ 填充了 ${filledCount} 个字段`);
    if (filledCount === 0) {
      return { error: "no_fillable_fields", skipReason: "未找到可自动填写字段" };
    }

    if (detectCaptcha()) {
      logStep("🤖 检测到验证码 — 请手动完成");
      highlightCaptchaArea();
      return { captcha: true };
    }

    const submitBtn = findSubmitButton(
      'input[type="submit"], button[type="submit"], button[name="submit"], input[name="submit"]',
      ["submit", "send", "save", "publish"],
    );
    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "generic");
      logStep("🚀 提交表单…");
      submitBtn.click();
      await sleep(3000);
    } else {
      if (isFillOnly(config)) return returnAfterFill(config, "generic");
      logStep("⚠️ 未找到提交按钮，已填字段请手动提交");
      return { manual: true, platform: "generic", reason: "no_submit_button" };
    }

    return { ok: true, platform: "generic" };
  }

  // ─── Finalize After Captcha ───
  async function finalizeSubmit(config, taskIndex) {
    // Click submit button
    const submitBtn = findSubmitButton(
      'input[type="submit"], button[type="submit"], #submit, .form-submit input',
      ["submit", "post", "save"],
    );
    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "generic");
      submitBtn.click();
      await sleep(3000);
    }

    const relResult = await verifyRel(config.targetDomain);
    return {
      ok: true,
      isDofollow: relResult.isDofollow,
      rel: relResult.rel,
    };
  }

  function getPageSnapshot() {
    assignStableSelectors();

    const fields = Array.from(document.querySelectorAll("input, textarea, select"))
      .filter(isRelevantSnapshotElement)
      .map(snapshotField);
    const comboboxFields = Array.from(
      document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]'),
    )
      .filter((el) => el.tagName.toLowerCase() !== "select")
      .filter(isRelevantSnapshotElement)
      .map((element) => ({
        ...snapshotField(element),
        tag: element.tagName.toLowerCase(),
        type: "combobox",
      }));
    fields.push(...comboboxFields);
    const buttons = Array.from(
      document.querySelectorAll(
        'button, input[type="button"], input[type="submit"], input[type="reset"], a[href], [role="button"]',
      ),
    )
      .filter(isRelevantSnapshotElement)
      .map(snapshotButton);
    const forms = Array.from(document.querySelectorAll("form"))
      .filter((form) => isVisible(form) && !form.closest('[aria-hidden="true"]'))
      .map((form) => {
        const formFields = Array.from(form.querySelectorAll("input, textarea, select"))
          .filter(isRelevantSnapshotElement)
          .map(extSelector)
          .filter(Boolean);
        const formButtons = Array.from(
          form.querySelectorAll(
            'button, input[type="button"], input[type="submit"], input[type="reset"], a[href], [role="button"]',
          ),
        )
          .filter(isRelevantSnapshotElement)
          .map(extSelector)
          .filter(Boolean);

        return {
          selector: extSelector(form),
          id: form.id || "",
          name: form.getAttribute("name") || "",
          action: redactSnapshotUrl(form.getAttribute("action") || ""),
          method: (form.getAttribute("method") || "get").toLowerCase(),
          fields: formFields,
          buttons: formButtons,
        };
      });

    return {
      url: redactSnapshotUrl(location.href),
      title: document.title || "",
      text: compactText(document.body ? document.body.innerText : "", SNAPSHOT_TEXT_LIMIT),
      forms,
      fields,
      buttons,
      meta: {
        platform: identifyPlatform() || "unknown",
        hasCaptcha: detectCaptcha(),
        fieldCount: fields.length,
        buttonCount: buttons.length,
        formCount: forms.length,
      },
    };
  }

  function assignStableSelectors() {
    const elements = Array.from(
      document.querySelectorAll(
        'form, input, textarea, select, button, input[type="button"], input[type="submit"], input[type="reset"], a[href], [role="button"]',
      ),
    );
    let counter = 1;

    for (const element of elements) {
      if (!isRelevantSnapshotElement(element) && element.tagName.toLowerCase() !== "form") continue;
      if (element.hasAttribute(SNAPSHOT_SELECTOR_ATTR)) continue;

      let value;
      do {
        value = `${SNAPSHOT_SELECTOR_PREFIX}-${counter}`;
        counter++;
      } while (document.querySelector(`[${SNAPSHOT_SELECTOR_ATTR}="${cssEscape(value)}"]`));

      element.setAttribute("data-extlink-selector", value);
    }
  }

  function extSelector(element) {
    if (!element || !element.getAttribute) return "";

    const stable = element.getAttribute(SNAPSHOT_SELECTOR_ATTR);
    if (stable) return `[${SNAPSHOT_SELECTOR_ATTR}="${cssEscape(stable)}"]`;

    if (element.id && document.querySelectorAll(`#${cssEscape(element.id)}`).length === 1) {
      return `#${cssEscape(element.id)}`;
    }

    const tag = element.tagName.toLowerCase();
    const safeAttributes = ["name", "aria-label", "placeholder", "title", "role", "type"];
    for (const attr of safeAttributes) {
      const value = element.getAttribute(attr);
      if (!value || value.length > 80) continue;
      const selector = `${tag}[${attr}="${cssEscape(value)}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }

    return nthOfTypeSelector(element);
  }

  function snapshotField(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || tag).toLowerCase();
    const label = getSnapshotLabel(element);
    const valueInfo = getSnapshotValueInfo(element, type);

    return {
      selector: extSelector(element),
      tag,
      type,
      name: element.getAttribute("name") || "",
      id: element.id || "",
      label,
      placeholder: element.getAttribute("placeholder") || "",
      aria: element.getAttribute("aria-label") || "",
      required: !!element.required || element.getAttribute("aria-required") === "true",
      disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true",
      visible: isVisible(element),
      constraints: getFieldConstraints(element),
      value: valueInfo,
      options:
        tag === "select"
          ? Array.from(element.options || [])
              .slice(0, 40)
              .map((o) => ({
                value: o.value,
                label: compactText(o.textContent, 100),
                disabled: !!o.disabled,
              }))
          : undefined,
    };
  }

  function snapshotButton(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || (tag === "a" ? "link" : "button")).toLowerCase();

    return {
      selector: extSelector(element),
      tag,
      type,
      text: compactText(
        [element.innerText, element.textContent, element.value].filter(Boolean).join(" "),
        160,
      ),
      aria: element.getAttribute("aria-label") || "",
      title: element.getAttribute("title") || "",
      disabled: !!element.disabled || element.getAttribute("aria-disabled") === "true",
      visible: isVisible(element),
      href: redactSnapshotUrl(element.href || element.getAttribute("href") || ""),
    };
  }

  function isRelevantSnapshotElement(element) {
    if (!element || !element.matches) return false;
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    if (!isVisible(element)) return false;

    const tag = element.tagName.toLowerCase();
    if (tag === "form") return true;
    if (tag === "textarea" || tag === "select" || tag === "button") return true;
    if (tag === "a") {
      const href = element.getAttribute("href") || "";
      return (
        !!href &&
        !href.startsWith("#") &&
        !/^javascript:/i.test(href) &&
        compactText(getElementLabel(element), 80).length > 0
      );
    }
    if (element.getAttribute("role") === "button") return true;
    if (tag !== "input") return false;

    const type = (element.getAttribute("type") || "text").toLowerCase();
    return !["hidden", "image", "file"].includes(type);
  }

  async function executeActionPlan(actions) {
    if (!Array.isArray(actions)) {
      return {
        ok: false,
        results: [{ ok: false, error: "actions must be an array" }],
      };
    }

    const results = [];
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      try {
        const result = await executeModelAction(action || {});
        results.push({ index, type: action && action.type, ...result });
      } catch (err) {
        results.push({ index, type: action && action.type, ok: false, error: err.message });
      }
    }

    return {
      ok: results.every((result) => result.ok),
      results,
    };
  }

  async function executeModelAction(action) {
    switch (action.type) {
      case "fill": {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, "selector not found");
        if (!isActionElementAllowed(element, action.type))
          return actionFailure(action, "action target is not allowed");
        if (element.disabled || element.readOnly)
          return actionFailure(action, "field is disabled or readonly");
        element.focus();
        const raw = action.value == null ? "" : String(action.value);
        const fitted = fitValueToConstraints(raw, getFieldConstraints(element));
        setFieldValue(element, fitted);
        element.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: fitted }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selector: action.selector };
      }
      case "click": {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, "selector not found");
        if (!isActionElementAllowed(element, action.type))
          return actionFailure(action, "action target is not allowed");
        if (element.disabled || element.getAttribute("aria-disabled") === "true")
          return actionFailure(action, "element is disabled");
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        element.click();
        return { ok: true, selector: action.selector };
      }
      case "select": {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, "selector not found");
        if (!isActionElementAllowed(element, action.type))
          return actionFailure(action, "action target is not allowed");
        if (element.disabled) return actionFailure(action, "select is disabled");

        if (element.tagName.toLowerCase() === "select") {
          if (!setSelectValue(element, action.value))
            return actionFailure(action, "select option not found");
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, selector: action.selector };
        }

        const role = element.getAttribute("role") || "";
        if (role === "combobox" || element.getAttribute("aria-haspopup") === "listbox") {
          element.focus();
          element.click();
          await sleep(250);
          const desired = normalizeOptionText(String(action.value || ""));
          const optionEls = Array.from(
            document.querySelectorAll('[role="option"], [role="listbox"] li, .dropdown-item'),
          ).filter(isVisible);
          const match = optionEls.find((el) => {
            const label = normalizeOptionText(el.textContent || "");
            return label === desired || label.includes(desired) || desired.includes(label);
          });
          if (!match) {
            document.body.click();
            return actionFailure(action, "dropdown option not found");
          }
          match.click();
          await sleep(150);
          return { ok: true, selector: action.selector };
        }

        return actionFailure(action, "selector is not a select");
      }
      case "check": {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, "selector not found");
        if (!isActionElementAllowed(element, action.type))
          return actionFailure(action, "action target is not allowed");
        if (!["checkbox", "radio"].includes((element.type || "").toLowerCase())) {
          return actionFailure(action, "selector is not checkable");
        }
        if (element.disabled) return actionFailure(action, "field is disabled");
        setCheckedValue(element, action.value !== false && action.checked !== false);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selector: action.selector };
      }
      case "submit": {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, "selector not found");
        if (!isActionElementAllowed(element, action.type))
          return actionFailure(action, "action target is not allowed");
        const form = element.tagName.toLowerCase() === "form" ? element : element.closest("form");
        if (form && typeof form.requestSubmit === "function") {
          form.requestSubmit(isSubmitControl(element) ? element : undefined);
          return { ok: true, selector: action.selector, submitted: "requestSubmit" };
        }
        if (form && element === form) {
          const submitter = form.querySelector(
            'button[type="submit"], input[type="submit"], button:not([type])',
          );
          if (submitter) {
            submitter.click();
            return { ok: true, selector: action.selector, submitted: "click" };
          }
        }
        element.click();
        return { ok: true, selector: action.selector, submitted: "click" };
      }
      case "wait": {
        const requestedMs = action.timeout_ms ?? action.ms ?? action.duration ?? 0;
        const parsedMs = Number(requestedMs);
        const ms = Number.isFinite(parsedMs)
          ? Math.max(0, Math.min(parsedMs, ACTION_WAIT_LIMIT_MS))
          : 0;
        await sleep(ms);
        return { ok: true, waitedMs: ms };
      }
      default:
        return { ok: false, error: `unsupported action type: ${action.type || "missing"}` };
    }
  }

  // ==============================
  //  HELPERS
  // ==============================

  // ─── Instant fill (default) or human typing for antispam ───
  async function simulateTyping(element, text, options) {
    if (!element || text == null || text === "") return;
    const str = String(text);
    element.focus();
    element.dispatchEvent(new Event("focus", { bubbles: true }));

    const humanTyping = options && options.humanTyping === true;
    if (!humanTyping) {
      setFieldValue(element, str);
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: str }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
      return;
    }

    setFieldValue(element, "");
    let value = "";
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const keydown = new KeyboardEvent("keydown", {
        key: char,
        bubbles: true,
        cancelable: true,
        keyCode: char.charCodeAt(0),
        which: char.charCodeAt(0),
      });
      const keypress = new KeyboardEvent("keypress", {
        key: char,
        bubbles: true,
        cancelable: true,
        keyCode: char.charCodeAt(0),
        which: char.charCodeAt(0),
      });
      const inputEvent = new InputEvent("input", {
        data: char,
        bubbles: true,
        inputType: "insertText",
      });

      element.dispatchEvent(keydown);
      element.dispatchEvent(keypress);
      value += char;
      setFieldValue(element, value);
      element.dispatchEvent(inputEvent);
      await sleep(30 + Math.random() * 90);
    }

    element.dispatchEvent(new Event("keyup", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function setFieldValue(element, value) {
    const nativeSetter = getNativeValueSetter(element);
    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function getNativeValueSetter(element) {
    let prototype = HTMLInputElement.prototype;
    if (element instanceof HTMLTextAreaElement) {
      prototype = HTMLTextAreaElement.prototype;
    } else if (element instanceof HTMLSelectElement) {
      prototype = HTMLSelectElement.prototype;
    }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    return descriptor && descriptor.set;
  }

  function setCheckedValue(element, checked) {
    const nativeSetter = getNativeCheckedSetter(element);
    if (nativeSetter) {
      nativeSetter.call(element, checked);
    } else {
      element.checked = checked;
    }
  }

  function getNativeCheckedSetter(element) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
    return descriptor && descriptor.set;
  }

  function setSelectValue(element, value) {
    const desired = String(value == null ? "" : value);
    if (!desired) return false;
    const options = Array.from(element.options || []).filter((o) => !o.disabled);
    const normalizedDesired = normalizeOptionText(desired);
    let option = options.find((option) => option.value === desired);

    if (!option) {
      option = options.find(
        (option) =>
          normalizeOptionText(option.textContent) === normalizedDesired ||
          normalizeOptionText(option.label) === normalizedDesired,
      );
    }

    if (!option) {
      option = options.find(
        (option) =>
          normalizeOptionText(option.textContent).includes(normalizedDesired) ||
          normalizedDesired.includes(normalizeOptionText(option.textContent)),
      );
    }

    if (!option) return false;
    setFieldValue(element, option.value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function normalizeOptionText(text) {
    return compactText(text, 500).toLowerCase();
  }

  function resolveActionElement(action) {
    if (!action.selector) return null;
    try {
      return document.querySelector(action.selector);
    } catch (e) {
      return null;
    }
  }

  function actionFailure(action, error) {
    return {
      ok: false,
      selector: action.selector || "",
      error,
    };
  }

  function isActionElementAllowed(element, actionType) {
    if (!element || !element.matches) return false;
    if (!element.hasAttribute(SNAPSHOT_SELECTOR_ATTR)) return false;
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    if (!isVisible(element)) return false;

    const tag = element.tagName.toLowerCase();
    const disabled = !!element.disabled || element.getAttribute("aria-disabled") === "true";
    if (disabled && actionType !== "wait") return false;

    if (actionType === "fill") {
      return (
        (tag === "input" || tag === "textarea") &&
        !["hidden", "file", "image", "submit", "button", "reset", "checkbox", "radio"].includes(
          (element.type || "").toLowerCase(),
        )
      );
    }
    if (actionType === "select") {
      return (
        tag === "select" ||
        element.getAttribute("role") === "combobox" ||
        element.getAttribute("aria-haspopup") === "listbox"
      );
    }
    if (actionType === "check")
      return tag === "input" && ["checkbox", "radio"].includes((element.type || "").toLowerCase());
    if (actionType === "submit")
      return tag === "form" || isSubmitControl(element) || !!element.closest("form");
    if (actionType === "click") {
      return (
        tag === "button" ||
        tag === "a" ||
        element.getAttribute("role") === "button" ||
        ["button", "submit", "reset"].includes((element.type || "").toLowerCase())
      );
    }

    return false;
  }

  function isSubmitControl(element) {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") || "").toLowerCase();
    return (
      (tag === "button" && (!type || type === "submit")) ||
      (tag === "input" && (type === "submit" || type === "image"))
    );
  }

  function redactSnapshotUrl(url) {
    const raw = String(url || "");
    if (!raw) return "";

    try {
      const parsed = new URL(raw, location.href);
      parsed.hash = "";
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (SENSITIVE_URL_PARAM_PATTERN.test(key)) {
          parsed.searchParams.set(key, "REDACTED");
        }
      }
      return parsed.toString();
    } catch (e) {
      return compactText(raw.split("#")[0], 300).replace(
        /(^|[?&\s])((?:token|key|secret|code|session|csrf|nonce)[^=\s&]*=)[^&\s]*/gi,
        "$1$2REDACTED",
      );
    }
  }

  function compactText(text, limit) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit);
  }

  function getSnapshotLabel(element) {
    const labels = [];
    if (element.id) {
      labels.push(
        ...Array.from(document.querySelectorAll(`label[for="${cssEscape(element.id)}"]`)).map(
          (label) => label.textContent,
        ),
      );
    }
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) labels.push(wrappingLabel.textContent);
    labels.push(
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("title"),
      element.textContent,
    );
    return compactText(labels.filter(Boolean).join(" "), 180);
  }

  function getSnapshotValueInfo(element, type) {
    if (type === "password") {
      return { present: !!element.value, kind: "secret" };
    }
    if (type === "checkbox" || type === "radio") {
      return { checked: !!element.checked, kind: "checked" };
    }
    if (element.tagName.toLowerCase() === "select") {
      return {
        present: !!element.value,
        kind: "select",
        selectedLabel: compactText(
          element.selectedOptions && element.selectedOptions[0]
            ? element.selectedOptions[0].textContent
            : "",
          80,
        ),
      };
    }
    return {
      present: !!element.value,
      kind: type || "text",
      length: element.value ? String(element.value).length : 0,
    };
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function nthOfTypeSelector(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const index =
        Array.from(parent.children)
          .filter((child) => child.tagName.toLowerCase() === tag)
          .indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
      current = parent;
    }
    return parts.length ? parts.join(" > ") : element.tagName.toLowerCase();
  }

  function getFieldHint(element) {
    return [
      getSnapshotLabel(element),
      element.name,
      element.id,
      element.type,
      element.getAttribute("aria-label"),
      element.getAttribute("placeholder"),
      element.getAttribute("autocomplete"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function getProfileFields(config) {
    return config && config.projectFields && typeof config.projectFields === "object"
      ? config.projectFields
      : {};
  }

  function pickDescription(config) {
    const pf = getProfileFields(config);
    return (
      pf["Short Discription(100-150 words)"] ||
      pf["Long description (250-500 words)"] ||
      pf["Short description(20-30 words)"] ||
      config.commentTemplate ||
      generateDescription(config)
    );
  }

  function resolvePricingForSelect(select, pf) {
    const pricingText = String(pf["PRICING TYPE"] || pf.Pricing || "freemium").toLowerCase();
    const options = Array.from(select.options).filter((o) => o.value && o.value !== "");
    const priorities = [];
    if (/freemium/.test(pricingText)) priorities.push("freemium", "free");
    else if (/free/.test(pricingText)) priorities.push("free", "freemium");
    else if (/subscription|paid/.test(pricingText))
      priorities.push("paid", "subscription", "freemium");
    else priorities.push("freemium", "free", "paid");

    for (const token of priorities) {
      const opt = options.find(
        (o) => o.textContent.toLowerCase().includes(token) || o.value.toLowerCase().includes(token),
      );
      if (opt) return opt.value;
    }
    return options[0]?.value || "";
  }

  function getNativeSelectOptions(element) {
    return Array.from(element.options || [])
      .map((o) => ({
        value: o.value,
        label: (o.textContent || o.label || "").trim(),
        disabled: !!o.disabled,
      }))
      .filter((o) => o.value && !/^(-+|choose|select|pick|please)/i.test(o.label));
  }

  function isSelectEmpty(element) {
    if (element.tagName.toLowerCase() !== "select") return true;
    if (!element.value || !String(element.value).trim()) return true;
    const opt = element.selectedOptions?.[0];
    if (!opt) return true;
    const label = (opt.textContent || "").trim();
    if (!label || /^(select|choose|pick|please|--)/i.test(label)) return true;
    return false;
  }

  function findBestSelectOption(options, needle) {
    const n = normalizeOptionText(String(needle || ""));
    if (!n || n.length < 2) return null;
    return (
      options.find((o) => normalizeOptionText(o.value) === n) ||
      options.find((o) => normalizeOptionText(o.label) === n) ||
      options.find(
        (o) => normalizeOptionText(o.label).includes(n) || normalizeOptionText(o.value).includes(n),
      ) ||
      options.find((o) => n.includes(normalizeOptionText(o.label)))
    );
  }

  function resolveSelectTokens(element, config) {
    const hint = getFieldHint(element);
    const pf = getProfileFields(config);
    const tokens = [];

    if (/pric|plan|model|tier|billing/.test(hint)) {
      const pricingText = String(pf["PRICING TYPE"] || pf.Pricing || "freemium").toLowerCase();
      if (/freemium/.test(pricingText)) tokens.push("freemium", "free");
      else if (/free/.test(pricingText)) tokens.push("free", "freemium");
      else if (/subscription|paid/.test(pricingText)) tokens.push("paid", "subscription");
      else tokens.push("freemium", "free", "paid");
    }

    if (/categor|industry|sector|niche|vertical|topic|type/.test(hint)) {
      const tags = String(config.tags || pf["Tags Keywords/Hashtags"] || "")
        .split(/[,;|/]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      tokens.push(...tags, "ai", "saas", "software", "tools", "productivity", "business", "tech");
    }

    if (/countr|region|location|market/.test(hint)) {
      tokens.push("united states", "us", "usa", "global", "worldwide", "international");
    }

    if (/lang/.test(hint)) {
      tokens.push("english", "en");
    }

    tokens.push(
      config.brandName,
      pf.Name,
      pf.Title,
      pf["PRICING TYPE"],
      pf.Pricing,
      pf["Tags Keywords/Hashtags"],
    );

    return [...new Set(tokens.filter(Boolean))];
  }

  function resolveSelectValueForField(element, config) {
    if (element.tagName.toLowerCase() !== "select") {
      return resolveSelectTokens(element, config)[0] || "";
    }
    const options = getNativeSelectOptions(element);
    if (!options.length) return "";

    const tokens = resolveSelectTokens(element, config);
    for (const token of tokens) {
      const match = findBestSelectOption(options, token);
      if (match) return match.value;
    }

    const fallback = options.find((o) => !/other|none|n\/a/i.test(o.label));
    return fallback?.value || options[0]?.value || "";
  }

  function queryCustomDropdowns(scope) {
    const root = scope || getActiveFillScope();
    return Array.from(
      root.querySelectorAll(
        '[role="combobox"]:not(select), [aria-haspopup="listbox"]:not(select), [role="listbox"][tabindex], button[aria-haspopup="listbox"]',
      ),
    ).filter((el) => isVisible(el) && isFillableField(el));
  }

  async function tryFillCustomDropdown(trigger, config) {
    const desiredTokens = resolveSelectTokens(trigger, config);
    if (!desiredTokens.length) return false;

    const current = compactText(
      [trigger.textContent, trigger.getAttribute("aria-label"), trigger.value]
        .filter(Boolean)
        .join(" "),
      120,
    );
    if (current && !/select|choose|pick|please/i.test(current)) return false;

    trigger.focus();
    trigger.click();
    await sleep(250);

    const optionSelectors = [
      '[role="option"]',
      '[role="listbox"] [role="option"]',
      '[role="listbox"] li',
      ".dropdown-menu li",
      ".dropdown-item",
      "[class*='option']",
      "[class*='Option']",
    ];
    const options = [];
    for (const sel of optionSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        const label = compactText(el.textContent, 120);
        if (!label || /^(select|choose|pick|please)/i.test(label)) continue;
        options.push({ el, label });
      }
      if (options.length) break;
    }

    for (const token of desiredTokens) {
      const n = normalizeOptionText(token);
      const match = options.find(
        (o) =>
          normalizeOptionText(o.label) === n ||
          normalizeOptionText(o.label).includes(n) ||
          n.includes(normalizeOptionText(o.label)),
      );
      if (match) {
        match.el.click();
        await sleep(150);
        return true;
      }
    }

    if (options.length) {
      options[0].el.click();
      await sleep(150);
      return true;
    }

    document.body.click();
    return false;
  }

  function getActiveFillScope() {
    const dialogSelectors = [
      "dialog[open]",
      '[role="dialog"]:not([aria-hidden="true"])',
      '[role="alertdialog"]:not([aria-hidden="true"])',
      ".modal.show",
      ".modal.in",
      '[class*="Modal"]:not([aria-hidden="true"])',
      '[class*="modal"]:not([aria-hidden="true"])',
      '[class*="popup"]:not([aria-hidden="true"])',
      '[class*="overlay"]:not([aria-hidden="true"])',
    ];
    for (const sel of dialogSelectors) {
      try {
        const candidates = document.querySelectorAll(sel);
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          const inputs = el.querySelectorAll("input, textarea, select");
          const fillable = Array.from(inputs).filter((node) => {
            if (!isFillableField(node)) return false;
            const t = (node.type || "").toLowerCase();
            return !["hidden", "submit", "button", "reset"].includes(t);
          });
          if (fillable.length > 0) return el;
        }
      } catch {
        /* invalid selector in old browsers */
      }
    }

    let bestForm = null;
    let bestScore = 0;
    for (const form of document.querySelectorAll("form")) {
      if (!isVisible(form)) continue;
      const score = queryFillableElements(form).length;
      if (score > bestScore) {
        bestScore = score;
        bestForm = form;
      }
    }
    return bestForm || document;
  }

  function queryFillableElements(scope) {
    const root = scope || getActiveFillScope();
    return Array.from(root.querySelectorAll("input, textarea, select")).filter((element) => {
      if (!isFillableField(element)) return false;
      const type = (element.type || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "reset")
        return false;
      return true;
    });
  }

  function fieldNeedsRefill(element) {
    const value = getElementFillValue(element);
    if (!value || !String(value).trim()) return false;
    const constraints = getFieldConstraints(element);
    if (constraints.maxLength && String(value).length > constraints.maxLength) return true;
    if (constraints.maxWords) {
      const wc = String(value).split(/\s+/).filter(Boolean).length;
      if (wc > constraints.maxWords) return true;
    }
    try {
      if (typeof element.checkValidity === "function" && !element.checkValidity()) return true;
    } catch {
      /* ignore */
    }
    return hasVisibleLengthError(element);
  }

  function hasVisibleLengthError(element) {
    const scope =
      element.closest("label, .field, .form-group, [class*='field'], [class*='Form']") ||
      element.parentElement;
    if (!scope) return false;
    const text = (scope.textContent || "").toLowerCase();
    return (
      /cannot be longer than|too long|maximum|max\s*\d+\s*character|字符|超出/.test(text) &&
      /(\d+)\s*\/\s*(\d+)/.test(scope.textContent || "")
    );
  }

  function pickTagline(config, element) {
    const pf = getProfileFields(config);
    const constraints = getFieldConstraints(element);
    const maxLen = constraints.maxLength || 60;
    const candidates = [
      pf["Short description(20-30 words)"],
      pf.Title,
      pf.Note,
      config.brandName,
    ].filter(Boolean);

    let text = String(candidates[0] || config.brandName || "").trim();
    const firstSentence = text.split(/(?<=[.!?])\s+/).filter(Boolean)[0] || text;
    text = firstSentence.length <= maxLen ? firstSentence : compactText(firstSentence, maxLen);
    return fitValueToConstraints(text, constraints);
  }

  function pickShortPitch(config) {
    const pf = getProfileFields(config);
    const short =
      pf["Short description(20-30 words)"] ||
      pf["Short Discription(100-150 words)"] ||
      pf.Note ||
      "";
    if (short) {
      const sentences = String(short)
        .split(/(?<=[.!?])\s+/)
        .filter(Boolean);
      if (sentences.length) return sentences.slice(0, 2).join(" ").trim();
      return compactText(short, 320);
    }
    return compactText(config.commentTemplate || config.brandName || "", 280);
  }

  function pickDescriptionForField(config, element) {
    const constraints = getFieldConstraints(element);
    const hint = getFieldHint(element);
    const pf = getProfileFields(config);

    if (
      /\b(what made you|why did you|why choose|how does|what problem|alternative|over the alternative|shoutout|review|testimonial|tips|considered)\b/.test(
        hint,
      )
    ) {
      return fitValueToConstraints(pickShortPitch(config), constraints);
    }

    if (constraints.maxWords) {
      const medium =
        pf["Short Discription(100-150 words)"] || pf["Short description(20-30 words)"] || "";
      if (medium) return fitValueToConstraints(medium, constraints);
    }

    if (constraints.maxLength && constraints.maxLength <= 320) {
      return fitValueToConstraints(
        pf["Short description(20-30 words)"] ||
          pf["Short Discription(100-150 words)"] ||
          pickShortPitch(config),
        constraints,
      );
    }

    return fitValueToConstraints(pickDescription(config), constraints);
  }

  function findCharCounter(element) {
    const searchRoots = [];
    if (element.parentElement) searchRoots.push(element.parentElement);
    if (element.nextElementSibling) searchRoots.push(element.nextElementSibling);
    if (element.parentElement?.nextElementSibling)
      searchRoots.push(element.parentElement.nextElementSibling);
    if (element.parentElement?.parentElement) searchRoots.push(element.parentElement.parentElement);

    const describedBy = element.getAttribute("aria-describedby");
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        const el = document.getElementById(id);
        if (el) searchRoots.push(el);
      }
    }

    for (const container of searchRoots) {
      if (!container?.textContent) continue;
      const text = container.textContent;
      const match = text.match(/(\d+)\s*\/\s*(\d+)/);
      if (match) {
        const max = parseInt(match[2], 10);
        if (max > 0 && max <= 5000) return { current: parseInt(match[1], 10), max };
      }
      const maxMatch = text.match(
        /(?:cannot be longer than|max(?:imum)?|limit|up to)\s*(\d+)\s*(?:character|char|字)/i,
      );
      if (maxMatch) return { max: parseInt(maxMatch[1], 10) };
    }
    return null;
  }

  function getFieldConstraints(element) {
    const label = getSnapshotLabel(element);
    const hint = getFieldHint(element);
    const combined = `${label} ${hint} ${element.getAttribute("placeholder") || ""}`;
    let maxLength = element.maxLength > 0 ? element.maxLength : null;
    let minLength = element.minLength > 0 ? element.minLength : null;
    let maxWords = null;
    let minWords = null;

    const wordRange = combined.match(/(\d+)\s*[-–to]+\s*(\d+)\s*words?/i);
    if (wordRange) {
      minWords = parseInt(wordRange[1], 10);
      maxWords = parseInt(wordRange[2], 10);
      if (!maxLength) maxLength = maxWords * 6;
    } else {
      const maxWord = combined.match(/(?:max|up to|limit)\s*(\d+)\s*words?/i);
      if (maxWord) {
        maxWords = parseInt(maxWord[1], 10);
        if (!maxLength) maxLength = maxWords * 6;
      }
    }

    const charLimit = combined.match(/(?:max|up to|limit)\s*(\d+)\s*(?:character|char)/i);
    if (charLimit) maxLength = maxLength || parseInt(charLimit[1], 10);

    const counter = findCharCounter(element);
    if (counter?.max && (!maxLength || counter.max < maxLength)) {
      maxLength = counter.max;
    }

    return { maxLength, minLength, maxWords, minWords, required: !!element.required };
  }

  function fitValueToConstraints(value, constraints) {
    if (value == null || value === "") return value;
    let text = String(value).trim();
    if (!constraints) return text;

    if (constraints.maxWords) {
      const words = text.split(/\s+/).filter(Boolean);
      if (words.length > constraints.maxWords) {
        text = words.slice(0, constraints.maxWords).join(" ");
        if (!/[.!?]$/.test(text)) text += ".";
      }
    }

    if (constraints.maxLength && text.length > constraints.maxLength) {
      text = text.slice(0, constraints.maxLength);
      const lastSpace = text.lastIndexOf(" ");
      if (lastSpace > constraints.maxLength * 0.65) text = text.slice(0, lastSpace);
      text = text.trim();
      if (text && !/[.!?]$/.test(text)) text += ".";
    }

    if (constraints.minLength && text.length < constraints.minLength) {
      return text;
    }

    return text;
  }

  function getElementFillValue(element) {
    const type = (element.type || "").toLowerCase();
    if (type === "file") return element.files?.length ? element.files[0].name : "";
    if (element.tagName.toLowerCase() === "select") return element.value || "";
    return element.value || "";
  }

  function collectFilledFieldsReport() {
    const fields = [];
    const issues = [];
    let invalidCount = 0;

    for (const element of queryFillableElements()) {
      const type = (element.type || "").toLowerCase();
      const value = getElementFillValue(element);
      if (!value || !String(value).trim()) continue;

      const constraints = getFieldConstraints(element);
      const length = String(value).length;
      const fieldIssues = [];

      if (constraints.maxLength && length > constraints.maxLength) {
        fieldIssues.push(
          `超出 ${length - constraints.maxLength} 字符（限制 ${constraints.maxLength}）`,
        );
      }
      if (constraints.maxWords) {
        const wordCount = String(value).split(/\s+/).filter(Boolean).length;
        if (wordCount > constraints.maxWords) {
          fieldIssues.push(
            `超出 ${wordCount - constraints.maxWords} 词（限制 ${constraints.maxWords} 词）`,
          );
        }
      }

      let htmlInvalid = false;
      try {
        htmlInvalid = typeof element.checkValidity === "function" && !element.checkValidity();
      } catch {
        /* ignore */
      }
      if (htmlInvalid) {
        fieldIssues.push(element.validationMessage || "HTML 校验未通过");
        invalidCount++;
      }
      if (fieldIssues.length) invalidCount++;

      fields.push({
        selector: extSelector(element),
        label: getSnapshotLabel(element),
        name: element.getAttribute("name") || "",
        type,
        value: String(value),
        length,
        wordCount: String(value).split(/\s+/).filter(Boolean).length,
        constraints,
        issues: fieldIssues,
        invalid: fieldIssues.length > 0 || htmlInvalid,
        validationMessage: element.validationMessage || "",
      });
      issues.push(...fieldIssues.map((i) => `${getSnapshotLabel(element) || element.name}: ${i}`));
    }

    return {
      fields,
      issues,
      invalidCount,
      allValid: invalidCount === 0 && issues.length === 0,
    };
  }

  async function applyFieldCorrections(corrections) {
    let applied = 0;
    for (const item of corrections) {
      if (!item || !item.selector) continue;
      const element = document.querySelector(item.selector);
      if (!element || !isFillableField(element)) continue;
      const constraints = getFieldConstraints(element);
      const value = fitValueToConstraints(String(item.value ?? ""), constraints);
      if (!value) continue;
      await simulateTyping(element, value);
      applied++;
    }
    return { applied, report: collectFilledFieldsReport() };
  }

  function getScreenshotValues(config) {
    if (self.ExtLinkProfiles?.getScreenshotValuesFromConfig) {
      return self.ExtLinkProfiles.getScreenshotValuesFromConfig(config);
    }
    const pf = getProfileFields(config);
    const configured = Array.isArray(config.screenshots) ? config.screenshots : [];
    const values = configured.length
      ? configured
      : [1, 2, 3, 4].map(
          (index) => pf[`Screenshot ${index}`] || pf[`Screenshot-${index}`] || "",
        );
    return values.map((value) => String(value || "").trim()).filter(Boolean);
  }

  function isScreenshotFileField(element) {
    const hint = getFieldHint(element);
    return /\b(screenshot|screen shot|gallery|product image|app image|interface image)\b/.test(
      hint,
    );
  }

  function resolveFileMedia(config, element, fallbackScreenshotIndex = 0) {
    const pf = getProfileFields(config);
    const hint = getFieldHint(element);
    if (self.ExtLinkProfiles?.resolveMediaField) {
      return self.ExtLinkProfiles.resolveMediaField(
        config,
        hint,
        fallbackScreenshotIndex,
      );
    }
    if (isScreenshotFileField(element)) {
      const screenshots = getScreenshotValues(config);
      const explicit = hint.match(
        /\b(?:screenshot|screen shot|gallery|image|photo)[^\d]{0,8}([1-4])\b/,
      );
      const index = explicit ? Number(explicit[1]) - 1 : fallbackScreenshotIndex;
      return {
        value: screenshots[index] || screenshots[fallbackScreenshotIndex] || "",
        profileKey: `Screenshot ${index + 1}`,
        useLogoDataUrl: false,
        screenshot: true,
        explicitIndex: !!explicit,
      };
    }
    if (/\b(logo|icon|avatar)\b/.test(hint)) {
      return {
        value: pf.LOGO || config.logoUrl || pf["Featured image"] || config.featuredImage || "",
        profileKey: "LOGO",
        useLogoDataUrl: true,
        screenshot: false,
        explicitIndex: false,
      };
    }
    if (/\b(featured|cover|banner|thumbnail|image|photo)\b/.test(hint)) {
      return {
        value: pf["Featured image"] || config.featuredImage || config.logoUrl || pf.LOGO || "",
        profileKey: "Featured image",
        useLogoDataUrl: false,
        screenshot: false,
        explicitIndex: false,
      };
    }
    return {
      value: "",
      profileKey: "",
      useLogoDataUrl: false,
      screenshot: false,
      explicitIndex: false,
    };
  }

  function resolveValueForField(config, element) {
    const pf = getProfileFields(config);
    const hint = getFieldHint(element);
    const type = (element.type || "").toLowerCase();
    const tag = element.tagName.toLowerCase();
    const host = location.hostname;
    const learned =
      config.learnedFieldMappings &&
      config.learnedFieldMappings[host] &&
      config.learnedFieldMappings[host][element.name || element.id];

    if (learned) {
      const constraints = getFieldConstraints(element);
      if (learned.value) return fitValueToConstraints(learned.value, constraints);
      if (learned.profileKey && pf[learned.profileKey]) {
        return fitValueToConstraints(pf[learned.profileKey], constraints);
      }
    }

    if (type === "file") {
      return resolveFileMedia(config, element).value;
    }

    if (tag === "select") {
      return resolveSelectValueForField(element, config);
    }

    if (type === "email" || /\b(e-?mail|email address)\b/.test(hint)) {
      return config.email || pf["Business mail"] || pf["Feedback mail"] || "";
    }

    if (
      /\b(tool name|product name|name of tool|name of the tool|app name|startup name|company name)\b/.test(
        hint,
      )
    ) {
      return config.brandName || pf.Name || "";
    }

    if (
      /\b(your name|submitter|contact name|full name|author)\b/.test(hint) &&
      !/\btool\b|\bproduct\b/.test(hint)
    ) {
      return config.username || "";
    }

    if (type === "url" || /\b(url of|tool url|product url|website|homepage)\b/.test(hint)) {
      return config.targetDomain || pf.Url || "";
    }

    if (/\btagline\b/.test(hint) || /\b(one.?liner|elevator pitch|subtitle)\b/.test(hint)) {
      return pickTagline(config, element);
    }

    {
      const fieldConstraints = getFieldConstraints(element);
      if (
        fieldConstraints.maxLength &&
        fieldConstraints.maxLength <= 80 &&
        type !== "url" &&
        tag !== "textarea"
      ) {
        return pickTagline(config, element);
      }
    }

    if (/\b(tags|keywords|hashtags|categories|category)\b/.test(hint)) {
      return config.tags || pf["Tags Keywords/Hashtags"] || "";
    }

    if (
      tag === "textarea" ||
      /\b(describ|description|summary|about|detail|what the tool|what does)/.test(hint)
    ) {
      return pickDescriptionForField(config, element);
    }

    if (/\b(title|subject|headline)\b/.test(hint) && type !== "url") {
      return fitValueToConstraints(
        pf.Title || config.brandName || "",
        getFieldConstraints(element),
      );
    }

    if (
      /\b(name of the launch|launch name|software name|product name|tool name|app name)\b/.test(
        hint,
      )
    ) {
      return config.brandName || pf.Name || "";
    }

    if (/\bname\b/.test(hint) && !/\btool\b|\bproduct\b|\bcompany\b/.test(hint) && type !== "url") {
      return config.username || config.brandName || pf.Name || "";
    }

    if (/\b(url|link|website)\b/.test(hint)) {
      return config.targetDomain || pf.Url || "";
    }

    for (const [key, val] of Object.entries(pf)) {
      if (!val || String(val).length < 4) continue;
      const keyNorm = key.toLowerCase();
      if (keyNorm.includes("desc") && /\bdesc/.test(hint)) {
        return fitValueToConstraints(val, getFieldConstraints(element));
      }
      if (keyNorm.includes("tag") && /\btag/.test(hint)) return val;
      if (keyNorm.includes("pric") && /\bpric/.test(hint)) return val;
      if (keyNorm.includes("mail") && /\bmail/.test(hint)) return val;
    }

    return "";
  }

  async function fillSelectField(element, value) {
    if (!value) return false;
    return setSelectValue(element, value);
  }

  async function tryFillFileFromUrl(input, imageUrl, baseUrl, config, useLogoDataUrl = false) {
    if (!input || input.type !== "file") return false;

    const dataUrl = useLogoDataUrl ? config?.logoDataUrl : "";
    if (dataUrl && String(dataUrl).startsWith("data:")) {
      return fillFileInputFromDataUrl(input, dataUrl);
    }

    if (!imageUrl) return false;
    let absolute = imageUrl;
    try {
      absolute = new URL(imageUrl, baseUrl || location.href).href;
      const resp = await fetch(absolute);
      if (!resp.ok) return false;
      const blob = await resp.blob();
      const name = absolute.split("/").pop()?.split("?")[0] || "logo.png";
      const file = new File([blob], name, { type: blob.type || "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  async function fillFileInputFromDataUrl(input, dataUrl) {
    try {
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const mime = blob.type || "image/png";
      const ext = mime.split("/")[1]?.split("+")[0] || "png";
      const file = new File([blob], `logo.${ext}`, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  function fieldMappingKey(element) {
    return element.name || element.id || getFieldHint(element).slice(0, 80);
  }

  function inferProfileKeyForValue(config, value) {
    const pf = getProfileFields(config);
    const v = String(value || "").trim();
    if (!v) return "";
    for (const [key, val] of Object.entries(pf)) {
      if (String(val).trim() === v) return key;
    }
    if (v === config.email) return "Business mail";
    if (v === config.brandName) return "Name";
    if (v === config.targetDomain) return "Url";
    if (v === config.username) return "username";
    if (v === config.tags) return "Tags Keywords/Hashtags";
    return "";
  }

  async function smartFillFromConfig(config) {
    logStep("🧠 智能填写全部表单字段…");
    const pf = getProfileFields(config);
    const baseUrl = config.targetDomain || pf.Url || location.href;
    const elements = queryFillableElements();
    let filledCount = 0;
    const mappings = {};
    const skippedFiles = [];
    let screenshotCursor = 0;

    for (const element of elements) {
      const type = (element.type || "").toLowerCase();
      const tag = element.tagName.toLowerCase();

      if (tag === "select") {
        if (!isSelectEmpty(element) && !fieldNeedsRefill(element)) continue;
        const selectValue = resolveSelectValueForField(element, config);
        if (selectValue && setSelectValue(element, selectValue)) {
          filledCount++;
          mappings[fieldMappingKey(element)] = {
            profileKey: inferProfileKeyForValue(config, selectValue) || "select",
            value: selectValue,
            label: getSnapshotLabel(element),
          };
        }
        continue;
      }

      const media =
        type === "file" ? resolveFileMedia(config, element, screenshotCursor) : null;
      const value = media ? media.value : resolveValueForField(config, element);
      if (!value && type !== "file") {
        if (fieldNeedsRefill(element)) {
          /* fall through to re-fill below */
        } else continue;
      }

      if (type === "file") {
        if (element.files?.length) continue;
        const ok = await tryFillFileFromUrl(
          element,
          value,
          baseUrl,
          config,
          media?.useLogoDataUrl === true,
        );
        if (ok) {
          filledCount++;
          mappings[fieldMappingKey(element)] = {
            profileKey: media?.profileKey || "Featured image",
            value,
            label: getSnapshotLabel(element),
          };
        } else if (value) {
          skippedFiles.push(getSnapshotLabel(element) || element.name || "image");
        }
        if (media?.screenshot && !media.explicitIndex) screenshotCursor++;
        continue;
      }

      const existing = element.value && String(element.value).trim();
      if (existing && !fieldNeedsRefill(element)) continue;

      const resolved = value || resolveValueForField(config, element);
      if (!resolved) continue;

      logStep(
        `✏️ ${getSnapshotLabel(element) || element.name || type} → ${String(resolved).slice(0, 40)}…`,
      );
      const fitted = fitValueToConstraints(String(resolved), getFieldConstraints(element));
      await simulateTyping(element, fitted);
      filledCount++;
      mappings[fieldMappingKey(element)] = {
        profileKey: inferProfileKeyForValue(config, fitted),
        value: fitted,
        label: getSnapshotLabel(element),
      };
    }

    for (const trigger of queryCustomDropdowns()) {
      if (!isCustomDropdownEmpty(trigger)) continue;
      const ok = await tryFillCustomDropdown(trigger, config);
      if (ok) {
        filledCount++;
        mappings[fieldMappingKey(trigger)] = {
          profileKey: "select",
          value: compactText(trigger.textContent, 120),
          label: getSnapshotLabel(trigger),
        };
      }
    }

    return { filledCount, mappings, skippedFiles };
  }

  function isCustomDropdownEmpty(trigger) {
    const current = compactText(
      [trigger.textContent, trigger.getAttribute("aria-label"), trigger.value]
        .filter(Boolean)
        .join(" "),
      120,
    );
    return !current || /^(select|choose|pick|please|--)/i.test(current);
  }

  function countEmptyFillableFields() {
    const elements = queryFillableElements();
    const customDropdowns = queryCustomDropdowns();
    let emptyCount = 0;
    let invalidCount = 0;
    const totalCount = elements.length + customDropdowns.length;

    for (const element of elements) {
      const type = (element.type || "").toLowerCase();
      if (type === "file") {
        if (!element.files || element.files.length === 0) emptyCount++;
        continue;
      }
      const tag = element.tagName.toLowerCase();
      if (tag === "select" && isSelectEmpty(element)) {
        emptyCount++;
        continue;
      }
      const value = getElementFillValue(element);
      if (!value || !String(value).trim()) {
        emptyCount++;
        continue;
      }
      if (fieldNeedsRefill(element)) invalidCount++;
    }

    for (const trigger of customDropdowns) {
      if (isCustomDropdownEmpty(trigger)) emptyCount++;
    }

    return {
      emptyCount,
      invalidCount,
      totalCount,
      allValid: emptyCount === 0 && invalidCount === 0,
    };
  }

  function collectFillLearnings(config) {
    const mappings = {};
    const elements = queryFillableElements();
    for (const element of elements) {
      if (!isFillableField(element)) continue;
      const type = (element.type || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button") continue;
      let val = "";
      if (element.tagName.toLowerCase() === "select") val = element.value;
      else if (type === "file") val = element.files?.length ? element.files[0].name : "";
      else val = element.value;
      if (!val || !String(val).trim()) continue;
      const key = fieldMappingKey(element);
      mappings[key] = {
        profileKey: inferProfileKeyForValue(config, val),
        value: String(val).trim(),
        label: getSnapshotLabel(element),
      };
    }
    return { mappings };
  }

  function isFillableField(element) {
    if (element.disabled || element.readOnly) return false;
    if (!isVisible(element)) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    return true;
  }

  // ─── Captcha Detection ───
  function detectCaptcha() {
    // reCAPTCHA
    if (
      document.querySelector(
        '.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="captcha"], .grecaptcha-badge',
      )
    )
      return true;
    // hCaptcha
    if (document.querySelector('.h-captcha, iframe[src*="hcaptcha"]')) return true;
    // Cloudflare Turnstile
    if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare"]')) return true;
    // Image captcha
    if (document.querySelector('img[src*="captcha"], img.captcha, img[alt*="captcha" i]'))
      return true;
    // Generic captcha input
    if (
      document.querySelector(
        'input[name*="captcha"], input[id*="captcha"], input[placeholder*="captcha" i]',
      )
    )
      return true;
    // Math captcha
    if (document.querySelector('input[name*="math"], input[name*="spam"]')) return true;
    // OTP / Verification code
    if (
      document.querySelector(
        'input[name*="code"], input[name*="otp"], input[name*="verification"], input[name*="emailCode"]',
      )
    )
      return true;

    return false;
  }

  function highlightCaptchaArea() {
    const captchaEl = document.querySelector(
      '.g-recaptcha, .h-captcha, iframe[src*="captcha"], iframe[src*="recaptcha"], ' +
        'img[src*="captcha"], .captcha',
    );
    if (captchaEl) {
      captchaEl.style.outline = "4px solid #eab308";
      captchaEl.style.outlineOffset = "4px";
      captchaEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function findSubmitButton(selector, textMatches) {
    const directMatch = safeQuerySelector(selector);
    if (directMatch && isVisible(directMatch)) return directMatch;

    const labels = textMatches.map((text) => text.toLowerCase());
    const candidates = Array.from(
      document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], a[role="button"], .button, .btn',
      ),
    );

    return (
      candidates.find((el) => {
        if (!isVisible(el)) return false;
        const label = getElementLabel(el);
        return labels.some((text) => label.includes(text));
      }) || null
    );
  }

  function safeQuerySelector(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function getElementLabel(el) {
    return [
      el.innerText,
      el.textContent,
      el.value,
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("title"),
      el.id,
      el.name,
    ]
      .filter(Boolean)
      .join(" ")
      .trim()
      .toLowerCase();
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
      return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ─── Rel Verification ───
  async function verifyRel(domain) {
    const domainClean = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
    const result = { isDofollow: false, rel: "not_found", links: [] };

    // Wait for page updates after submission
    await sleep(2000);

    const links = document.querySelectorAll(`a[href*="${domainClean}"]`);
    if (links.length === 0) {
      result.rel = "not_found";
      return result;
    }

    let allDofollow = true;
    for (const link of links) {
      const rel = (link.rel || "").trim();
      result.links.push({ href: link.href, rel });
      if (rel.includes("nofollow") || rel.includes("ugc") || rel.includes("sponsored")) {
        allDofollow = false;
      }
    }

    result.isDofollow = allDofollow && links.length > 0;
    result.rel = links.map((l) => l.rel || "EMPTY").join("|");
    return result;
  }

  // ─── Comment Generation ───
  function generateComment(config) {
    if (config.commentTemplate) return config.commentTemplate;

    const templates = [
      `Great insights on this topic. I've been researching similar approaches for my own work and found this really helpful. Thanks for sharing!`,
      `This is exactly what I was looking for. The explanation is clear and practical. I appreciate you taking the time to write this up.`,
      `Interesting perspective! I've been working in this space for a while and your analysis resonates with what I've seen. Looking forward to more content like this.`,
      `Solid write-up. I especially appreciate the practical examples you included - they make the concepts much easier to understand and apply.`,
      `Thanks for putting this together. It's rare to find such well-organized information on this subject. Bookmarking this for reference.`,
      `Really valuable content here. I've shared this with my team as we're working on something similar. The methodology you outlined is particularly useful.`,
      `Excellent breakdown. The step-by-step approach makes it really accessible. I've been looking for a resource like this for a while now.`,
      `This is a thoughtful analysis. I particularly agree with the point about practical implementation being more important than theory. Well done.`,
      `Great resource! I found the technical details especially helpful. It's clear you have deep experience with this topic. Keep up the great work.`,
      `Very informative read. I learned several new things from this article. The examples helped clarify the more complex concepts really well.`,
    ];

    return templates[Math.floor(Math.random() * templates.length)];
  }

  function generateDescription(config) {
    if (config.commentTemplate) return config.commentTemplate;
    if (config.note) {
      return `${config.brandName} — ${config.note}`;
    }
    return `${config.brandName} is a productivity tool that helps teams work more efficiently. Features include task automation, real-time collaboration, and seamless integrations with popular platforms.`;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Auto-resume after captcha (polling) ───
  // Check periodically if captcha is gone (user solved it)
  if (detectCaptcha()) {
    const checkInterval = setInterval(() => {
      if (!detectCaptcha()) {
        clearInterval(checkInterval);
        // Notify background that captcha is resolved
        chrome.runtime
          .sendMessage({
            action: "captchaResolved",
          })
          .catch(() => {});
      }
    }, 3000);
  }
})();
