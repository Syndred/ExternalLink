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
  const SNAPSHOT_TEXT_LIMIT = 6000;
  const ACTION_WAIT_LIMIT_MS = 5000;
  const VISUAL_OVERLAY_ATTR = "data-extlink-visual-overlay";
  const SENSITIVE_URL_PARAM_PATTERN = /token|key|secret|code|session|csrf|nonce/i;
  const PRODUCT_HUNT_STAGES = Object.freeze([
    "entry",
    "main_info",
    "images",
    "makers",
    "company_info",
    "shoutouts",
    "extras",
    "investors",
    "checklist",
  ]);
  const PRODUCT_HUNT_OPTIONAL_STAGES = new Set(["shoutouts", "investors"]);

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
    if (msg.action === "submitFilledForm") {
      submitFilledForm(msg.config || {}, msg.platform || "directory")
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (msg.action === "runProductHuntStep" || msg.type === "runProductHuntStep") {
      runProductHuntStep(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, stage: "gate", error: err.message }));
      return true;
    }
    if (msg.action === "classifySubmitEvidence") {
      sendResponse(classifyVisibleEvidence());
      return true;
    }
    if (msg.action === "countEmptyFields") {
      sendResponse(countEmptyFillableFields());
      return true;
    }
    if (msg.action === "collectFormValidation") {
      sendResponse(collectFormValidationState());
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
        const playbook =
          self.ExtLinkPlaybooks && typeof self.ExtLinkPlaybooks.lookup === "function"
            ? self.ExtLinkPlaybooks.lookup(location.href)
            : null;
        sendResponse({
          url: location.href,
          hostname: location.hostname,
          platform: platform || snapshot.meta.platform,
          operable,
          commentFound: hasComment,
          standardWpComment: inspectStandardWpCommentForm().ok,
          playbook: playbook
            ? { id: playbook.id, title: playbook.title, notes: playbook.notes, hints: playbook.hints || [] }
            : null,
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
    if (msg.action === "prepareVisualSnapshot") {
      sendResponse(prepareVisualSnapshot());
      return true;
    }
    if (msg.action === "clearVisualSnapshot") {
      clearVisualSnapshot();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "executeSubmit") {
      executeSubmit(msg.config, msg.platformType, msg.taskIndex)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // keep channel open for async
    }
    if (msg.action === "finalizeSubmit") {
      finalizeSubmit(msg.config, msg.taskIndex)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.action === "trySubmit") {
      // User clicked "继续填表" from overlay banner
      removeWaitingBanner();
      executeSubmit(msg.config, msg.platformType, msg.taskIndex)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.action === "prescanPage") {
      try {
        sendResponse({ ok: true, ...prescanPage() });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return true;
    }
    if (msg.action === "generateCommentPreview") {
      generateComment(msg.config || {}, {
        preferTemplate: false,
        count: msg.count || 1,
        refresh: msg.refresh === true,
      })
        .then((text) => sendResponse({ ok: !!text, text }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.action === "setManualFillIcons") {
      if (msg.enabled === false) teardownManualIcons();
      else initManualIcons();
      sendResponse({ ok: true });
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
      if (manualIconsEnabled) scheduleManualIconSync();
      else initManualIcons().catch(() => {});
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
    setTimeout(() => {
      initManualIcons().catch(() => {});
    }, 800);

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

  function fieldHasValue(element) {
    return !!String(element?.value || "").trim();
  }

  function inspectStandardWpCommentForm() {
    if (window.top !== window) {
      return { ok: false, reason: "iframe" };
    }
    const form = document.querySelector("#commentform, form.comment-form");
    if (!form) return { ok: false, reason: "no_standard_form" };
    const author = form.querySelector('#author, input[name="author"]');
    const email = form.querySelector('#email, input[name="email"], input[type="email"]');
    const url = form.querySelector('#url, input[name="url"], input[name="website"]');
    const comment = form.querySelector('#comment, textarea[name="comment"]');
    const submit = form.querySelector(
      '#submit, input[type="submit"][name="submit"], button[type="submit"], input.comment-submit, button.comment-submit',
    );
    if (!author || !email || !url || !comment || !submit) {
      return { ok: false, reason: "incomplete_fields", form, author, email, url, comment, submit };
    }
    if (typeof detectCaptcha === "function" && detectCaptcha()) {
      return { ok: false, reason: "captcha", form, author, email, url, comment, submit };
    }
    return { ok: true, form, author, email, url, comment, submit };
  }

  function shouldAutoSubmitListing(config, platform) {
    if (config && config.fillOnly === true) return false;
    if (platform === "wp_comment" || platform === "article") return false;
    if (platform === "forum" || platform === "profile") return false;
    return config?.autoSubmitDirectory !== false;
  }

  function detectPaidSubmit() {
    const submitBtn = findSubmitButton(
      'button[type="submit"], input[type="submit"]',
      ["submit", "add", "list", "publish", "pay", "buy", "checkout", "upgrade"],
    );
    const label = submitBtn ? getElementLabel(submitBtn) : "";
    if (/\$\d+|pay now|checkout|upgrade to|buy listing|fast.?track|premium only/i.test(label)) {
      return "当前提交按钮是付费入口";
    }
    const text = String(document.body?.innerText || "").slice(0, 4000).toLowerCase();
    const hasFreeSubmit = /free (submit|listing|launch)|submit for free|no credit card/.test(text);
    if (
      !hasFreeSubmit &&
      /this listing is paid|unlock with|choose a paid plan|upgrade to submit/.test(text)
    ) {
      return "页面要求付费后才能提交";
    }
    return "";
  }

  function detectSubmitBlockers() {
    if (typeof detectCaptcha === "function" && detectCaptcha()) return { captcha: true };
    if (document.querySelector('input[type="password"]')) {
      return { needs_manual: true, reason: "需要登录或注册" };
    }
    const paid = detectPaidSubmit();
    if (paid) return { blocked: true, reason: paid };
    return null;
  }

  function shouldAutoSubmitStandardWp(config, preflight) {
    if (!config || config.autoSubmitStandardWpComments !== true) return false;
    if (!preflight?.ok) return false;
    if (typeof detectCaptcha === "function" && detectCaptcha()) return false;
    return (
      fieldHasValue(preflight.author) &&
      fieldHasValue(preflight.email) &&
      fieldHasValue(preflight.url) &&
      fieldHasValue(preflight.comment)
    );
  }

  function classifyVisibleEvidence() {
    const text = `${document.title || ""} ${document.body?.innerText || ""}`.replace(/\s+/g, " ").trim();
    const playbook =
      self.ExtLinkPlaybooks && typeof self.ExtLinkPlaybooks.lookup === "function"
        ? self.ExtLinkPlaybooks.lookup(location.href)
        : null;
    if (self.ExtLinkPlaybooks && typeof self.ExtLinkPlaybooks.classifyEvidence === "function") {
      return self.ExtLinkPlaybooks.classifyEvidence(text, playbook);
    }
    const lower = text.toLowerCase();
    if (/awaiting moderation|held for moderation|pending moderation|comment is awaiting/.test(lower)) {
      return { publicationStatus: "pending_moderation", evidence: "comment awaiting moderation", matched: true };
    }
    return { publicationStatus: "submitted", evidence: "", matched: false };
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
      }).catch(() => {});
    });
    document.getElementById("__extlink_skip_btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        action: "manualSkip",
        taskIndex: taskIndex,
      }).catch(() => {});
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
        }).catch(() => {});
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
      </style>
      <div class="__extlink_msg">
        ⏸ <strong>需要人工处理</strong>：<span id="__extlink_manual_reason"></span><br>
        完成登录/验证码后点击 <strong>继续下一步</strong>，AI 会自动继续填表并提交。
      </div>
      <div class="__extlink_countdown" id="__extlink_manual_countdown"></div>
      <button class="__extlink_skip" id="__extlink_manual_skip_btn">跳过</button>
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
      }).catch(() => {});
      removeManualWaitBanner();
    });
    document.getElementById("__extlink_manual_skip_btn")?.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "manualSkip", taskIndex: taskIndex }).catch(() => {});
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

  // ---------------------------------------------------------------------------
  // Product Hunt launch workflow
  // ---------------------------------------------------------------------------
  // Product Hunt is a React/SPA launch wizard, not an ordinary directory form.
  // Keep its stage detection and the final-button policy local and deterministic:
  // the AI action-plan route must never gain a free-form click/submit capability.
  function isProductHuntPage() {
    return /(^|\.)producthunt\.com$/i.test(String(location.hostname || ""));
  }

  function normalizeProductHuntText(value) {
    return String(value || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function productHuntSnapshotText(snapshot = {}) {
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
    const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
    const widgets = Array.isArray(snapshot.widgets) ? snapshot.widgets : [];
    return normalizeProductHuntText(
      [
        snapshot.title,
        snapshot.text,
        fields
          .map((field) =>
            [field.label, field.name, field.id, field.placeholder, field.aria, field.text]
              .filter(Boolean)
              .join(" "),
          )
          .join(" "),
        buttons
          .map((button) => productHuntSnapshotButtonLabel(button))
          .join(" "),
        widgets
          .map((widget) => [widget.label, widget.role].filter(Boolean).join(" "))
          .join(" "),
      ].filter(Boolean).join(" "),
    );
  }

  function productHuntFieldSnapshotHint(field) {
    return normalizeProductHuntText(
      [field?.label, field?.name, field?.id, field?.placeholder, field?.aria, field?.text]
        .filter(Boolean)
        .join(" "),
    );
  }

  function productHuntFieldSnapshotChecked(field) {
    if (!field) return false;
    if (field.checked === true || field.selected === true) return true;
    if (field.value && typeof field.value === "object") {
      return field.value.checked === true || field.value.selected === true;
    }
    return /^(true|checked|on|yes)$/i.test(String(field["aria-checked"] || ""));
  }

  function productHuntSnapshotButtonLabel(button = {}) {
    return compactText(
      [button.text, button.value, button.aria, button.title].find((value) => value && String(value).trim()) || "",
      180,
    );
  }

  function productHuntGateFromSnapshot(snapshot = {}) {
    const text = productHuntSnapshotText(snapshot);
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
    const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
    const fieldHints = fields.map(productHuntFieldSnapshotHint);
    const buttonHints = buttons
      .map((button) => normalizeProductHuntText(productHuntSnapshotButtonLabel(button)))
      .filter(Boolean);

    // Keep CAPTCHA ahead of OTP because the generic detector historically treats
    // every verification-code input as a captcha. Product Hunt needs the two gates
    // to remain recoverable and separately visible in the batch ledger.
    if (
      snapshot.captcha === true ||
      /captcha|recaptcha|hcaptcha|turnstile|cloudflare challenge|verify you are human/.test(text)
    ) {
      return "captcha";
    }

    const hasPassword = fields.some((field) => String(field.type || "").toLowerCase() === "password") ||
      fieldHints.some((hint) => /password/.test(hint));
    if (
      snapshot.login === true ||
      hasPassword ||
      /log in to continue|sign in to continue|log in to submit|sign in to submit|you must log in|please log in|please sign in/.test(
        text,
      ) ||
      buttonHints.some((hint) => /^(log in|login|sign in|signin)$/.test(hint))
    ) {
      return "login";
    }

    if (
      snapshot.otp === true ||
      fields.some((field, index) => {
        const hint = fieldHints[index];
        return /\b(?:otp|one[- ]?time|verification|security)\s*(?:code|token)?\b/.test(hint) ||
          /(?:verification|security|email)[-_ ]?code/.test(String(field.name || field.id || ""));
      }) ||
      /enter (?:the )?(?:verification|security|one[- ]?time) code|check your email for (?:a )?code/.test(
        text,
      )
    ) {
      return "otp";
    }

    const paymentButton = buttonHints.some((hint) =>
      /^(?:promote|boost|pay(?: now)?|checkout|upgrade|buy|sponsor)(?:\b|\s)/.test(hint),
    );
    if (
      snapshot.pay === true ||
      paymentButton ||
      /payment required|credit card required|paid plan required|choose a paid plan|checkout to continue|promote this launch|boost this launch/.test(
        text,
      )
    ) {
      return "pay";
    }

    const legalField = fields.some((field, index) => {
      const hint = fieldHints[index];
      const type = String(field.type || "").toLowerCase();
      const unchecked = !productHuntFieldSnapshotChecked(field);
      return (
        unchecked &&
        (type === "checkbox" || /checkbox|check box/.test(hint)) &&
        /terms|privacy|legal|consent|agree|accept|conditions|条款|隐私|同意/.test(hint)
      );
    });
    if (
      snapshot.legal === true ||
      legalField ||
      /(?:agree|accept|confirm) (?:to|the) (?:terms|privacy|legal)|terms of (?:use|service) must be accepted|legal confirmation required/.test(
        text,
      )
    ) {
      return "legal";
    }

    return "";
  }

  function productHuntStageFromSnapshot(snapshot = {}) {
    if (productHuntGateFromSnapshot(snapshot)) return "gate";
    const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
    const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
    const fieldHints = fields.map(productHuntFieldSnapshotHint);
    const buttonLabels = buttons.map((button) =>
      productHuntNormalizeButtonLabel(productHuntSnapshotButtonLabel(button)),
    );
    const hasField = (pattern) => fieldHints.some((hint) => pattern.test(hint));
    const hasButton = (pattern) => buttonLabels.some((label) => pattern.test(label));
    const hasCreateDraft = buttonLabels.some((label) => productHuntButtonPolicy(label, "create"));
    const text = productHuntSnapshotText(snapshot);

    // The left stepper renders every stage label in the DOM. Prefer the
    // currently editable field IDs and the exact "Next step: ..." action so
    // those navigation labels cannot make every page look like checklist.
    if (
      hasButton(/^continue editing$/) &&
      /my products|products?\s*(?:&|and)\s*launches|drafts?/.test(text)
    ) {
      return "entry";
    }
    if (hasButton(/^launch in progress$/) && /\bin progress\b/.test(text)) return "entry";
    if (hasCreateDraft || (/100\s*%\s*(?:complete|completed)/.test(text) && /complete/.test(text))) {
      return "checklist";
    }
    // The exact next-step action is a stronger stage signal than hidden
    // controls that may remain mounted while React transitions between panes.
    if (hasButton(/^next step: images and media$/)) return "main_info";
    if (hasButton(/^next step: makers$/)) return "images";
    if (hasButton(/^next step: company info$/)) return "makers";
    // Product Hunt currently exposes Company info as a separate pane but
    // keeps the next action labelled “Next step: Shoutouts”. Detect its
    // authoritative hidden state controls before applying the navigation label
    // so we do not run the Makers filler twice on this intermediate step.
    if (
      hasField(/(?:^|\b)(?:bootstrapped|yccompany|have raised vc funding|haveraisedvcfunding|team size|teamsize|crunchbase url|crunchbaseurl)(?:\b|$)/)
    ) {
      return "company_info";
    }
    if (hasButton(/^next step: shoutouts$/)) return "makers";
    if (hasButton(/^next step: extras$/)) return "shoutouts";
    if (hasButton(/^next step: connect with investors$/)) return "extras";
    if (hasButton(/^next step: launch checklist$/)) return "investors";
    if (hasField(/(?:^|\b)(?:pricingtype|free options?|pricing|price)(?:\b|$)/)) return "extras";
    if (hasField(/file-input-(?:thumbnailimageuuid|media)|(?:gallery|product image|screenshot|logo)/)) return "images";
    if (
      hasField(/(?:product name|tagline|one[- ]?liner|commentbody|website|homepage|description|product url)/) ||
      hasField(/(?:^|\b)(?:name|tagline|topics?)(?:\b|$)/)
    ) {
      return "main_info";
    }
    return "unknown";
  }

  function productHuntNormalizeButtonLabel(label) {
    return normalizeProductHuntText(label)
      .replace(/[\u2192\u2194>»]+$/g, "")
      .replace(/[.!:]+$/g, "")
      .trim();
  }

  function productHuntButtonPolicy(label, kind = "advance") {
    const normalized = productHuntNormalizeButtonLabel(label);
    if (!normalized) return false;
    if (kind === "create") return normalized === "create draft";
    if (kind === "skip") {
      return /^(?:skip|skip for now|not now|no thanks|later|跳过|暂不|以后再说)$/.test(normalized);
    }
    if (/^next step: (?:images and media|makers|company info|shoutouts|extras|connect with investors|launch checklist)$/.test(normalized)) {
      return true;
    }
    if (/schedule launch|promote|boost|pay|checkout|upgrade|buy|sponsor|create draft|agree|accept|log in|sign in|publish|launch/.test(normalized)) {
      return false;
    }
    return /^(?:next|continue|proceed|save and continue|下一步|继续|保存并继续)$/.test(normalized);
  }

  function productHuntShouldClickCreateDraft(confirmCreate, checklistReady, label) {
    return confirmCreate === true && checklistReady === true && productHuntButtonPolicy(label, "create");
  }

  function productHuntConfigValues(config = {}) {
    const nested =
      config.productHunt && typeof config.productHunt === "object"
        ? config.productHunt
        : config.producthunt && typeof config.producthunt === "object"
          ? config.producthunt
          : {};
    const pf = getProfileFields(config);
    const first = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || "";
    const list = (value) => {
      if (Array.isArray(value)) return value.flatMap((item) => list(item));
      if (value && typeof value === "object") {
        return list(value.url || value.ref || value.value || value.source || "");
      }
      const raw = String(value || "").trim();
      if (!raw) return [];
      if (/^data:/i.test(raw) || /^cloud-media:\/\//i.test(raw) || /^https?:\/\//i.test(raw)) return [raw];
      return raw.split(/[\n;|]+/).map((item) => item.trim()).filter(Boolean);
    };
    const logoValue = nested.logo && typeof nested.logo === "object"
      ? nested.logo
      : first(nested.logo, nested.logoUrl, nested.logoDataUrl, config.logoUrl, config.logoDataUrl, pf.LOGO, pf["Featured image"]);
    const galleryValue = first(
      nested.gallery,
      nested.images,
      nested.screenshots,
      config.gallery,
      config.screenshots,
      getScreenshotValues(config),
    );
    const topicsValue = first(
      nested.topics,
      nested.topic,
      config.productHuntTopics,
      config.topics,
      pf["Product Hunt Topics"],
      pf.Topics,
    );
    return {
      productName: first(nested.productName, nested.name, config.brandName, pf.Name, pf.Title),
      tagline: first(nested.tagline, nested.oneLiner, config.tagline, pf["Short description(20-30 words)"], pf.Note),
      description: first(
        nested.description,
        config.description,
        pf["Feature description"],
        pf["Short Discription(100-150 words)"],
        pf["Long description (250-500 words)"],
        pf["Short description(20-30 words)"],
      ),
      website: first(nested.website, nested.url, config.targetDomain, pf.Url),
      topics: list(topicsValue),
      makerHandle: first(
        nested.makerHandle,
        nested.maker,
        nested.handle,
        config.makerHandle,
        config.productHuntMakerHandle,
        pf["Maker Handle"],
        pf.Maker,
      ),
      soloMaker:
        nested.soloMaker === true ||
        nested.solo === true ||
        config.soloMaker === true ||
        /^(?:true|yes|y|是|1)$/i.test(String(nested.soloMaker || nested.solo || config.soloMaker || pf["Solo Maker"] || "").trim()),
      pricing: first(nested.freeOptions, nested.pricing, config.pricing, pf["PRICING TYPE"], pf.Pricing, "free"),
      launchDate: first(nested.launchDate, config.launchDate, pf["Launch Date"], pf["Launch date"], pf["Release Date"]),
      funding: first(
        nested.funding,
        nested.fundingStatus,
        config.productHuntFunding,
        config.fundingStatus,
        pf["Funding"],
        pf["Funding status"],
      ),
      teamSize: first(nested.teamSize, config.productHuntTeamSize, config.teamSize, pf["Team size"]),
      crunchbaseUrl: first(
        nested.crunchbaseUrl,
        nested.crunchbase,
        config.productHuntCrunchbaseUrl,
        config.crunchbaseUrl,
        pf["Crunchbase URL"],
      ),
      firstComment: first(
        nested.firstComment,
        nested.shoutout,
        config.firstComment,
        pf["Product Hunt First Comment"],
        config.commentTemplate,
      ),
      investors: list(first(nested.investors, config.investors, pf.Investors)),
      logo: logoValue,
      gallery: list(galleryValue),
      slug: first(nested.slug, config.slug),
    };
  }

  function productHuntControlLabel(element) {
    if (!element) return "";
    return compactText(
      [element.innerText, element.value, element.getAttribute?.("aria-label"), element.textContent, element.getAttribute?.("title")]
        .find((value) => value && String(value).trim()) || "",
      180,
    );
  }

  function productHuntFieldHint(element) {
    return normalizeProductHuntText(
      [
        getSnapshotLabel(element),
        element.name,
        element.id,
        element.type,
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("placeholder"),
        element.getAttribute?.("data-placeholder"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function productHuntVisibleText(scope) {
    const root = scope || document;
    return compactText(root.innerText || root.textContent || "", 10000);
  }

  function productHuntQueryVisible(scope, selector) {
    const root = scope && typeof scope.querySelectorAll === "function" ? scope : document;
    const result = Array.from(root.querySelectorAll(selector)).filter((element) => {
      try {
        return isVisible(element);
      } catch {
        return false;
      }
    });
    if (result.length || root === document) return result;
    return Array.from(document.querySelectorAll(selector)).filter((element) => {
      try {
        return isVisible(element);
      } catch {
        return false;
      }
    });
  }

  function productHuntActiveScope() {
    try {
      const active = getActiveFillScope();
      if (active && active !== document && isVisible(active)) return active;
    } catch {
      /* fall back to the visible document below */
    }
    const candidates = productHuntQueryVisible(
      document,
      'main, [role="main"], [data-testid*="launch" i], [class*="Launch"], [class*="launch"]',
    );
    return candidates[0] || document;
  }

  // Product Hunt's React form keeps the authoritative values for maker,
  // pricing, and legal consent in visually hidden inputs.  They must be part
  // of the stage snapshot; otherwise a page can look like an empty/unknown
  // step while the visible controls are still hydrating.
  const PRODUCT_HUNT_HIDDEN_STATE_SELECTOR = [
    'input[name="isMaker" i]',
    'input[name="is_maker" i]',
    'input[name="soloMaker" i]',
    'input[name="solo_maker" i]',
    'input[name="bootstrapped" i]',
    'input[name="ycCompany" i]',
    'input[name="haveRaisedVcFunding" i]',
    'input[name="pricingType" i]',
    'input[name="pricing_type" i]',
    'input[name*="legal" i]',
    'input[id*="legal" i]',
    'input[name*="consent" i]',
    'input[id*="consent" i]',
    'input[name*="terms" i]',
    'input[id*="terms" i]',
    'input[name*="agree" i]',
    'input[id*="agree" i]',
    'input[name*="accept" i]',
    'input[id*="accept" i]',
    '[data-legal-control]',
    '[data-consent-control]',
  ].join(", ");

  function productHuntSnapshotField(element, hidden = false) {
    return {
      label: getSnapshotLabel(element),
      name: element.getAttribute?.("name") || "",
      id: element.id || "",
      type: element.getAttribute?.("type") || element.tagName?.toLowerCase() || "",
      placeholder: element.getAttribute?.("placeholder") || "",
      aria: element.getAttribute?.("aria-label") || "",
      required: !!element.required || element.getAttribute?.("aria-required") === "true",
      checked: !!element.checked,
      value: getElementFillValue(element),
      ...(hidden ? { hidden: true } : {}),
    };
  }

  function productHuntHiddenStateControls(scope) {
    const root = scope && typeof scope.querySelectorAll === "function" ? scope : document;
    const local = Array.from(root.querySelectorAll(PRODUCT_HUNT_HIDDEN_STATE_SELECTOR));
    if (local.length || root === document) return local;
    return Array.from(document.querySelectorAll(PRODUCT_HUNT_HIDDEN_STATE_SELECTOR));
  }

  function productHuntFormSnapshot(scope = productHuntActiveScope()) {
    const visibleElements = productHuntQueryVisible(
      scope,
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
    );
    const fields = visibleElements.map((element) => productHuntSnapshotField(element));
    const hiddenStateControls = productHuntHiddenStateControls(scope);
    hiddenStateControls
      .filter((element) => !visibleElements.includes(element))
      .forEach((element) => fields.push(productHuntSnapshotField(element, true)));
    // Product Hunt keeps the real file controls visually hidden behind its
    // upload dropzones. Include those controls in stage detection even though
    // ordinary fillable-field snapshots intentionally omit hidden inputs.
    const hiddenMediaInputs = Array.from(
      (scope && typeof scope.querySelectorAll === "function" ? scope : document).querySelectorAll('input[type="file"]'),
    ).filter((element) => !visibleElements.includes(element) && !hiddenStateControls.includes(element));
    hiddenMediaInputs.forEach((element) => {
      fields.push(productHuntSnapshotField(element, true));
    });
    const buttons = productHuntQueryVisible(
      scope,
      'button, input[type="button"], input[type="submit"], [role="button"]',
    ).map((element) => ({
      text: productHuntControlLabel(element),
      aria: element.getAttribute?.("aria-label") || "",
      title: element.getAttribute?.("title") || "",
      disabled: !!element.disabled || element.getAttribute?.("aria-disabled") === "true",
    }));
    return {
      url: location.href,
      title: document.title || "",
      text: productHuntVisibleText(scope),
      fields,
      buttons,
      captcha: productHuntHasExplicitCaptcha(scope),
    };
  }

  function productHuntHasExplicitCaptcha(scope = document) {
    return productHuntQueryVisible(
      scope,
      '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], iframe[src*="challenges.cloudflare" i], img[src*="captcha" i], img[alt*="captcha" i], input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i]',
    ).length > 0;
  }

  function detectProductHuntGate(scope = productHuntActiveScope()) {
    const snapshot = productHuntFormSnapshot(scope);
    const gate = productHuntGateFromSnapshot(snapshot);
    if (!gate) return null;
    const reasons = {
      login: "Product Hunt 需要登录后才能继续",
      captcha: "Product Hunt 检测到验证码或人机验证",
      otp: "Product Hunt 需要输入一次性验证码",
      pay: "Product Hunt 当前步骤要求付费或 Promote/Boost",
      legal: "Product Hunt 需要人工确认条款或法律声明",
    };
    if (gate === "captcha") highlightCaptchaArea();
    return {
      gate,
      needs_manual: true,
      keepTab: true,
      releaseSlot: true,
      reason: reasons[gate] || "Product Hunt 需要人工处理",
    };
  }

  function detectProductHuntStage(scope = productHuntActiveScope()) {
    const snapshot = productHuntFormSnapshot(scope);
    return productHuntStageFromSnapshot(snapshot);
  }

  function productHuntFindField(scope, patterns, used = new Set()) {
    const wanted = (Array.isArray(patterns) ? patterns : [patterns]).map(
      (pattern) => (pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i")),
    );
    const candidates = productHuntQueryVisible(
      scope,
      'input, textarea, select, [contenteditable="true"], [role="textbox"]',
    ).filter((element) => {
      const type = String(element.type || "").toLowerCase();
      return !used.has(element) && !["hidden", "file", "submit", "button", "reset", "checkbox", "radio"].includes(type);
    });
    return candidates
      .map((element) => {
        const hint = productHuntFieldHint(element);
        let score = 0;
        wanted.forEach((pattern, index) => {
          if (!pattern.test(hint)) return;
          score += 20 - index;
          if (pattern.test(String(element.name || ""))) score += 10;
          if (pattern.test(String(element.id || ""))) score += 8;
        });
        return { element, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function productHuntValueMatches(element, expected) {
    if (!element || expected == null || expected === "") return true;
    const actual = normalizeProductHuntText(getElementFillValue(element));
    const desired = normalizeProductHuntText(expected);
    if (!actual || !desired) return false;
    if (/^https?:\/\//i.test(String(expected))) {
      try {
        return new URL(actual).href.replace(/\/$/, "") === new URL(expected).href.replace(/\/$/, "");
      } catch {
        /* compare normalized text below */
      }
    }
    return actual === desired || actual.startsWith(desired) || desired.startsWith(actual);
  }

  async function productHuntFillField(element, value) {
    if (!element || value == null || value === "") return { ok: false, reason: "empty_value" };
    const fitted = fitValueToConstraints(String(value), getFieldConstraints(element));
    const type = String(element.type || "").toLowerCase();
    if (type === "select-one" || element.tagName?.toLowerCase() === "select") {
      const ok = setSelectValue(element, fitted);
      return { ok, value: getElementFillValue(element) };
    }
    if (!productHuntValueMatches(element, fitted) || fieldNeedsRefill(element)) {
      await simulateTyping(element, fitted);
    }
    const actual = getElementFillValue(element);
    return { ok: productHuntValueMatches(element, fitted), value: actual };
  }

  async function fillProductHuntMainInfo(scope, values) {
    const specs = [
      {
        key: "productName",
        value: values.productName,
        patterns: [/product\s*name/, /name\s*of\s*(?:your\s*)?product/, /app\s*name/, /tool\s*name/],
      },
      {
        key: "tagline",
        value: values.tagline,
        patterns: [/tagline/, /one[- ]?liner/, /short\s*description/, /subtitle/],
      },
      {
        key: "website",
        value: values.website,
        patterns: [/website/, /homepage/, /product\s*url/, /url/],
      },
      {
        key: "description",
        value: values.description,
        patterns: [/long\s*description/, /product\s*description/, /describe/, /about\s*(?:your\s*)?product/],
      },
    ];
    const used = new Set();
    const filled = [];
    const missing = [];
    for (const spec of specs) {
      if (!spec.value) continue;
      const field = productHuntFindField(scope, spec.patterns, used);
      if (!field) continue;
      used.add(field);
      const result = await productHuntFillField(field, spec.value);
      if (result.ok) filled.push(spec.key);
      else if (fieldIsRequired(field)) missing.push(spec.key);
    }
    const topicFields = productHuntQueryVisible(
      scope,
      'input[name="topics" i], input[id="topics" i], input[name="topic" i], textarea[name="topics" i]',
    ).filter((element) => !used.has(element));
    if (values.topics.length && topicFields.length && !productHuntChoiceControls(scope, /topic|categor/).length) {
      const field = topicFields[0];
      used.add(field);
      const result = await productHuntFillField(field, values.topics.join(", "));
      if (result.ok) filled.push("topics");
      else if (fieldIsRequired(field)) missing.push("topics");
    } else {
      const topics = await fillProductHuntTopics(scope, values);
      if (!topics.ok) missing.push(...(topics.missing || ["topics"]));
      else if (topics.selected?.length || topics.selectedAfter?.length || values.topics.length === 0) filled.push("topics");
    }
    const commentField = productHuntFindField(scope, [/^commentbody\b/, /comment\s*body/, /first\s*comment/], used);
    if (commentField && values.firstComment) {
      used.add(commentField);
      const result = await productHuntFillField(commentField, values.firstComment);
      if (result.ok) filled.push("firstComment");
      else if (fieldIsRequired(commentField)) missing.push("firstComment");
    }
    return { filled, missing };
  }

  function productHuntChoiceLabel(element) {
    const label = getSnapshotLabel(element);
    if (label) return compactText(label, 180);
    return productHuntControlLabel(element) || compactText(element.value || "", 180);
  }

  function productHuntRawControls(scope, selector) {
    const root = scope && typeof scope.querySelectorAll === "function" ? scope : document;
    const controls = Array.from(root.querySelectorAll(selector));
    if (controls.length || root === document) return controls;
    return Array.from(document.querySelectorAll(selector));
  }

  function productHuntClickAssociatedLabel(input) {
    const id = input?.id;
    let label = null;
    if (id) {
      try {
        label = document.querySelector(`label[for="${cssEscape(id)}"]`);
      } catch {
        label = null;
      }
    }
    label = label || input?.closest?.("label") || null;
    if (label) label.click?.();
    else input?.click?.();
    if (input) {
      setCheckedValue(input, true);
      input.setAttribute?.("aria-checked", "true");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return !!input;
  }

  function productHuntBooleanControlChecked(control) {
    if (!control) return false;
    // Hidden inputs may carry the option value "true" even when that option
    // is not selected.  Only an actual checked/ARIA state is authoritative for
    // the maker and solo-maker toggles.
    return control.checked === true ||
      control.getAttribute?.("aria-checked") === "true" ||
      control.getAttribute?.("data-state") === "checked" ||
      control.getAttribute?.("data-selected") === "true";
  }

  async function waitForProductHuntMakerIdentity(scope, makerHandle, timeoutMs = 1800) {
    const expected = normalizeProductHuntText(makerHandle || "");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (productHuntSelectionConfirmed(scope, /maker|founder|creator|who.*mak/, expected)) return true;
      await sleep(150);
    }
    return productHuntSelectionConfirmed(scope, /maker|founder|creator|who.*mak/, expected);
  }

  async function waitForProductHuntMakerControls(scope, timeoutMs = 1800) {
    const deadline = Date.now() + timeoutMs;
    const hasControls = () => productHuntChoiceControls(scope, /maker|founder|creator|who.*mak/)
      .some((control) => !/^(?:ismaker|solomaker|is_maker|solo_maker)$/i.test(control.name || ""));
    while (Date.now() < deadline) {
      if (hasControls()) return true;
      await sleep(150);
    }
    return hasControls();
  }

  function productHuntChoiceMatches(label, desired) {
    const actual = productHuntNormalizeButtonLabel(label);
    const expected = productHuntNormalizeButtonLabel(desired);
    if (!actual || !expected) return false;
    if (actual === expected) return true;
    // Handles are allowed to appear next to the maker display name, but a topic
    // must remain an exact chip/option to avoid silently choosing a neighbouring
    // Product Hunt taxonomy item.
    if (expected.startsWith("@")) {
      return new RegExp(`(?:^|\\s)${expected.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(?:$|\\s)`, "i").test(actual);
    }
    return false;
  }

  function productHuntChoiceControls(scope, pattern) {
    const wanted = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    return productHuntQueryVisible(
      scope,
      'input[type="checkbox"], input[type="radio"], input[name="topics" i], input[id="topics" i], select, [role="combobox"], [aria-haspopup="listbox"]',
    ).filter((element) => wanted.test(productHuntFieldHint(element)) || wanted.test(productHuntChoiceLabel(element)));
  }

  function productHuntSelectedLabels(scope, pattern) {
    const wanted = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    const selected = productHuntQueryVisible(
      scope,
      'input[type="checkbox"], input[type="radio"], option:checked, [aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-selected="true"]',
    );
    return selected
      .map((element) => productHuntChoiceLabel(element))
      .filter((label) => wanted.test(label));
  }

  function productHuntSelectionConfirmed(scope, pattern, expected) {
    const wanted = String(expected || "").trim();
    if (!wanted) return false;
    // Selected chips often expose only their own label (without the word
    // "topic" or "maker"), so apply the exact-value check independently of
    // the field hint after the requested control has been interacted with.
    const selectedLabels = productHuntSelectedLabels(scope, /.*/);
    if (selectedLabels.some((label) => productHuntChoiceMatches(label, wanted))) return true;
    const controls = productHuntChoiceControls(scope, pattern);
    return controls.some((control) => {
      const type = String(control.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return productHuntFieldSnapshotChecked({
          checked: !!control.checked,
          value: control.value,
          "aria-checked": control.getAttribute?.("aria-checked"),
        }) && productHuntChoiceMatches(productHuntChoiceLabel(control), wanted);
      }
      if (control.tagName?.toLowerCase() === "select") {
        return Array.from(control.selectedOptions || []).some((option) =>
          productHuntChoiceMatches(option.textContent || option.label || option.value, wanted) ||
          productHuntChoiceMatches(option.value, wanted),
        );
      }
      const selected = control.getAttribute?.("aria-selected") === "true" ||
        control.getAttribute?.("aria-checked") === "true" ||
        control.getAttribute?.("data-state") === "checked" ||
        control.getAttribute?.("data-selected") === "true";
      return selected && productHuntChoiceMatches(productHuntChoiceLabel(control), wanted);
    });
  }

  async function waitForProductHuntSelection(scope, pattern, expected, timeoutMs = 1800) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (productHuntSelectionConfirmed(scope, pattern, expected)) return true;
      await sleep(150);
    }
    return productHuntSelectionConfirmed(scope, pattern, expected);
  }

  function productHuntOptionElements(scope) {
    const selectors = [
      '[role="option"]',
      '[role="listbox"] li',
      '[data-radix-collection-item]',
      '.dropdown-item',
      '[class*="option"]',
      '[class*="Option"]',
    ];
    const result = [];
    const seen = new Set();
    selectors.forEach((selector) => {
      productHuntQueryVisible(scope, selector).forEach((element) => {
        if (seen.has(element)) return;
        seen.add(element);
        result.push(element);
      });
    });
    return result;
  }

  async function productHuntSelectExact(scope, pattern, desiredValues, options = {}) {
    const desired = (Array.isArray(desiredValues) ? desiredValues : [desiredValues])
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    if (!desired.length) return { selected: [], missing: [] };
    const controls = productHuntChoiceControls(scope, pattern);
    const selected = [];
    const missing = [];

    for (const value of desired) {
      let matched = false;
      for (const control of controls) {
        const type = String(control.type || "").toLowerCase();
        if (control.tagName?.toLowerCase() === "select") {
          const option = Array.from(control.options || []).find((item) =>
            productHuntChoiceMatches(item.textContent || item.label || item.value, value) ||
            productHuntChoiceMatches(item.value, value),
          );
          if (option && setSelectValue(control, option.value) && productHuntSelectionConfirmed(scope, pattern, value)) {
            selected.push(value);
            matched = true;
            break;
          }
          continue;
        }
        if (type === "checkbox" || type === "radio") {
          const label = productHuntChoiceLabel(control);
          if (productHuntChoiceMatches(label, value)) {
            if (!control.checked) {
              setCheckedValue(control, true);
              control.dispatchEvent(new Event("input", { bubbles: true }));
              control.dispatchEvent(new Event("change", { bubbles: true }));
            }
            if (productHuntSelectionConfirmed(scope, pattern, value)) {
              selected.push(value);
              matched = true;
            }
            break;
          }
          continue;
        }
        const hint = productHuntFieldHint(control);
        if (!pattern.test(hint) && !pattern.test(productHuntChoiceLabel(control))) continue;
        const current = productHuntChoiceLabel(control);
        if (productHuntChoiceMatches(current, value) && productHuntSelectionConfirmed(scope, pattern, value)) {
          selected.push(value);
          matched = true;
          break;
        }
        control.focus?.();
        control.click?.();
        if (
          control.matches?.('input[name="topics" i], input[id="topics" i], [role="combobox"]') &&
          String(control.type || "text").toLowerCase() !== "checkbox" &&
          String(control.type || "text").toLowerCase() !== "radio"
        ) {
          await simulateTyping(control, value);
        }
        await sleep(250);
        const option = productHuntOptionElements(scope).find((item) =>
          productHuntChoiceMatches(productHuntControlLabel(item), value),
        );
        if (option) {
          option.click();
          await sleep(150);
          if (await waitForProductHuntSelection(scope, pattern, value)) {
            selected.push(value);
            matched = true;
          }
          break;
        }
        document.body?.click?.();
      }
      if (!matched) missing.push(value);
    }

    const selectedAfter = productHuntSelectedLabels(scope, pattern);
    return {
      selected: [...new Set(selected)],
      selectedAfter,
      missing,
      ok: missing.length === 0,
      requireExact: options.requireExact !== false,
    };
  }

  async function fillProductHuntTopics(scope, values) {
    const topics = [...new Set((values.topics || []).map((topic) => String(topic).trim()).filter(Boolean))];
    if (!topics.length) {
      const required = productHuntChoiceControls(scope, /topic|category/).some(fieldIsRequired);
      return { ok: !required, selected: [], missing: required ? ["topics"] : [] };
    }
    const result = await productHuntSelectExact(scope, /topic|categor/, topics, { requireExact: true });
    return {
      ok: result.missing.length === 0,
      selected: result.selected,
      missing: result.missing,
      selectedAfter: result.selectedAfter,
    };
  }

  async function fillProductHuntMaker(scope, values) {
    const isMakerInputs = productHuntRawControls(scope, 'input[name="isMaker"], input[name="is_maker"]');
    const hiddenIsMaker = isMakerInputs.find((input) => /^(?:true|yes|1|on)$/i.test(String(input.value || "").trim())) || isMakerInputs[0];
    const soloMakerInputs = productHuntRawControls(scope, 'input[name="soloMaker"], input[name="solo_maker"]');
    const hiddenSoloMaker = soloMakerInputs.find((input) => /^(?:true|yes|1|on)$/i.test(String(input.value || "").trim())) || soloMakerInputs[0];
    if ((values.makerHandle || values.soloMaker) && hiddenIsMaker && !productHuntBooleanControlChecked(hiddenIsMaker)) {
      productHuntClickAssociatedLabel(hiddenIsMaker);
    }

    let makerResult = { ok: !values.makerHandle, selected: [] };
    if (values.makerHandle) {
      await waitForProductHuntMakerControls(scope);
      makerResult = await productHuntSelectExact(scope, /maker|founder|creator|who.*mak/, [values.makerHandle], {
        requireExact: true,
      });
      if (!makerResult.ok || !(await waitForProductHuntMakerIdentity(scope, values.makerHandle))) {
        return {
          ok: false,
          solo: false,
          maker: makerResult.selected?.[0] || "",
          missing: makerResult.missing?.length ? makerResult.missing : ["makerHandle"],
        };
      }
    }

    if (values.soloMaker && hiddenSoloMaker) {
      if (!productHuntBooleanControlChecked(hiddenSoloMaker)) productHuntClickAssociatedLabel(hiddenSoloMaker);
      const soloChecked = await (async () => {
        const deadline = Date.now() + 1200;
        while (Date.now() < deadline) {
          if (productHuntBooleanControlChecked(hiddenSoloMaker)) return true;
          await sleep(120);
        }
        return productHuntBooleanControlChecked(hiddenSoloMaker);
      })();
      if (!soloChecked) return { ok: false, solo: false, maker: makerResult.selected?.[0] || "", missing: ["soloMaker"] };
      return { ok: true, solo: true, maker: makerResult.selected?.[0] || values.makerHandle || "" };
    }

    const soloControls = productHuntQueryVisible(
      scope,
      'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"]',
    ).filter((element) => /solo maker|i am (?:the )?maker|building (?:it )?myself|maker myself/.test(productHuntChoiceLabel(element).toLowerCase()));
    if (values.soloMaker && soloControls.length) {
      const control = soloControls[0];
      if (!control.checked && control.getAttribute?.("aria-checked") !== "true") {
        setCheckedValue(control, true);
        control.setAttribute?.("aria-checked", "true");
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const soloChecked = control.checked || control.getAttribute?.("aria-checked") === "true";
      return soloChecked
        ? { ok: true, solo: true, maker: makerResult.selected?.[0] || "" }
        : { ok: false, solo: false, maker: "", missing: ["soloMaker"] };
    }

    const makerControls = productHuntChoiceControls(scope, /maker|founder|creator|who.*mak/);
    if (!values.makerHandle) {
      const required = makerControls.some((field) => fieldIsRequired(field)) || !values.soloMaker;
      return { ok: !required, solo: false, maker: "", missing: required ? ["makerHandle"] : [] };
    }
    return {
      ok: makerResult.ok,
      solo: false,
      maker: makerResult.selected[0] || "",
      missing: makerResult.missing,
      selectedAfter: makerResult.selectedAfter,
    };
  }

  async function fillProductHuntCompanyInfo(scope, values) {
    const filled = [];
    const missing = [];
    const fundingControls = productHuntRawControls(
      scope,
      'input[name="bootstrapped" i], input[name="ycCompany" i], input[name="haveRaisedVcFunding" i]',
    );
    if (values.funding) {
      const desired = normalizeProductHuntText(values.funding);
      const fundingMap = [
        { name: "bootstrapped", pattern: /bootstrapped|self[- ]?fund|未融资|自筹/ },
        { name: "ycCompany", pattern: /y\s*combinator|\byc\b/ },
        { name: "haveRaisedVcFunding", pattern: /venture|raised|vc|funded|风险投资/ },
      ];
      const wanted = fundingMap.find((item) => item.pattern.test(desired));
      const control = wanted && fundingControls.find((item) => item.name === wanted.name);
      if (!control) {
        missing.push("funding");
      } else {
        fundingControls
          .filter((item) => item !== control && productHuntBooleanControlChecked(item))
          .forEach((item) => {
            setCheckedValue(item, false);
            item.setAttribute?.("aria-checked", "false");
            item.dispatchEvent(new Event("input", { bubbles: true }));
            item.dispatchEvent(new Event("change", { bubbles: true }));
          });
        if (!productHuntBooleanControlChecked(control)) productHuntClickAssociatedLabel(control);
        if (await waitForProductHuntSelection(scope, new RegExp(wanted.name, "i"), wanted.name, 800) || productHuntBooleanControlChecked(control)) {
          filled.push("funding");
        } else {
          missing.push("funding");
        }
      }
    } else if (fundingControls.some(fieldIsRequired) && !fundingControls.some(productHuntBooleanControlChecked)) {
      missing.push("funding");
    }

    const teamField = productHuntFindField(scope, [/team\s*size/, /teamsize/]);
    if (values.teamSize) {
      if (!teamField) {
        missing.push("teamSize");
      } else if (productHuntValueMatches(teamField, values.teamSize)) {
        filled.push("teamSize");
      } else {
        teamField.focus?.();
        teamField.click?.();
        await sleep(180);
        const expected = normalizeProductHuntText(values.teamSize);
        const option = productHuntOptionElements(scope).find((item) =>
          productHuntChoiceMatches(productHuntControlLabel(item), expected),
        );
        if (option) option.click?.();
        await sleep(180);
        if (productHuntValueMatches(teamField, values.teamSize)) filled.push("teamSize");
        else missing.push("teamSize");
      }
    } else if (teamField && fieldIsRequired(teamField) && !getElementFillValue(teamField)) {
      missing.push("teamSize");
    }

    const crunchbaseField = productHuntFindField(scope, [/crunchbase\s*url/, /crunchbaseurl/]);
    if (values.crunchbaseUrl) {
      if (!crunchbaseField) {
        missing.push("crunchbaseUrl");
      } else {
        const result = await productHuntFillField(crunchbaseField, values.crunchbaseUrl);
        if (result.ok) filled.push("crunchbaseUrl");
        else if (fieldIsRequired(crunchbaseField)) missing.push("crunchbaseUrl");
      }
    } else if (crunchbaseField && fieldIsRequired(crunchbaseField) && !getElementFillValue(crunchbaseField)) {
      missing.push("crunchbaseUrl");
    }

    return { ok: missing.length === 0, filled, missing };
  }

  function productHuntMediaSource(value) {
    if (value && typeof value === "object") {
      return value.ref || value.url || value.dataUrl || value.source || value.value || "";
    }
    return String(value || "").trim();
  }

  async function fetchProductHuntMediaBlob(source, config, name) {
    const value = productHuntMediaSource(source);
    if (!value) throw new Error("媒体引用为空");
    if (/^data:/i.test(value)) return { blob: await (await fetch(value)).blob(), name: name || "image" };
    if (isCloudMediaRef(value)) return fetchCloudMediaBlob(value, name || "cloud-media");
    const absolute = new URL(value, config?.targetDomain || location.href).href;
    return { blob: await fetchSubmissionMediaBlob(absolute), name: absolute.split("/").pop()?.split("?")[0] || name || "image" };
  }

  function productHuntPreviewImages(input) {
    const roots = [];
    let current = input;
    for (let index = 0; current && index < 5; index += 1, current = current.parentElement) roots.push(current);
    const images = new Set();
    roots.forEach((root) => {
      productHuntQueryVisible(root, 'img[src], img[currentSrc], [role="img"]').forEach((image) => images.add(image));
    });
    const associated = productHuntQueryVisible(document, 'img[src], img[currentSrc], [role="img"]').filter((image) => {
      const hint = normalizeProductHuntText(
        [image.alt, image.getAttribute?.("aria-label"), image.parentElement?.textContent]
          .filter(Boolean)
          .join(" "),
      );
      return /preview|uploaded|logo|gallery|image|screenshot/.test(hint);
    });
    associated.forEach((image) => images.add(image));
    return [...images].filter((image) => image.currentSrc || image.src || image.getAttribute?.("src"));
  }

  function productHuntPersistentPreviewCount(kind) {
    const selector = kind === "logo" ? 'img[alt="preview" i]' : 'img[alt="Media" i]';
    const images = Array.from(document.querySelectorAll(selector));
    return images.filter((image, index) => images.indexOf(image) === index && (image.currentSrc || image.src || image.getAttribute?.("src"))).length;
  }

  async function waitForProductHuntPreview(input, expectedCount = 1, timeoutMs = 1800, kind = "") {
    const deadline = Date.now() + timeoutMs;
    let count = Math.max(productHuntPreviewImages(input).length, productHuntPersistentPreviewCount(kind));
    while (count < expectedCount && Date.now() < deadline) {
      await sleep(150);
      count = Math.max(productHuntPreviewImages(input).length, productHuntPersistentPreviewCount(kind));
    }
    return { verified: count >= expectedCount, count };
  }

  async function attachProductHuntMediaFiles(input, sources, config, namePrefix, mediaKind = "") {
    const usableSources = (sources || []).map(productHuntMediaSource).filter(Boolean);
    if (!usableSources.length) return { ok: false, reason: "media_source_missing", files: 0, previewVerified: false };
    try {
      const files = [];
      for (let index = 0; index < usableSources.length; index += 1) {
        const media = await fetchProductHuntMediaBlob(usableSources[index], config, `${namePrefix || "producthunt"}-${index + 1}`);
        if (!media.blob || !String(media.blob.type || "").startsWith("image/")) throw new Error("媒体不是图片");
        const normalized = await normalizeImageForFileInput(media.blob, input);
        const mime = normalized.type || media.blob.type || "image/png";
        const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1]?.split("+")[0] || "png";
        const sourceName = String(media.name || namePrefix || "image").replace(/\.[a-z0-9]+$/i, "") || "image";
        files.push(new File([normalized], `${sourceName}-${index + 1}.${ext}`, { type: mime }));
      }
      const dt = new DataTransfer();
      files.forEach((file) => dt.items.add(file));
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const preview = await waitForProductHuntPreview(
        input,
        Math.min(files.length, input.multiple ? files.length : 1),
        1800,
        mediaKind,
      );
      reportMediaUpload(preview.verified ? "success" : "failed", {
        name: namePrefix || "producthunt",
        source: usableSources.some((source) => isCloudMediaRef(source)) ? "cloud" : "remote",
        files: files.length,
        previewVerified: preview.verified,
      });
      return {
        ok: files.length > 0 && preview.verified,
        files: files.length,
        previewVerified: preview.verified,
        previewCount: preview.count,
      };
    } catch (error) {
      reportMediaUpload("failed", { name: namePrefix || "producthunt", reason: error.message });
      return { ok: false, reason: error.message, files: 0, previewVerified: false };
    }
  }

  function productHuntMediaInputs(scope) {
    const root = scope && typeof scope.querySelectorAll === "function" ? scope : document;
    const inputs = [];
    const seen = new Set();
    const collect = (nodes) => nodes.forEach((input) => {
      if (input.disabled) return;
      // Product Hunt currently renders multiple file inputs with the same
      // id/name.  The DOM node, not that duplicated markup id, is the unit we
      // need to retain for upload routing.
      if (seen.has(input)) return;
      seen.add(input);
      inputs.push(input);
    });
    collect(Array.from(root.querySelectorAll('input[type="file"]')));
    if (!inputs.length && root !== document) {
      collect(Array.from(document.querySelectorAll('input[type="file"]')));
    }
    const logo = inputs.find((input) => /file-input-thumbnailimageuuid|thumbnail|logo|icon|avatar/.test(productHuntFieldHint(input))) || null;
    const gallery = inputs.filter((input) => input !== logo && (
      input.multiple || /file-input-media|gallery|image|screenshot|product media|photo/.test(productHuntFieldHint(input))
    ));
    return { inputs, logo, gallery: gallery.length ? gallery : inputs.filter((input) => input !== logo) };
  }

  async function fillProductHuntImages(scope, values, config) {
    const media = productHuntMediaInputs(scope);
    const logo = productHuntMediaSource(values.logo);
    const gallery = (values.gallery || []).map(productHuntMediaSource).filter(Boolean);
    const persistentLogoPreview = productHuntPersistentPreviewCount("logo");
    const persistentGalleryPreview = productHuntPersistentPreviewCount("gallery");
    if (!media.inputs.length) {
      return { ok: !logo && !gallery.length, uploaded: [], missing: logo || gallery.length ? ["images"] : [] };
    }
    const uploaded = [];
    const missing = [];
    const galleryAlreadySatisfied = gallery.length > 0
      ? persistentGalleryPreview >= gallery.length
      : persistentGalleryPreview > 0;
    if (media.logo && logo) {
      if (persistentLogoPreview > 0 || (media.logo.files?.length && productHuntPreviewImages(media.logo).length > 0)) {
        uploaded.push({ kind: "logo", files: media.logo.files?.length || 1, previewVerified: true, reused: true });
      } else {
        const result = await attachProductHuntMediaFiles(media.logo, [logo], { ...config, logoDataUrl: /^data:/i.test(logo) ? logo : config.logoDataUrl }, "logo", "logo");
        if (result.ok) uploaded.push({ kind: "logo", ...result });
        else if (fieldIsRequired(media.logo)) missing.push("logo");
      }
    } else if (logo) {
      missing.push("logo");
    }

    if (galleryAlreadySatisfied) {
      uploaded.push({ kind: "gallery", files: persistentGalleryPreview, previewVerified: true, reused: true });
      gallery.length = 0;
    }

    let galleryCursor = 0;
    for (const input of media.gallery) {
      if (galleryCursor >= gallery.length) {
        if (!galleryAlreadySatisfied && fieldIsRequired(input)) missing.push("gallery");
        continue;
      }
      const sources = input.multiple ? gallery.slice(galleryCursor) : [gallery[galleryCursor]];
      if (input.files?.length && productHuntPreviewImages(input).length >= Math.min(input.files.length, sources.length)) {
        galleryCursor += sources.length;
        uploaded.push({ kind: "gallery", files: input.files.length, previewVerified: true, reused: true });
        continue;
      }
      const result = await attachProductHuntMediaFiles(input, sources, config, "gallery", "gallery");
      if (result.ok) {
        uploaded.push({ kind: "gallery", ...result });
        galleryCursor += sources.length;
      } else if (fieldIsRequired(input)) {
        missing.push("gallery");
      }
      if (!input.multiple) galleryCursor += result.ok ? 0 : 1;
    }
    if (galleryCursor < gallery.length) missing.push("gallery");
    return {
      ok: missing.length === 0 && uploaded.every((item) => item.previewVerified !== false),
      uploaded,
      missing: [...new Set(missing)],
      previewVerified: uploaded.length > 0 && uploaded.every((item) => item.previewVerified !== false),
    };
  }

  function productHuntPricingValue(value) {
    const pricing = normalizeProductHuntText(value);
    if (/freemium|free (?:trial|plan|tier|option)|paid.*free|free.*paid/.test(pricing)) {
      return "free_options";
    }
    if (/paid only|payment required|no free/.test(pricing)) return "payment_required";
    return /free|no cost|免费/.test(pricing) ? "free" : "";
  }

  async function fillProductHuntPricing(scope, values) {
    const pricingText = normalizeProductHuntText(values.pricing || "free");
    const pricingValue = productHuntPricingValue(pricingText);
    const hiddenPricing = productHuntRawControls(
      scope,
      `input[name="pricingType"][value="${cssEscape(pricingValue)}"]`,
    )[0];
    if (hiddenPricing && pricingValue) {
      if (!hiddenPricing.checked) productHuntClickAssociatedLabel(hiddenPricing);
      return { ok: true, pricing: pricingValue };
    }
    const pricingControls = productHuntChoiceControls(scope, /pric|free option|plan|billing|cost/);
    const native = pricingControls.find((control) => control.tagName?.toLowerCase() === "select");
    if (native) {
      const options = Array.from(native.options || []).filter((option) => !option.disabled && option.value);
      const wantedFree = /free|freemium|no cost|免费/.test(pricingText);
      const option = options.find((item) => {
        const label = normalizeProductHuntText(`${item.textContent || ""} ${item.value || ""}`);
        return wantedFree ? /free|freemium|no cost|免费/.test(label) && !/paid|premium|pro|upgrade/.test(label) : productHuntChoiceMatches(label, pricingText);
      });
      if (option && setSelectValue(native, option.value)) {
        return { ok: true, pricing: option.textContent || option.value };
      }
      if (wantedFree && options.some((item) => /paid|premium|pro|upgrade/i.test(item.textContent || item.value || ""))) {
        return { ok: false, gate: "pay", reason: "没有可选的免费 Product Hunt 定价" };
      }
    }

    const freeChoice = productHuntQueryVisible(
      scope,
      'input[type="radio"], input[type="checkbox"], [role="radio"], [role="option"], [data-state], [data-value]',
    ).find((control) => {
      const label = normalizeProductHuntText(productHuntChoiceLabel(control));
      return /free|freemium|no cost|免费/.test(label) && !/paid|premium|pro|upgrade|promote|boost/.test(label);
    });
    if (freeChoice) {
      if (freeChoice.type === "radio" || freeChoice.type === "checkbox") {
        if (!freeChoice.checked) {
          setCheckedValue(freeChoice, true);
          freeChoice.dispatchEvent(new Event("input", { bubbles: true }));
          freeChoice.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } else if (freeChoice.getAttribute?.("aria-selected") !== "true" && freeChoice.getAttribute?.("data-state") !== "checked") {
        freeChoice.click?.();
        await sleep(120);
      }
      return { ok: true, pricing: productHuntChoiceLabel(freeChoice) };
    }
    const required = pricingControls.some((control) => fieldIsRequired(control));
    return { ok: !required, pricing: "", missing: required ? ["pricing"] : [] };
  }

  async function fillProductHuntTextByHint(scope, value, patterns, key) {
    if (!value) return { ok: true, skipped: true, key };
    const field = productHuntFindField(scope, patterns);
    if (!field) return { ok: true, skipped: true, key };
    const result = await productHuntFillField(field, value);
    return { ...result, key, label: getSnapshotLabel(field) };
  }

  async function fillProductHuntShoutouts(scope, values) {
    // Shoutouts are optional. The first comment belongs to main_info's
    // commentBody field; never invent or move copy into this optional step.
    return { ok: true, skipped: true, optional: true, key: "shoutouts" };
  }

  async function fillProductHuntExtras(scope, values) {
    const results = [];
    results.push(await fillProductHuntPricing(scope, values));
    if (values.launchDate) {
      results.push(
        await fillProductHuntTextByHint(
          scope,
          normalizeDateValue(values.launchDate) || values.launchDate,
          [/launch\s*date/, /schedule\s*date/, /release\s*date/],
          "launchDate",
        ),
      );
    }
    return {
      ok: results.every((result) => result.ok),
      results,
      missing: results.flatMap((result) => result.missing || []),
      gate: results.find((result) => result.gate)?.gate || "",
    };
  }

  async function fillProductHuntInvestors(scope, values) {
    if (!values.investors.length) return { ok: true, skipped: true, optional: true };
    const result = await fillProductHuntTextByHint(
      scope,
      values.investors.join(", "),
      [/investor/, /funding/, /backed\s*by/],
      "investors",
    );
    return { ...result, optional: true };
  }

  function productHuntFindOptionalSkipButton(scope) {
    return productHuntQueryVisible(scope, 'button, input[type="button"], [role="button"], a[role="button"]')
      .filter((element) => !element.disabled && element.getAttribute?.("aria-disabled") !== "true")
      .find((element) => productHuntButtonPolicy(productHuntControlLabel(element), "skip"));
  }

  function productHuntFindAdvanceButton(scope) {
    return productHuntQueryVisible(scope, 'button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]')
      .filter((element) => !element.disabled && element.getAttribute?.("aria-disabled") !== "true")
      .find((element) => productHuntButtonPolicy(productHuntControlLabel(element), "advance"));
  }

  function productHuntFindCreateDraftButton(scope) {
    return productHuntQueryVisible(scope, 'button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]')
      .filter((element) => !element.disabled && element.getAttribute?.("aria-disabled") !== "true")
      .find((element) => productHuntButtonPolicy(productHuntControlLabel(element), "create"));
  }

  function productHuntStageSignature(scope = productHuntActiveScope()) {
    const controls = productHuntQueryVisible(
      scope,
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"], button, [role="button"], [role="combobox"]',
    );
    return hashSnapshot(
      `${location.href}\n${productHuntVisibleText(scope)}\n${controls
        .slice(0, 120)
        .map((element) => `${element.tagName}|${productHuntFieldHint(element)}|${productHuntControlLabel(element)}`)
        .join("\n")}`,
    );
  }

  async function waitForProductHuntStageChange(beforeStage, beforeSignature, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let stage = detectProductHuntStage();
    let signature = productHuntStageSignature();
    while (Date.now() < deadline) {
      if ((stage && stage !== beforeStage && stage !== "unknown") || signature !== beforeSignature) {
        return { stage, signature, changed: true };
      }
      await sleep(250);
      stage = detectProductHuntStage();
      signature = productHuntStageSignature();
    }
    return { stage, signature, changed: stage !== beforeStage || signature !== beforeSignature };
  }

  async function advanceProductHuntStage(scope, stage, options = {}) {
    const skip = options.optional ? productHuntFindOptionalSkipButton(scope) : null;
    const button = skip || productHuntFindAdvanceButton(scope);
    if (!button) {
      return {
        ok: true,
        stageCompleted: false,
        waiting: true,
        reason: options.optional ? "等待可选步骤跳过按钮" : "等待下一步按钮",
        retryAfterMs: 800,
      };
    }
    const label = productHuntControlLabel(button);
    const beforeUrl = location.href;
    const beforeSignature = productHuntStageSignature(scope);
    button.click();
    const changed = await waitForProductHuntStageChange(stage, beforeSignature);
    return {
      ok: true,
      stageCompleted: true,
      stageAdvanced: changed.changed,
      skipped: button === skip,
      clickedLabel: label,
      nextStage: changed.stage,
      urlChanged: location.href !== beforeUrl,
      waiting: !changed.changed,
    };
  }

  function productHuntRequiredUncheckedFromSnapshot(fields = []) {
    return (Array.isArray(fields) ? fields : [])
      .filter((field) => /checkbox|radio/.test(String(field?.type || field?.role || "").toLowerCase()))
      .filter((field) => {
        const label = productHuntFieldSnapshotHint(field);
        return !productHuntFieldSnapshotChecked(field) &&
          (/required|must|terms|privacy|legal|agree|accept/.test(label) || field?.required === true);
      })
      .map((field) => productHuntFieldSnapshotHint(field) || "required legal control");
  }

  function productHuntChecklistStatus(scope, values) {
    const text = productHuntVisibleText(scope);
    const progress = productHuntQueryVisible(scope, '[role="progressbar"], progress, [aria-valuenow], [data-progress]')
      .map((element) => Number(element.getAttribute?.("aria-valuenow") || element.value || element.getAttribute?.("data-progress") || ""))
      .find((value) => Number.isFinite(value));
    const textProgress = text.match(/\b(100)\s*%\b/);
    const visibleLegal = productHuntQueryVisible(scope, 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]');
    const hiddenLegal = productHuntHiddenStateControls(scope);
    const legalControls = [...new Set([...visibleLegal, ...hiddenLegal])]
      .map((element) => productHuntSnapshotField(element, !visibleLegal.includes(element)));
    const requiredUnchecked = productHuntRequiredUncheckedFromSnapshot(legalControls);
    const unresolved = /\b(?:incomplete|missing|required field|not ready|fix (?:this|these)|add (?:a|an)?)\b/i.test(text);
    const ready = (progress === 100 || !!textProgress || /all (?:steps|requirements) complete|ready to create/.test(normalizeProductHuntText(text))) &&
      !requiredUnchecked.length && !unresolved;
    const createButton = productHuntFindCreateDraftButton(scope);
    const missing = [];
    if (!ready) missing.push("checklist");
    return {
      ready,
      progress: progress ?? (textProgress ? 100 : null),
      missing,
      requiredUnchecked,
      createButton,
      productName: values.productName,
    };
  }

  function productHuntExpectedSlug(values) {
    const configured = String(values.slug || "").trim().toLowerCase();
    if (configured) return configured.replace(/^\/+|\/+$/g, "");
    return normalizeProductHuntText(values.productName)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function productHuntPublicUrl(values) {
    const expectedSlug = productHuntExpectedSlug(values);
    const candidates = [location.href];
    productHuntQueryVisible(document, "a[href]").forEach((link) => candidates.push(link.href || link.getAttribute("href")));
    for (const candidate of candidates) {
      try {
        const parsed = new URL(candidate, location.href);
        const match = parsed.pathname.match(/^\/products\/([^/?#]+)/i);
        if (match && (!expectedSlug || normalizeProductHuntText(match[1]) === expectedSlug)) {
          parsed.search = "";
          parsed.hash = "";
          return parsed.href.replace(/\/$/, "");
        }
      } catch {
        /* ignore malformed links */
      }
    }
    return "";
  }

  function classifyProductHuntResult(config, baseline = {}) {
    const values = productHuntConfigValues(config);
    const text = productHuntVisibleText(document);
    const normalized = normalizeProductHuntText(text);
    const beforeEvidence = normalizeProductHuntText(baseline.evidence || "");
    const evidenceMatch = text.match(/(?:draft (?:created|saved)|submitted (?:for review)?|launch (?:created|submitted)|your product is (?:live|published)|launched (?:this week|in \d{4}))/i);
    const evidence = compactText(evidenceMatch?.[0] || "", 240);
    const publicUrl = productHuntPublicUrl(values);
    const slug = productHuntExpectedSlug(values);
    const identity = (values.productName && normalized.includes(normalizeProductHuntText(values.productName))) ||
      (slug && publicUrl && normalizeProductHuntText(publicUrl).includes(`/products/${slug}`));
    const newEvidence = !!evidence && normalizeProductHuntText(evidence) !== beforeEvidence;
    const publicChanged = !!publicUrl && publicUrl !== String(baseline.publicUrl || "");
    const matched = Boolean(identity && ((newEvidence && evidence) || publicChanged));
    let publicationStatus = "submitted";
    if (/\b(?:launched|live|published)\b/i.test(`${evidence} ${normalized}`)) publicationStatus = "published";
    else if (/\bscheduled\b/i.test(normalized)) publicationStatus = "scheduled";
    const evidenceSignals = matched
      ? [{
          type: publicationStatus === "published" ? "public_listing" : "visible_confirmation",
          text: evidence || `Product Hunt public product page: ${publicUrl}`,
          url: publicUrl || redactSnapshotUrl(location.href),
          matched: true,
          publicationStatus,
          playbookId: "producthunt",
        }]
      : [];
    return {
      matched,
      evidence,
      publicUrl,
      publicationStatus,
      evidenceSignals,
      productName: values.productName,
      expectedSlug: slug,
    };
  }

  async function waitForProductHuntResult(config, baseline, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let last = classifyProductHuntResult(config, baseline);
    while (Date.now() < deadline) {
      last = classifyProductHuntResult(config, baseline);
      if (last.matched) return last;
      await sleep(500);
    }
    return { ...last, matched: false, evidence: "", evidenceSignals: [] };
  }

  function productHuntRequiredMissing(scope) {
    return productHuntQueryVisible(
      scope,
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]',
    )
      .filter((element) => fieldIsRequired(element))
      .filter((element) => !getElementFillValue(element) || fieldNeedsRefill(element))
      .map((element) => getSnapshotLabel(element) || element.name || element.id || "必填栏")
      .slice(0, 12);
  }

  function productHuntResultBaseline(config) {
    return classifyProductHuntResult(config, {
      evidence: "",
      publicUrl: productHuntPublicUrl(productHuntConfigValues(config)),
    });
  }

  function productHuntEntryCard(element) {
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      const tag = current.tagName?.toLowerCase() || "";
      const className = String(current.className || "");
      if (["article", "li"].includes(tag) || /card|product|launch/i.test(className)) return current;
    }
    return element.parentElement || element;
  }

  async function openProductHuntEntry(scope, values) {
    const productName = normalizeProductHuntText(values.productName);
    if (!productName) {
      return {
        ok: false,
        stage: "entry",
        waiting: true,
        keepTab: true,
        reason: "缺少 brandName/productName，拒绝猜测 Product Hunt 产品",
      };
    }

    const editButtons = productHuntQueryVisible(
      scope,
      'button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]',
    ).filter((element) => productHuntNormalizeButtonLabel(productHuntControlLabel(element)) === "continue editing");
    const launchInProgress = productHuntQueryVisible(
      scope,
      'button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]',
    ).filter((element) => productHuntNormalizeButtonLabel(productHuntControlLabel(element)) === "launch in progress");
    if (
      launchInProgress.length === 1 &&
      normalizeProductHuntText(productHuntVisibleText(scope)).includes(productName)
    ) {
      const beforeSignature = productHuntStageSignature(scope);
      const beforeUrl = location.href;
      launchInProgress[0].click();
      const changed = await waitForProductHuntStageChange("entry", beforeSignature);
      return {
        ok: true,
        stage: "entry",
        entryOpened: true,
        matchedProduct: values.productName,
        stageAdvanced: changed.changed,
        nextStage: changed.stage,
        urlChanged: location.href !== beforeUrl,
        waiting: !changed.changed,
      };
    }
    const matching = editButtons.filter((button) => {
      const cardText = normalizeProductHuntText(productHuntEntryCard(button).textContent || "");
      return cardText.includes(productName);
    });
    if (matching.length === 1) {
      const beforeSignature = productHuntStageSignature(scope);
      const beforeUrl = location.href;
      matching[0].click();
      const changed = await waitForProductHuntStageChange("entry", beforeSignature);
      return {
        ok: true,
        stage: "entry",
        entryOpened: true,
        matchedProduct: values.productName,
        stageAdvanced: changed.changed,
        nextStage: changed.stage,
        urlChanged: location.href !== beforeUrl,
        waiting: !changed.changed,
      };
    }

    // Starting a new product is safe only from an explicit new-product control;
    // never choose another existing card when the requested draft is absent.
    const newProduct = productHuntQueryVisible(
      scope,
      'button, input[type="button"], input[type="submit"], [role="button"], a[role="button"]',
    ).find((element) => /^(?:add|new|submit) (?:a )?product$|^start (?:a )?new product$/.test(
      productHuntNormalizeButtonLabel(productHuntControlLabel(element)),
    ));
    if (!newProduct) {
      return {
        ok: true,
        stage: "entry",
        waiting: true,
        retryAfterMs: 800,
        reason: matching.length > 1 ? "匹配到多个同名 Product Hunt 草稿，拒绝猜测" : "等待目标产品草稿或明确的新建产品入口",
      };
    }
    const beforeSignature = productHuntStageSignature(scope);
    const beforeUrl = location.href;
    newProduct.click();
    const changed = await waitForProductHuntStageChange("entry", beforeSignature);
    return {
      ok: true,
      stage: "entry",
      entryOpened: true,
      newProduct: true,
      stageAdvanced: changed.changed,
      nextStage: changed.stage,
      urlChanged: location.href !== beforeUrl,
      waiting: !changed.changed,
    };
  }

  async function runProductHuntStep(request = {}) {
    const config = request.config && typeof request.config === "object" ? request.config : {};
    if (!isProductHuntPage()) {
      return {
        ok: false,
        stage: "gate",
        gate: "unsupported",
        needs_manual: true,
        keepTab: true,
        reason: "当前页不是 producthunt.com，拒绝执行 Product Hunt 专用动作",
      };
    }

    const scope = productHuntActiveScope();
    const gate = detectProductHuntGate(scope);
    if (gate) return { ok: false, stage: "gate", ...gate };

    const stage = detectProductHuntStage(scope);
    const values = productHuntConfigValues(config);
    if (stage === "unknown") {
      const text = normalizeProductHuntText(productHuntVisibleText(scope));
      return {
        ok: true,
        stage: "unknown",
        waiting: true,
        retryAfterMs: 800,
        reason: /loading|please wait|请稍候|正在加载|just a moment/.test(text)
          ? "Product Hunt 发布步骤仍在加载"
          : "等待识别 Product Hunt 当前发布步骤",
      };
    }

    if (stage === "entry") {
      return openProductHuntEntry(scope, values);
    }

    if (stage === "checklist") {
      const checklist = productHuntChecklistStatus(scope, values);
      if (!checklist.ready) {
        return {
          ok: true,
          stage,
          ready_to_create: false,
          submittedAttempt: false,
          waiting: true,
          progress: checklist.progress,
          missing: checklist.missing,
          requiredUnchecked: checklist.requiredUnchecked,
          reason: "Product Hunt checklist 尚未达到 100%，不点击最终按钮",
        };
      }

      const createButton = checklist.createButton || productHuntFindCreateDraftButton(scope);
      const label = productHuntControlLabel(createButton);
      const canCreate = productHuntShouldClickCreateDraft(request.confirmCreate, checklist.ready, label);
      if (!canCreate) {
        return {
          ok: true,
          stage,
          ready_to_create: true,
          submittedAttempt: false,
          clickedCreateDraft: false,
          finalAction: "create draft",
          reason: "checklist 已 100%，等待 background/UI 明确确认后再创建草稿",
        };
      }

      const baseline = productHuntResultBaseline(config);
      createButton.click();
      const result = await waitForProductHuntResult(
        config,
        baseline,
        Number(request.resultTimeoutMs || request.timeoutMs || 15000),
      );
      return {
        ok: true,
        stage,
        ready_to_create: true,
        submittedAttempt: true,
        clickedCreateDraft: true,
        finalAction: "create draft",
        ...result,
      };
    }

    let stageResult = { ok: true };
    if (stage === "main_info") {
      stageResult = await fillProductHuntMainInfo(scope, values);
      const requiredMissing = productHuntRequiredMissing(scope);
      stageResult.missing = [...new Set([...(stageResult.missing || []), ...requiredMissing])];
      stageResult.ok = stageResult.missing.length === 0;
    } else if (stage === "images") {
      stageResult = await fillProductHuntImages(scope, values, config);
    } else if (stage === "makers") {
      stageResult = await fillProductHuntMaker(scope, values);
    } else if (stage === "company_info") {
      stageResult = await fillProductHuntCompanyInfo(scope, values);
    } else if (stage === "shoutouts") {
      stageResult = await fillProductHuntShoutouts(scope, values);
      stageResult.ok = stageResult.ok !== false;
    } else if (stage === "extras") {
      stageResult = await fillProductHuntExtras(scope, values);
    } else if (stage === "investors") {
      stageResult = await fillProductHuntInvestors(scope, values);
      stageResult.ok = stageResult.ok !== false;
    }

    if (stageResult.gate) {
      return {
        ok: false,
        stage: "gate",
        gate: stageResult.gate,
        needs_manual: true,
        keepTab: true,
        reason: stageResult.reason || "Product Hunt 当前步骤需要人工处理",
      };
    }
    if (stageResult.ok === false) {
      return {
        ok: false,
        stage,
        waiting: true,
        keepTab: true,
        missing: stageResult.missing || [stage],
        uploaded: stageResult.uploaded || [],
        reason: "Product Hunt 当前步骤尚未满足自动化前置条件",
      };
    }

    const transition = await advanceProductHuntStage(scope, stage, {
      optional: PRODUCT_HUNT_OPTIONAL_STAGES.has(stage),
    });
    return {
      ok: true,
      stage,
      ...stageResult,
      ...transition,
    };
  }

  // Expose a narrow, non-clicking test surface. The live message route remains
  // the only way to invoke the DOM workflow; these pure helpers make the safety
  // boundary regression-testable without a browser or a third-party DOM library.
  self.__extLinkProductHunt = {
    stages: PRODUCT_HUNT_STAGES,
    runProductHuntStep,
    detectStage: productHuntStageFromSnapshot,
    detectGate: productHuntGateFromSnapshot,
    buttonPolicy: productHuntButtonPolicy,
    shouldClickCreateDraft: productHuntShouldClickCreateDraft,
    fieldSnapshotChecked: productHuntFieldSnapshotChecked,
    requiredUncheckedFromSnapshot: productHuntRequiredUncheckedFromSnapshot,
    pricingValue: productHuntPricingValue,
    classifyResult: classifyProductHuntResult,
  };
  self.__extLinkProductHuntTestHooks = self.__extLinkProductHunt;

  async function submitFilledForm(config, platform = "directory", fillResult = {}) {
    const blocker = detectSubmitBlockers();
    if (blocker?.captcha) {
      logStep("🤖 检测到验证码 — 页签留下等人，不代点提交");
      highlightCaptchaArea();
      return { captcha: true, keepTab: true, platform, ...fillResult };
    }
    if (blocker?.needs_manual) {
      logStep(`⚠️ ${blocker.reason} — 不代点提交`);
      return { needs_manual: true, reason: blocker.reason, keepTab: true, platform, ...fillResult };
    }
    if (blocker?.blocked) {
      logStep(`⛔ ${blocker.reason} — 不代点提交`);
      return { blocked: true, reason: blocker.reason, keepTab: true, platform, ...fillResult };
    }

    const submitBtn = findSubmitButton('button[type="submit"], input[type="submit"]', [
      "submit",
      "add",
      "list",
      "publish",
      "send",
    ]);
    if (!submitBtn) {
      if (!shouldAutoSubmitListing(config, platform)) return returnAfterFill(config, platform);
      const precheck = collectFormValidationState();
      if (precheck.validationFailed) {
        return {
          validationFailed: true,
          submitted: false,
          clickedSubmit: false,
          issues: precheck.issues,
          emptyCount: precheck.emptyCount,
          invalidCount: precheck.invalidCount,
          platform,
          ...fillResult,
        };
      }
      const advanceBtn = findSafeAdvanceButton();
      if (advanceBtn) {
        const beforeUrl = location.href;
        const beforeEvidence = classifyVisibleEvidence();
        const beforeStage = formStageSignature();
        advanceBtn.click();
        await sleep(900);
        const afterEvidence = classifyVisibleEvidence();
        const beforeText = String(beforeEvidence?.evidence || "").replace(/\s+/g, " ").trim();
        const afterText = String(afterEvidence?.evidence || "").replace(/\s+/g, " ").trim();
        if (afterEvidence?.matched && afterText && afterText !== beforeText) {
          return {
            ok: true,
            platform,
            clickedSubmit: true,
            submitted: true,
            matched: true,
            evidence: afterEvidence.evidence,
            publicationStatus: afterEvidence.publicationStatus || "submitted",
            evidenceSignals: [{
              type: afterEvidence.publicationStatus === "published" ? "public_listing" : "visible_confirmation",
              text: afterEvidence.evidence,
              url: redactSnapshotUrl(location.href),
              matched: true,
            }],
            ...fillResult,
          };
        }
        const stageChanged = location.href !== beforeUrl || formStageSignature() !== beforeStage;
        if (stageChanged) {
          return { ok: true, platform, stageAdvanced: true, submitted: false, matched: false, ...fillResult };
        }
      }
      logStep("⚠️ 未找到提交按钮，已填字段请手动提交");
      return { manual: true, platform, reason: "no_submit_button", ...fillResult };
    }
    if (!shouldAutoSubmitListing(config, platform)) {
      return returnAfterFill(config, platform);
    }

    const precheck = collectFormValidationState();
    if (precheck.validationFailed) {
      logStep(`⚠️ 表单校验未通过，先补填: ${precheck.issues[0] || "有必填或无效栏"}`);
      return {
        validationFailed: true,
        submitted: false,
        clickedSubmit: false,
        issues: precheck.issues,
        emptyCount: precheck.emptyCount,
        invalidCount: precheck.invalidCount,
        platform,
        ...fillResult,
      };
    }

    logStep("🚀 无验证码，代点提交…");
    const beforeUrl = location.href;
    const beforeEvidence = classifyVisibleEvidence();
    submitBtn.click();
    const classified = await waitForSubmissionEvidence(beforeUrl, beforeEvidence);
    const urlChanged = location.href !== beforeUrl;
    const matched = classified.matched === true && Boolean(classified.evidence);
    if (matched) {
      return {
        ok: true,
        platform,
        clickedSubmit: true,
        submitted: true,
        publicationStatus: classified.publicationStatus || "submitted",
        evidence: classified.evidence,
        evidenceSignals: classified.evidence
          ? [{
              type: classified.publicationStatus === "published" ? "public_listing" : "visible_confirmation",
              text: classified.evidence,
              url: redactSnapshotUrl(location.href),
              publicationStatus: classified.publicationStatus,
              matched: true,
            }]
          : [],
        matched: true,
        urlChanged,
        ...fillResult,
      };
    }

    const afterBlocker = detectSubmitBlockers();
    if (afterBlocker?.captcha) {
      highlightCaptchaArea();
      return { captcha: true, keepTab: true, clickedSubmit: true, platform, ...fillResult };
    }
    if (afterBlocker?.needs_manual) {
      return { needs_manual: true, reason: afterBlocker.reason, keepTab: true, platform, ...fillResult };
    }
    if (afterBlocker?.blocked) {
      return { blocked: true, reason: afterBlocker.reason, keepTab: true, platform, ...fillResult };
    }

    const after = collectFormValidationState();
    if (after.validationFailed) {
      logStep(`⚠️ 提交后站点仍提示漏填: ${after.issues[0] || "校验未通过"}`);
      return {
        validationFailed: true,
        submitted: false,
        clickedSubmit: true,
        issues: after.issues,
        emptyCount: after.emptyCount,
        invalidCount: after.invalidCount,
        platform,
        ...fillResult,
      };
    }

    return {
      ok: true,
      platform,
      clickedSubmit: true,
      submitted: true,
      publicationStatus: classified.publicationStatus || "submitted",
      evidence: classified.evidence || "",
      evidenceSignals: [],
      matched: false,
      urlChanged,
      ...fillResult,
    };
  }

  async function waitForSubmissionEvidence(beforeUrl, baseline = {}, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let last = classifyVisibleEvidence();
    const baselineEvidence = String(baseline?.evidence || "").replace(/\s+/g, " ").trim();
    while (Date.now() < deadline) {
      last = classifyVisibleEvidence();
      const currentEvidence = String(last?.evidence || "").replace(/\s+/g, " ").trim();
      if (last?.matched && currentEvidence && currentEvidence !== baselineEvidence) return last;
      const titleAndText = `${document.title || ""} ${document.body?.innerText || ""}`.slice(0, 1000);
      const stillLoading = /请稍候|just a moment|\bloading\b|正在加载/i.test(titleAndText);
      if (!stillLoading && location.href !== beforeUrl && document.readyState === "complete") {
        // A URL change alone is never proof. Keep polling for a receipt until the deadline.
      }
      await sleep(500);
    }
    return {
      ...(last || {}),
      publicationStatus: last?.publicationStatus || "submitted",
      evidence: "",
      matched: false,
    };
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
      "try free",
      "free trial",
      "start trial",
      "book a demo",
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
    let strongMatches = 0;
    for (const term of strongTerms) {
      if (haystack.includes(term)) {
        score += 20;
        strongMatches += 1;
      }
    }
    for (const term of mediumTerms) {
      if (haystack.includes(term)) score += 5;
    }
    const explicitPath = /\/(?:submit|submission|add-(?:tool|product|startup)|get-listed|contribute|publish)(?:[/?#-]|$)/i.test(url.pathname);
    if (url.origin === location.origin) score += 3;
    if (explicitPath) score += 8;

    // Generic marketplace/marketing links such as "Try Free" or /new-project
    // are not submission routes. Cross-origin routes need explicit link copy.
    if (!strongMatches && !explicitPath) return null;
    if (url.origin !== location.origin && !strongMatches) return null;

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

    // Step 4: Generate comment text (link stays in the URL field above, not the body)
    const commentField = document.querySelector(
      '#comment, textarea[name="comment"], textarea.comment, ' +
        'textarea[aria-label*="Comment"], textarea[placeholder*="comment" i]',
    );
    if (commentField) {
      logStep("✏️ 填写评论文本…");
      const commentText = await generateComment(config, {
        allowLink: !urlField,
        maxChars: getCommentCharBudget(commentField),
      });
      if (!commentText) {
        return { manual: true, platform: "wp_comment", reason: "no_comment_text" };
      }
      await simulateTyping(commentField, commentText);
    }

    // Step 5: Check for captcha before submitting
    if (detectCaptcha()) {
      logStep("🤖 检测到验证码 — 请手动完成");
      highlightCaptchaArea();
      return { captcha: true };
    }

    const preflight = inspectStandardWpCommentForm();
    const canAutoSubmit = shouldAutoSubmitStandardWp(config, preflight);

    // Step 6: Submit only when fillOnly is off, or the opt-in standard WP preflight passed.
    const submitBtn =
      preflight.submit ||
      findSubmitButton(
        '#submit, input[type="submit"][name="submit"], button[type="submit"], input.comment-submit, button.comment-submit, .form-submit input[type="submit"]',
        ["post comment", "submit", "comment"],
      );
    if (submitBtn) {
      if (isFillOnly(config) && !canAutoSubmit) {
        return { ...returnAfterFill(config, "wp_comment"), standardWp: preflight.ok };
      }
      logStep(canAutoSubmit ? "🚀 标准评论表单预检通过，代点提交…" : "🚀 提交评论…");
      submitBtn.click();
      await sleep(3000);
      const classified = classifyVisibleEvidence();
      return {
        ok: true,
        platform: "wp_comment",
        clickedSubmit: true,
        submitted: true,
        standardWp: preflight.ok,
        publicationStatus: classified.publicationStatus || "submitted",
        evidence: classified.evidence || "",
        matched: classified.matched === true,
      };
    }
    if (isFillOnly(config) && !canAutoSubmit) {
      return { ...returnAfterFill(config, "wp_comment"), standardWp: preflight.ok };
    }
    logStep("⚠️ 未找到评论提交按钮，已填字段请手动提交");
    return { manual: true, platform: "wp_comment", reason: "no_submit_button", standardWp: preflight.ok };
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

    if (config.deferSubmit) {
      return { ok: true, fillOnly: true, deferred: true, platform: "directory", ...result };
    }
    return submitFilledForm(config, "directory", result);
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
      const commentText = await generateComment(config, {
        allowLink: !urlField,
        maxChars: getCommentCharBudget(commentField),
      });
      if (!commentText) {
        return { manual: true, platform: "article", reason: "no_comment_text" };
      }
      await simulateTyping(commentField, commentText);
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
        const commentText = await generateComment(config, {
          maxChars: getCommentCharBudget(ta),
        });
        if (commentText) {
          await simulateTyping(ta, commentText);
          filledCount++;
        }
      } else if (name.includes("desc") || name.includes("summary")) {
        await simulateTyping(ta, config.commentTemplate || generateDescription(config));
        filledCount++;
      }
    }

    logStep(`✏️ 填充了 ${filledCount} 个字段`);
    if (filledCount === 0) {
      return { error: "no_fillable_fields", skipReason: "未找到可自动填写字段" };
    }

    if (config.deferSubmit) {
      return { ok: true, fillOnly: true, deferred: true, platform: "generic", filledCount };
    }
    return submitFilledForm(config, "generic", { filledCount });
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

    const fields = Array.from(document.querySelectorAll(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [data-lexical-editor="true"], .ProseMirror, .ql-editor',
    ))
      .filter(isRelevantSnapshotElement)
      .slice(0, 120)
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
    const widgets = Array.from(document.querySelectorAll(
      '[role="listbox"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [aria-haspopup], [aria-expanded], [data-radix-collection-item]',
    ))
      .filter(isRelevantSnapshotElement)
      .slice(0, 100)
      .map(snapshotWidget);
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

    const evidence = classifyVisibleEvidence();
    const pageText = compactText(document.body ? document.body.innerText : "", SNAPSHOT_TEXT_LIMIT);
    const evidenceSignals = evidence.matched && evidence.evidence
      ? [{
          type: evidence.publicationStatus === "published" ? "public_listing" : "visible_confirmation",
          text: evidence.evidence,
          url: redactSnapshotUrl(location.href),
          publicationStatus: evidence.publicationStatus,
          playbookId: evidence.playbookId || "",
          matched: true,
        }]
      : [];
    return {
      url: redactSnapshotUrl(location.href),
      title: document.title || "",
      text: pageText,
      domHash: hashSnapshot(`${location.href}\n${document.title}\n${pageText}\n${JSON.stringify(fields)}`),
      forms,
      fields,
      buttons,
      widgets,
      frames: Array.from(document.querySelectorAll("iframe")).slice(0, 20).map((frame) => ({
        selector: extSelector(frame),
        title: frame.title || "",
        src: redactSnapshotUrl(frame.src || ""),
        visible: isVisible(frame),
      })),
      evidenceSignals,
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
        'form, input, textarea, select, button, iframe, [contenteditable="true"], [role], [aria-haspopup], [aria-expanded], [data-lexical-editor="true"], .ProseMirror, .ql-editor, a[href]',
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
    const valueInfo = type === "file"
      ? {
          present: Boolean(element.files?.length),
          kind: "file",
          files: Array.from(element.files || []).slice(0, 6).map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
          accept: element.accept || "",
          multiple: Boolean(element.multiple),
        }
      : getSnapshotValueInfo(element, type);

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

  function snapshotWidget(element) {
    const rect = element.getBoundingClientRect();
    return {
      selector: extSelector(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || "",
      label: getSnapshotLabel(element),
      expanded: element.getAttribute("aria-expanded") || "",
      selected: element.getAttribute("aria-selected") || "",
      checked: element.getAttribute("aria-checked") || "",
      disabled: element.getAttribute("aria-disabled") === "true" || Boolean(element.disabled),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    };
  }

  function isRelevantSnapshotElement(element) {
    if (!element || !element.matches) return false;
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    if (!isVisible(element)) return false;

    const tag = element.tagName.toLowerCase();
    if (tag === "form") return true;
    if (tag === "textarea" || tag === "select" || tag === "button") return true;
    if (isContentEditableField(element)) return true;
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
    return !["hidden", "image"].includes(type);
  }

  function hashSnapshot(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function clearVisualSnapshot() {
    document.querySelectorAll(`[${VISUAL_OVERLAY_ATTR}]`).forEach((element) => element.remove());
  }

  function prepareVisualSnapshot() {
    clearVisualSnapshot();
    assignStableSelectors();
    const candidates = Array.from(document.querySelectorAll(
      'input, textarea, select, button, [contenteditable="true"], [role="button"], [role="combobox"], [role="textbox"], [role="checkbox"], [role="radio"], [aria-haspopup="listbox"], .ProseMirror, .ql-editor, a[href]',
    )).filter(isRelevantSnapshotElement).slice(0, 60);
    const elements = [];
    candidates.forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return;
      const badge = document.createElement("span");
      badge.setAttribute(VISUAL_OVERLAY_ATTR, "true");
      badge.textContent = String(index + 1);
      Object.assign(badge.style, {
        position: "fixed",
        left: `${Math.max(0, Math.min(window.innerWidth - 24, rect.left))}px`,
        top: `${Math.max(0, Math.min(window.innerHeight - 20, rect.top))}px`,
        zIndex: "2147483647",
        background: "#e11d48",
        color: "white",
        border: "1px solid white",
        borderRadius: "4px",
        padding: "1px 4px",
        font: "bold 11px/16px system-ui, sans-serif",
        pointerEvents: "none",
        boxShadow: "0 1px 4px rgba(0,0,0,.45)",
      });
      document.documentElement.append(badge);
      elements.push({
        badge: index + 1,
        selector: extSelector(element),
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || "",
        role: element.getAttribute("role") || "",
        label: getSnapshotLabel(element),
        value: getSnapshotValueInfo(element, element.getAttribute("type") || element.tagName.toLowerCase()),
      });
    });
    return { ok: true, elements, viewport: { width: window.innerWidth, height: window.innerHeight, scrollX, scrollY } };
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
        return actionFailure(action, "AI click capability is disabled; deterministic controls own navigation and submission");
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
        return actionFailure(action, "AI action plans cannot submit; deterministic preflight owns submission");
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
    if (isContentEditableField(element)) {
      const text = String(value);
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }
      if (!inserted || compactText(element.textContent, text.length + 10) !== compactText(text, text.length + 10)) {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        element.replaceChildren(paragraph);
      }
      element.classList?.remove("ql-blank");
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      return;
    }
    const nativeSetter = getNativeValueSetter(element);
    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function getNativeValueSetter(element) {
    if (isContentEditableField(element)) return null;
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
        isContentEditableField(element) ||
        ((tag === "input" || tag === "textarea") &&
          ![
            "hidden",
            "file",
            "image",
            "submit",
            "button",
            "reset",
            "checkbox",
            "radio",
          ].includes((element.type || "").toLowerCase()))
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
    if (actionType === "click") return false;

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
      element.getAttribute("data-placeholder"),
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
    const value = getElementFillValue(element);
    return {
      present: !!value,
      kind: type || "text",
      length: value ? String(value).length : 0,
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
      element.getAttribute("data-placeholder"),
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
          const inputs = el.querySelectorAll(
            'input, textarea, select, [contenteditable="true"], [role="textbox"][contenteditable]',
          );
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
    return Array.from(
      root.querySelectorAll(
        'input, textarea, select, [contenteditable="true"], [role="textbox"][contenteditable]',
      ),
    ).filter((element) => {
      if (!isFillableField(element)) return false;
      if (isContentEditableField(element) && element.parentElement?.isContentEditable) return false;
      const type = (element.type || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "reset")
        return false;
      return true;
    });
  }

  function isContentEditableField(element) {
    if (!element || !element.getAttribute) return false;
    return (
      element.isContentEditable === true ||
      element.getAttribute("contenteditable") === "true" ||
      (element.getAttribute("role") === "textbox" && element.hasAttribute("contenteditable"))
    );
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
    if (type === "checkbox" || type === "radio") {
      return element.checked ? element.value || "on" : "";
    }
    if (element.tagName.toLowerCase() === "select") return element.value || "";
    if (isContentEditableField(element)) return element.innerText || element.textContent || "";
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
        index,
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

  function normalizeDateValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (direct) return direct[0];
    const parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
  }

  function resolveDateValue(config) {
    const pf = getProfileFields(config);
    const configured =
      config.launchDate || pf["Launch Date"] || pf["Launch date"] || pf["Release Date"] || "";
    return normalizeDateValue(configured) || new Date().toISOString().slice(0, 10);
  }

  function choiceGroupKey(element, index) {
    const type = (element.type || "checkbox").toLowerCase();
    return `${type}:${element.name || element.getAttribute("data-name") || `choice-${index}`}`;
  }

  function collectChoiceGroups(elements) {
    const groups = new Map();
    elements.forEach((element, index) => {
      const type = (element.type || "").toLowerCase();
      if (type !== "checkbox" && type !== "radio") return;
      const key = choiceGroupKey(element, index);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(element);
    });
    return groups;
  }

  function choiceGroupRequired(key, elements) {
    const hint = `${key} ${elements.map((element) => getFieldHint(element)).join(" ")}`;
    return (
      elements.some(
        (element) => element.required || element.getAttribute("aria-required") === "true",
      ) || /categor|topic|industry|radio/.test(hint)
    );
  }

  function profileChoiceCorpus(config) {
    const pf = getProfileFields(config);
    return [
      config.tags,
      config.brandName,
      config.targetAudience,
      config.valueProposition,
      ...(config.useCases || []),
      pf["Feature description"],
      pf["Short description(20-30 words)"],
      pf["Short Discription(100-150 words)"],
      pf["Long description (250-500 words)"],
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function scoreChoiceLabel(label, corpus, tags) {
    const normalized = compactText(label, 120)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ");
    if (!normalized) return 0;
    let score = corpus.includes(normalized) ? 30 : 0;
    if (tags.includes(normalized)) score += 40;
    const stop = new Set([
      "ai",
      "and",
      "the",
      "tool",
      "tools",
      "online",
      "app",
      "application",
      "assistance",
      "generation",
    ]);
    for (const token of normalized.split(/[\s-]+/).filter(Boolean)) {
      if (token.length < 3 || stop.has(token)) continue;
      if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(corpus)) {
        score += token.length;
      }
      if (new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(tags)) {
        score += 15;
      }
    }
    return score;
  }

  function fillChoiceGroups(elements, config) {
    const groups = collectChoiceGroups(elements);
    const corpus = profileChoiceCorpus(config);
    const tags = String(config.tags || "").toLowerCase();
    const handled = new Set();
    const mappings = {};
    let filledCount = 0;

    for (const [key, options] of groups) {
      options.forEach((element) => handled.add(element));
      if (options.some((element) => element.checked)) continue;
      if (!choiceGroupRequired(key, options)) continue;

      const ranked = options
        .map((element) => ({
          element,
          label: getSnapshotLabel(element) || element.value || "",
          score: scoreChoiceLabel(
            getSnapshotLabel(element) || element.value || "",
            corpus,
            tags,
          ),
        }))
        .sort((a, b) => b.score - a.score);
      let selected = ranked[0];
      if (!selected || selected.score <= 0) {
        selected = ranked.find((item) => /miscellaneous|other/.test(item.label.toLowerCase()));
      }
      if (!selected) continue;

      setCheckedValue(selected.element, true);
      selected.element.dispatchEvent(new Event("input", { bubbles: true }));
      selected.element.dispatchEvent(new Event("change", { bubbles: true }));
      filledCount++;
      mappings[fieldMappingKey(selected.element)] = {
        profileKey: "category",
        value: selected.element.value || selected.label,
        label: selected.label,
      };
    }

    return { filledCount, handled, mappings };
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

    if (type === "date") {
      return resolveDateValue(config);
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

    const inferredKey =
      self.ExtLinkProfiles && typeof self.ExtLinkProfiles.inferReusableProfileKey === "function"
        ? self.ExtLinkProfiles.inferReusableProfileKey(hint, "", Object.keys(pf))
        : "";
    if (inferredKey && pf[inferredKey]) {
      return fitValueToConstraints(pf[inferredKey], getFieldConstraints(element));
    }

    return "";
  }

  async function fillSelectField(element, value) {
    if (!value) return false;
    return setSelectValue(element, value);
  }

  function isCloudMediaRef(value) {
    return /^cloud-media:\/\/[a-z0-9][a-z0-9._/-]{0,255}$/i.test(String(value || "").trim());
  }

  async function fetchCloudMediaBlob(ref, name = "") {
    const response = await chrome.runtime.sendMessage({
      action: "fetchCloudSubmissionMedia",
      ref,
      name,
    });
    if (!response?.ok || !response.dataUrl) {
      throw new Error(response?.error || "云端媒体读取失败");
    }
    return {
      blob: await (await fetch(response.dataUrl)).blob(),
      name: response.name || "image",
    };
  }

  async function attachBlobToFileInput(input, blob, sourceName) {
    if (!blob || !String(blob.type || "").startsWith("image/")) return false;
    const normalized = await normalizeImageForFileInput(blob, input);
    const mime = normalized.type || blob.type || "image/png";
    const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1]?.split("+")[0] || "png";
    const cleanBase = String(sourceName || "image").replace(/\.[a-z0-9]+$/i, "") || "image";
    const file = new File([normalized], `${cleanBase}.${ext}`, { type: mime });
    // DataTransfer assignment avoids the OS file picker, which automation cannot drive.
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function reportMediaUpload(status, details = {}) {
    chrome.runtime.sendMessage({
      action: "mediaUploadStatus",
      status,
      pageUrl: location.href,
      ...details,
    }).catch(() => {});
  }

  async function tryFillFileFromUrl(input, imageUrl, baseUrl, config, media = null) {
    if (!input || input.type !== "file") return false;

    const useLogoDataUrl = media === true || media?.useLogoDataUrl === true;
    const descriptor = media && typeof media === "object" ? media : null;
    const dataUrl = useLogoDataUrl ? config?.logoDataUrl : "";

    try {
      if (dataUrl && String(dataUrl).startsWith("data:")) {
        const blob = await (await fetch(dataUrl)).blob();
        if (await attachBlobToFileInput(input, blob, "logo")) {
          reportMediaUpload("success", { name: "logo", source: "embedded", bytes: blob.size, mime: blob.type });
          return true;
        }
      }
      if (imageUrl) {
        if (isCloudMediaRef(imageUrl)) {
          const cloud = await fetchCloudMediaBlob(imageUrl, descriptor?.profileKey || "cloud-media");
          if (await attachBlobToFileInput(input, cloud.blob, cloud.name)) {
            logStep(`☁️ 已用云端媒体上传 ${cloud.name}`);
            reportMediaUpload("success", { name: cloud.name, source: "cloud", bytes: cloud.blob.size, mime: cloud.blob.type });
            return true;
          }
        }
        const absolute = new URL(imageUrl, baseUrl || location.href).href;
        const sourceName = absolute.split("/").pop()?.split("?")[0] || "image";
        const blob = await fetchSubmissionMediaBlob(absolute);
        if (await attachBlobToFileInput(input, blob, sourceName)) {
          reportMediaUpload("success", { name: sourceName, source: "remote", bytes: blob.size, mime: blob.type });
          return true;
        }
      }
    } catch {
      /* The page may block remote image reads; report the usable cloud reference below. */
    }
    reportMediaUpload("failed", { profile: config?.projectKey || "", reason: "没有可用或符合要求的云端媒体文件" });
    return false;
  }

  async function fetchSubmissionMediaBlob(absoluteUrl) {
    try {
      const response = await fetch(absoluteUrl, { credentials: "omit" });
      if (response.ok) return response.blob();
    } catch {
      /* Cross-origin images are fetched by the extension service worker below. */
    }

    const proxied = await chrome.runtime.sendMessage({
      action: "fetchSubmissionMedia",
      url: absoluteUrl,
    });
    if (!proxied?.ok || !proxied.dataUrl) {
      throw new Error(proxied?.error || "图片下载失败");
    }
    return (await fetch(proxied.dataUrl)).blob();
  }

  function getUploadFieldContext(input) {
    const chunks = [getSnapshotLabel(input), input.accept || ""];
    let current = input.parentElement;
    for (let depth = 0; current && depth < 3; depth++, current = current.parentElement) {
      const text = compactText(current.textContent || "", 800);
      if (text) chunks.push(text);
      if (/format|ratio|max(?:imum)? dimension|upload/i.test(text)) break;
    }
    return chunks.join(" ");
  }

  function parseImageUploadConstraints(input) {
    const context = getUploadFieldContext(input);
    const maxMatch = context.match(
      /max(?:imum)?(?:\s+dimensions?|\s+dimension\s+is)?[^\d]{0,20}(\d+)\s*px?\s*(?:by|x|×)\s*(\d+)\s*px?/i,
    );
    const ratioMatch = context.match(/(?:ratio\s*(?:is|:)?\s*)?(\d+)\s*:\s*(\d+)/i);
    const accept = String(input.accept || "").toLowerCase();
    const acceptedTypes = new Set();
    if (!accept || accept.includes("image/*")) {
      acceptedTypes.add("image/jpeg");
      acceptedTypes.add("image/png");
      acceptedTypes.add("image/webp");
    }
    if (/image\/jpeg|\.jpe?g|\bjpeg?\b/.test(accept + " " + context)) {
      acceptedTypes.add("image/jpeg");
    }
    if (/image\/png|\.png|\bpng\b/.test(accept + " " + context)) {
      acceptedTypes.add("image/png");
    }
    if (/image\/webp|\.webp|\bwebp\b/.test(accept + " " + context)) {
      acceptedTypes.add("image/webp");
    }
    return {
      maxWidth: maxMatch ? Number(maxMatch[1]) : null,
      maxHeight: maxMatch ? Number(maxMatch[2]) : null,
      aspectRatio:
        ratioMatch && Number(ratioMatch[2]) > 0
          ? Number(ratioMatch[1]) / Number(ratioMatch[2])
          : null,
      acceptedTypes,
    };
  }

  async function normalizeImageForFileInput(blob, input) {
    const constraints = parseImageUploadConstraints(input);
    const bitmap = await createImageBitmap(blob);
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = bitmap.width;
    let sourceHeight = bitmap.height;

    if (constraints.aspectRatio) {
      const currentRatio = sourceWidth / sourceHeight;
      if (Math.abs(currentRatio - constraints.aspectRatio) > 0.01) {
        if (currentRatio > constraints.aspectRatio) {
          sourceWidth = Math.round(sourceHeight * constraints.aspectRatio);
          sourceX = Math.round((bitmap.width - sourceWidth) / 2);
        } else {
          sourceHeight = Math.round(sourceWidth / constraints.aspectRatio);
          sourceY = Math.round((bitmap.height - sourceHeight) / 2);
        }
      }
    }

    const scale = Math.min(
      1,
      constraints.maxWidth ? constraints.maxWidth / sourceWidth : 1,
      constraints.maxHeight ? constraints.maxHeight / sourceHeight : 1,
    );
    const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.floor(sourceHeight * scale));
    const formatAccepted =
      constraints.acceptedTypes.size === 0 || constraints.acceptedTypes.has(blob.type);
    const needsTransform =
      !formatAccepted ||
      sourceX !== 0 ||
      sourceY !== 0 ||
      sourceWidth !== bitmap.width ||
      sourceHeight !== bitmap.height ||
      targetWidth !== bitmap.width ||
      targetHeight !== bitmap.height;

    if (!needsTransform) {
      bitmap.close();
      return blob;
    }

    const outputType = constraints.acceptedTypes.has("image/png")
      ? "image/png"
      : "image/jpeg";
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { alpha: outputType === "image/png" });
    if (!context) throw new Error("浏览器无法转换图片");
    if (outputType === "image/jpeg") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, targetWidth, targetHeight);
    }
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      targetWidth,
      targetHeight,
    );
    bitmap.close();
    const output = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("图片转换失败"))),
        outputType,
        0.9,
      );
    });
    return output;
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
    const choiceResult = fillChoiceGroups(elements, config);
    let filledCount = choiceResult.filledCount;
    const mappings = { ...choiceResult.mappings };
    const skippedFiles = [];
    const inferredFields = new Set();
    let screenshotCursor = 0;

    for (const element of elements) {
      const type = (element.type || "").toLowerCase();
      const tag = element.tagName.toLowerCase();

      if (choiceResult.handled.has(element)) continue;

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
        const ok = await tryFillFileFromUrl(element, value, baseUrl, config, {
          ...(media || {}),
          index: media?.explicitIndex ? media.index : screenshotCursor,
        });
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

      const existingValue = getElementFillValue(element);
      const existing = existingValue && String(existingValue).trim();
      if (existing && !fieldNeedsRefill(element)) continue;

      const resolved = value || resolveValueForField(config, element);
      if (!resolved) continue;

      if (
        type === "date" &&
        !normalizeDateValue(
          config.launchDate ||
            pf["Launch Date"] ||
            pf["Launch date"] ||
            pf["Release Date"] ||
            "",
        )
      ) {
        inferredFields.add(getSnapshotLabel(element) || element.name || "Launch Date");
      }

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

    return { filledCount, mappings, skippedFiles, inferredFields: [...inferredFields] };
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
    const choiceGroups = collectChoiceGroups(elements);
    const choiceElements = new Set([...choiceGroups.values()].flat());
    let emptyCount = 0;
    let invalidCount = 0;
    const totalCount =
      elements.length - choiceElements.size + choiceGroups.size + customDropdowns.length;

    for (const element of elements) {
      if (choiceElements.has(element)) continue;
      const type = (element.type || "").toLowerCase();
      if (type === "file") {
        if ((!element.files || element.files.length === 0) && fieldIsRequired(element)) {
          emptyCount++;
        }
        continue;
      }
      const tag = element.tagName.toLowerCase();
      if (tag === "select" && isSelectEmpty(element)) {
        if (fieldIsRequired(element)) emptyCount++;
        continue;
      }
      const value = getElementFillValue(element);
      if (!value || !String(value).trim()) {
        if (fieldIsRequired(element)) emptyCount++;
        continue;
      }
      if (fieldNeedsRefill(element)) invalidCount++;
    }

    for (const [key, options] of choiceGroups) {
      if (choiceGroupRequired(key, options) && !options.some((element) => element.checked)) {
        emptyCount++;
      }
    }

    for (const trigger of customDropdowns) {
      if (isCustomDropdownEmpty(trigger) && fieldIsRequired(trigger)) emptyCount++;
    }

    return {
      emptyCount,
      invalidCount,
      totalCount,
      allValid: emptyCount === 0 && invalidCount === 0,
    };
  }

  function collectVisibleFieldErrors() {
    const issues = [];
    const nodes = document.querySelectorAll(
      "form [aria-invalid='true'], form .invalid-feedback, form .field-error, form .error-message, form .form-error, form .help-block, form [role='alert']",
    );
    const looksLikeError =
      /required|必填|请填写|请选择|this field|is required|cannot be empty|can't be empty|can’t be empty|missing|invalid|填写|选择一项|不能为空/i;
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const text = compactText(node.innerText || node.textContent || "", 160);
      if (!text) continue;
      if (node.getAttribute("aria-invalid") === "true" || looksLikeError.test(text)) {
        issues.push(text);
      }
    }
    for (const element of queryFillableElements()) {
      if (element.getAttribute("aria-invalid") === "true") {
        issues.push(`${getSnapshotLabel(element) || element.name || "字段"}: 站点标记为无效`);
      }
      try {
        if (typeof element.checkValidity === "function" && !element.checkValidity()) {
          issues.push(
            `${getSnapshotLabel(element) || element.name || "字段"}: ${
              element.validationMessage || "HTML 校验未通过"
            }`,
          );
        }
      } catch {
        /* ignore */
      }
    }
    return [...new Set(issues)].slice(0, 12);
  }

  function collectFormValidationState() {
    const empty = countEmptyFillableFields();
    const issues = collectVisibleFieldErrors();
    if (empty.emptyCount > 0) issues.unshift(`还有 ${empty.emptyCount} 个必填栏未填`);
    if (empty.invalidCount > 0) issues.unshift(`${empty.invalidCount} 个字段校验未通过`);
    return {
      ...empty,
      issues,
      validationFailed: empty.emptyCount > 0 || empty.invalidCount > 0 || issues.length > 0,
    };
  }

  function fieldIsRequired(element) {
    if (!element) return false;
    if (element.required || element.getAttribute("aria-required") === "true") return true;
    return /(^|\s)\*($|\s)|\brequired\b/i.test(getSnapshotLabel(element));
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
      else val = getElementFillValue(element);
      if (!val || !String(val).trim()) continue;
      const key = fieldMappingKey(element);
      mappings[key] = {
        profileKey: inferProfileKeyForValue(config, val),
        value: String(val).trim(),
        label: getSnapshotLabel(element),
        hint: getFieldHint(element),
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

  function findSafeAdvanceButton() {
    const candidates = Array.from(document.querySelectorAll(
      'button[type="button"], input[type="button"], [role="button"]',
    ));
    return candidates.find((element) => {
      if (!isVisible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") return false;
      const label = getElementLabel(element).replace(/\s+/g, " ").trim();
      if (/submit|publish|launch|finish|done|save|send|create|post|confirm|pay|checkout|sign in|log in|agree|提交|发布|完成|保存|发送|创建|确认|付款|登录|同意/i.test(label)) return false;
      return /^(next|continue|proceed|下一步|继续)(?:\s|$|[>→»])/i.test(label);
    }) || null;
  }

  function formStageSignature() {
    return hashSnapshot(Array.from(document.querySelectorAll(
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"], button, [role="button"], [role="combobox"]',
    )).filter(isVisible).slice(0, 120).map((element) => [
      element.tagName,
      element.getAttribute("name") || "",
      element.getAttribute("role") || "",
      getElementLabel(element),
    ].join("|")).join("\n"));
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
  // ─── Page Prescan (target quality signals before spending a submission) ───
  function prescanPage() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const host = location.hostname.replace(/^www\./, "");
    let external = 0;
    let externalNofollow = 0;
    let userContentNofollow = 0;

    for (const anchor of anchors) {
      let anchorHost = "";
      try {
        anchorHost = new URL(anchor.href, location.href).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (!anchorHost || anchorHost === host || anchorHost.endsWith(`.${host}`)) continue;
      external++;
      const rel = (anchor.getAttribute("rel") || "").toLowerCase();
      if (/\bnofollow\b/.test(rel)) externalNofollow++;
      if (/\b(?:ugc|sponsored)\b/.test(rel)) userContentNofollow++;
    }

    const nofollowRatio = external ? externalNofollow / external : null;
    const commentAnchors = Array.from(
      document.querySelectorAll(
        ".comment a[href], .comments a[href], #comments a[href], .comment-list a[href]",
      ),
    );
    let commentExternal = 0;
    let commentNofollow = 0;
    for (const anchor of commentAnchors) {
      let anchorHost = "";
      try {
        anchorHost = new URL(anchor.href, location.href).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      if (!anchorHost || anchorHost === host || anchorHost.endsWith(`.${host}`)) continue;
      commentExternal++;
      if (/\bnofollow\b/.test((anchor.getAttribute("rel") || "").toLowerCase())) commentNofollow++;
    }

    // Existing comment links are the strongest signal: they show what this site
    // actually grants to submitted links, not what it grants to its own editorial ones.
    let dofollowLikely = null;
    if (commentExternal >= 3) dofollowLikely = commentNofollow / commentExternal < 0.5;
    else if (external >= 5) dofollowLikely = nofollowRatio < 0.5;

    const commentField = queryFillableElements().find((element) => {
      if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) return false;
      return /comment|reply|message|review|正文|评论|回复/i.test(getSnapshotLabel(element));
    });
    const commentMaxLength = commentField
      ? Number(commentField.getAttribute("maxlength") || commentField.maxLength || 0)
      : 0;
    const robots = String(document.querySelector('meta[name="robots"]')?.getAttribute("content") || "").toLowerCase();
    const indexable = !/\bnoindex\b/.test(robots);

    return {
      url: location.href,
      hostname: location.hostname,
      title: compactText(document.title || "", 300),
      description: getPageMetaDescription(),
      keywords: compactText(
        document.querySelector('meta[name="keywords"]')?.getAttribute("content") || "",
        300,
      ),
      h1: compactText(document.querySelector("h1")?.innerText || "", 200),
      externalLinks: external,
      externalNofollow,
      userContentNofollow,
      nofollowRatio: nofollowRatio == null ? null : Number(nofollowRatio.toFixed(3)),
      commentExternalLinks: commentExternal,
      commentNofollow,
      dofollowLikely,
      hasCommentForm: detectWPComment() || detectArticleComment(),
      hasCaptcha: detectCaptcha(),
      formFieldCount: queryFillableElements().length,
      articleChars: extractArticleText(12000).length,
      commentMaxLength: commentMaxLength > 0 ? commentMaxLength : null,
      commentFieldLabel: commentField ? compactText(getSnapshotLabel(commentField), 160) : "",
      indexable,
      robots: compactText(robots, 160),
    };
  }

  // ─── Manual Fill Icons (fallback when auto-detection misses a field) ───
  const MANUAL_ICON_ATTR = "data-extlink-manual-icon";
  const MANUAL_ICON_STYLE_ID = "extlink-manual-fill-style";
  let manualIconConfig = null;
  let manualIconsEnabled = false;
  let manualIconTimer = null;
  let manualIconObserver = null;

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.activeSiteId || changes.siteProfiles)) {
        manualIconConfig = null;
      }
    });
  }

  function ensureManualIconStyles() {
    if (document.getElementById(MANUAL_ICON_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = MANUAL_ICON_STYLE_ID;
    style.textContent = `
      .extlink-manual-icon {
        position: absolute; z-index: 2147483000; width: 20px; height: 20px;
        padding: 0; margin: 0; border: none; border-radius: 6px; cursor: pointer;
        background: rgba(37, 99, 235, 0.92); color: #fff; font: 600 11px/20px
        -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center;
        box-shadow: 0 1px 4px rgba(15, 23, 42, 0.3); opacity: 0.45;
        transition: opacity 120ms ease, transform 120ms ease;
      }
      .extlink-manual-icon:hover { opacity: 1; transform: scale(1.08); }
      .extlink-manual-icon[data-state="done"] { background: rgba(22, 163, 74, 0.95); opacity: 0.9; }
      .extlink-manual-icon[data-state="empty"] { background: rgba(217, 119, 6, 0.95); opacity: 0.9; }
      @media (max-width: 640px) { .extlink-manual-icon { width: 24px; height: 24px; line-height: 24px; } }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function positionManualIcon(icon, field) {
    const rect = field.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      icon.style.display = "none";
      return;
    }
    icon.style.display = "block";
    icon.style.top = `${window.scrollY + rect.top + 4}px`;
    icon.style.left = `${window.scrollX + rect.right - 24}px`;
  }

  function isSearchOrChromeField(element) {
    const hint = `${getFieldHint(element)} ${getSnapshotLabel(element)} ${element.getAttribute("role") || ""}`.toLowerCase();
    const type = (element.type || "").toLowerCase();
    if (type === "search") return true;
    return /search|query|\bnav\b|newsletter|subscribe|password|otp|one-time/.test(hint);
  }

  function pageLooksLikeManualFillTarget() {
    if (detectWPComment() || detectDirectory()) return true;
    if (document.querySelector("#commentform, form.comment-form, textarea[name='comment']")) {
      return true;
    }
    for (const form of document.querySelectorAll("form")) {
      if (form.querySelector('input[type="password"], input[type="search"]')) continue;
      const hasWebsite = form.querySelector(
        'input[type="url"], input[name="url"], input[name="website"], input[name="link"], input[name="product_url"]',
      );
      const hasLongText = form.querySelector("textarea");
      const fields = form.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
      );
      if (hasWebsite && hasLongText && fields.length >= 3) return true;
    }
    return false;
  }

  function manualIconTargets() {
    return queryFillableElements().filter((element) => {
      const type = (element.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image"].includes(type)) return false;
      if (["checkbox", "radio"].includes(type)) return false;
      if (element.disabled || element.readOnly) return false;
      if (isSearchOrChromeField(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width >= 80 && rect.height >= 18;
    });
  }

  async function loadManualIconConfig() {
    try {
      const response = await chrome.runtime.sendMessage({ action: "getActiveFillConfig" });
      if (response?.ok && response.config) {
        manualIconConfig = response.config;
        return manualIconConfig;
      }
    } catch {
      /* background unavailable */
    }
    return null;
  }

  async function handleManualIconClick(event, field) {
    event.preventDefault();
    event.stopPropagation();
    const icon = event.currentTarget;
    const config = await loadManualIconConfig();
    if (!config) {
      icon.dataset.state = "empty";
      icon.title = "未配置网站资料，请先在设置页填写";
      return;
    }

    const type = (field.type || "").toLowerCase();
    let value = "";
    if (field.tagName.toLowerCase() === "select") {
      const selectValue = resolveSelectValueForField(field, config);
      if (selectValue && setSelectValue(field, selectValue)) {
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        icon.dataset.state = "done";
        icon.title = `已填：${selectValue}`;
        return;
      }
    } else if (type === "file") {
      const media = resolveFileMedia(config, field, 0);
      const ok = await tryFillFileFromUrl(field, media?.value, config.targetDomain, config, media);
      icon.dataset.state = ok ? "done" : "empty";
      icon.title = ok ? "已从图库上传" : "图库中没有匹配的图片";
      return;
    } else if (isCommentLikeField(field)) {
      value = await generateComment(config, {
        preferTemplate: false,
        maxChars: getCommentCharBudget(field),
      });
    } else {
      value = resolveValueForField(config, field) || "";
    }

    if (!value) {
      icon.dataset.state = "empty";
      icon.title = "资料里没有匹配这个字段的内容";
      return;
    }

    const fitted = fitValueToConstraints(String(value), getFieldConstraints(field));
    await simulateTyping(field, fitted);
    icon.dataset.state = "done";
    icon.title = `已填：${fitted.slice(0, 60)}`;
  }

  function isCommentLikeField(field) {
    const hint = `${getFieldHint(field)} ${getSnapshotLabel(field)}`.toLowerCase();
    return (
      field.tagName.toLowerCase() === "textarea" &&
      /comment|reply|message|body|thoughts|feedback/.test(hint)
    );
  }

  function syncManualIcons() {
    if (!manualIconsEnabled) return;
    ensureManualIconStyles();

    const seen = new Set();
    for (const field of manualIconTargets()) {
      let icon = field.__extLinkManualIcon;
      if (!icon || !icon.isConnected) {
        icon = document.createElement("button");
        icon.type = "button";
        icon.className = "extlink-manual-icon";
        icon.setAttribute(MANUAL_ICON_ATTR, "1");
        icon.setAttribute("aria-label", "ExternalLink 手动填充此字段");
        icon.textContent = "EL";
        icon.title = "点击用当前网站资料填充这个字段";
        icon.addEventListener("click", (event) => handleManualIconClick(event, field));
        document.body.appendChild(icon);
        field.__extLinkManualIcon = icon;
      }
      positionManualIcon(icon, field);
      seen.add(icon);
    }

    for (const icon of document.querySelectorAll(`[${MANUAL_ICON_ATTR}]`)) {
      if (!seen.has(icon)) icon.remove();
    }
  }

  function scheduleManualIconSync() {
    if (!manualIconsEnabled) return;
    clearTimeout(manualIconTimer);
    manualIconTimer = setTimeout(syncManualIcons, 250);
  }

  function teardownManualIcons() {
    manualIconsEnabled = false;
    clearTimeout(manualIconTimer);
    manualIconObserver?.disconnect();
    manualIconObserver = null;
    for (const icon of document.querySelectorAll(`[${MANUAL_ICON_ATTR}]`)) icon.remove();
  }

  async function initManualIcons() {
    if (manualIconsEnabled || !document.body) return;
    // Only decorate pages that look like a comment or directory submission form.
    if (!pageLooksLikeManualFillTarget()) return;

    let filters = null;
    try {
      const response = await chrome.runtime.sendMessage({ action: "getActiveFillConfig" });
      filters = response?.filters || null;
      if (response?.ok && response.config) manualIconConfig = response.config;
    } catch {
      return;
    }
    if (!filters || filters.showManualFillIcons === false) return;

    manualIconsEnabled = true;
    syncManualIcons();
    window.addEventListener("scroll", scheduleManualIconSync, { passive: true });
    window.addEventListener("resize", scheduleManualIconSync, { passive: true });
    manualIconObserver = new MutationObserver(scheduleManualIconSync);
    manualIconObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Comment Generation (AI-first, page-aware) ───

  // Cache per page so a multi-round fill does not re-bill the same draft request.
  let commentDraftCacheKey = "";
  let commentDraftCacheValue = null;

  const ARTICLE_CONTENT_SELECTORS = [
    "article",
    '[itemprop="articleBody"]',
    ".post-content",
    ".entry-content",
    ".article-content",
    ".post-body",
    ".markdown-body",
    "main",
    '[role="main"]',
  ];

  const ARTICLE_NOISE_SELECTORS =
    "nav, header, footer, aside, script, style, noscript, form, " +
    ".comments, #comments, .comment-list, .wp-block-comments, .sidebar, " +
    ".related, .share, .advertisement, .ad, [aria-hidden='true']";

  function extractArticleText(limit = 9000) {
    let best = null;
    let bestLength = 0;
    for (const selector of ARTICLE_CONTENT_SELECTORS) {
      for (const node of document.querySelectorAll(selector)) {
        if (!isVisible(node)) continue;
        const length = (node.innerText || "").trim().length;
        if (length > bestLength) {
          best = node;
          bestLength = length;
        }
      }
      if (bestLength > 600) break;
    }

    const source = best || document.body;
    if (!source) return "";

    // Clone so removing chrome/navigation noise never mutates the live page.
    let text = "";
    try {
      const clone = source.cloneNode(true);
      clone.querySelectorAll(ARTICLE_NOISE_SELECTORS).forEach((node) => node.remove());
      text = clone.innerText || clone.textContent || "";
    } catch {
      text = source.innerText || "";
    }
    return compactText(text, limit);
  }

  function getCommentCharBudget(field) {
    const constraints = getFieldConstraints(field) || {};
    const maxLength = Number(constraints.maxLength);
    if (Number.isFinite(maxLength) && maxLength > 60) return Math.min(maxLength, 2000);
    return 700;
  }

  function getPageMetaDescription() {
    const meta = document.querySelector(
      'meta[name="description"], meta[property="og:description"]',
    );
    return compactText(meta?.getAttribute("content") || "", 400);
  }

  async function requestCommentDrafts(config, options = {}) {
    const cacheKey = `${config?.projectKey || ""}|${location.href}`;
    if (!options.refresh && commentDraftCacheKey === cacheKey && commentDraftCacheValue) {
      return commentDraftCacheValue;
    }

    const pageText = extractArticleText();
    if (pageText.length < 120) return null;

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action: "generateCommentDrafts",
        pageUrl: location.href,
        pageTitle: [document.title, getPageMetaDescription()].filter(Boolean).join(" — "),
        pageText,
        config,
        count: options.count || 1,
        maxChars: options.maxChars || 700,
        allowLink: options.allowLink !== false,
        refresh: options.refresh === true,
      });
    } catch {
      return null;
    }

    if (!response?.ok || !response.drafts?.length) {
      if (response?.reason) logStep(`ℹ️ AI 评论未采用: ${response.reason}`);
      else if (response?.error) logStep(`⚠️ AI 评论生成失败: ${response.error}`);
      return null;
    }

    commentDraftCacheKey = cacheKey;
    commentDraftCacheValue = response;
    return response;
  }

  function fallbackComment(config) {
    // Last resort only: a page-anchored line beats a canned compliment, but both
    // are weaker than an AI draft, so this path is logged as degraded.
    const heading = compactText(
      document.querySelector("h1")?.innerText || document.title || "",
      110,
    );
    const meta = getPageMetaDescription();
    if (heading) {
      return meta
        ? `Reading through "${heading}" — the part about ${meta.split(/[.;]/)[0].trim().slice(0, 90)} matches what we ran into, though our numbers came out somewhat different. Curious how this holds up at larger scale.`
        : `Reading through "${heading}" — this lines up with what we ran into on a similar setup, though a few of the details played out differently for us. Curious how it holds up at larger scale.`;
    }
    return "";
  }

  async function generateComment(config, options = {}) {
    if (config?.commentTemplate && options.preferTemplate !== false) {
      return config.commentTemplate;
    }

    const drafts = await requestCommentDrafts(config, options);
    if (drafts?.drafts?.length) {
      const draft = drafts.drafts[0];
      const anchor = draft.anchorText && draft.placement === "body" ? draft.anchorText : "";
      logStep(
        `🧠 AI 评论已生成${draft.angle ? ` (${draft.angle})` : ""}${anchor ? "，正文含锚文本" : "，正文无链接"}`,
      );
      return draft.text;
    }

    const fallback = fallbackComment(config);
    if (fallback) {
      logStep("⚠️ AI 评论不可用，已改用页面标题兜底文案");
      return fallback;
    }
    logStep("⚠️ 无法生成切题评论，已跳过评论正文");
    return "";
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
