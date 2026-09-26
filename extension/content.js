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
  const LEGAL_POLICY_REFERENCE_PATTERN = /\bterms(?:\s+(?:of\s+(?:service|use)|and\s+conditions))?\b|\bprivacy\s+policy\b|\buser\s+agreement\b|\bsubmission\s+guidelines\b|\blisting\s+(?:terms|guidelines)\b|服务条款|使用条款|隐私政策|提交规则|收录规则/;
  const AI_TOOLS_DIRECTORY_MANUAL_REASON = "AI Tools Directory 拒收 AI 生成或复制的文案；请用户独立撰写原创介绍并手动提交";
  const STARTUP_STASH_RECEIPT = "Thank you for applying to get listed on StartupStash! We will get back to you as early as possible :)";
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
  let manualSubmissionWatch = null;
  let pluginSubmitInProgress = false;
  // Every async fill/comment/media operation captures this lightweight page
  // context before it starts. Full navigations tear down the content script,
  // but SPA route changes keep it alive and otherwise let an old response
  // write into the newly-rendered page.
  let pageContextVersion = 0;

  function isAiToolsDirectoryHost() {
    const host = String(location.hostname || "").toLowerCase();
    if (/^(?:www\.)?aitoolsdirectory\.com$/.test(host)) return true;
    // The site's live submission form runs in this specific cross-origin
    // Paperform iframe. Content scripts run in all frames, so the parent-host
    // guard alone would leave its form writable by a frame-targeted message.
    if (host !== "aitool.paperform.co") return false;
    if (/^\/?$/.test(String(location.pathname || ""))) return true;
    try {
      return /^(?:www\.)?aitoolsdirectory\.com$/i.test(new URL(document.referrer).hostname);
    } catch {
      return false;
    }
  }

  function aiToolsDirectoryManualGate() {
    return {
      ok: false,
      needs_manual: true,
      keepTab: true,
      submitted: false,
      clickedSubmit: false,
      filledCount: 0,
      reason: AI_TOOLS_DIRECTORY_MANUAL_REASON,
    };
  }

  function capturePageContext() {
    return {
      href: String(location.href || ""),
      version: pageContextVersion,
      body: document.body || null,
    };
  }

  function isCurrentPageContext(context) {
    return !!context &&
      context.version === pageContextVersion &&
      context.href === String(location.href || "") &&
      (!context.body || context.body === document.body);
  }

  function stalePageResult(platform, details = {}) {
    return {
      ok: false,
      stale: true,
      needs_manual: true,
      keepTab: true,
      platform,
      submitted: false,
      clickedSubmit: false,
      reason: "页面已切换，已丢弃旧填表结果，请重新检测当前页面",
      ...details,
    };
  }

  function observeManualSubmission(event) {
    if (!chrome.runtime?.id || !event.isTrusted || !manualSubmissionWatch || pluginSubmitInProgress) return;
    const control = event.target?.closest?.('button, input[type="submit"], [role="button"]');
    const siteHost = (value) => {
      try {
        return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
          .hostname.toLowerCase().replace(/^www\./, "");
      } catch {
        return "";
      }
    };
    const expectedHost = siteHost(String(manualSubmissionWatch.targetDomain || ""));
    const destinationHost = siteHost(String(manualSubmissionWatch.destinationUrl || ""));
    const currentHost = siteHost(String(location.href || ""));
    const typeformFrame = currentHost === "typeform.com" || currentHost.endsWith(".typeform.com");
    const controlHint = control
      ? [
          control.textContent,
          control.getAttribute?.("aria-label"),
          control.getAttribute?.("data-qa"),
          control.getAttribute?.("name"),
          control.getAttribute?.("id"),
        ].filter(Boolean).join(" ").toLowerCase()
      : "";
    const typeformFinalControl = typeformFrame && Boolean(expectedHost || destinationHost) &&
      /\b(submit|send|apply|finish|complete|done)\b|提交|完成/.test(controlHint) &&
      !/\b(next|continue|ok|back|previous)\b/.test(controlHint);
    // Google Forms uses a div[role=button] for its final Submit action. The
    // watcher is bound to the source tab and must also find this Profile's
    // exact website host in a labelled URL answer before it can record.
    const googleFormFinalControl = currentHost === "docs.google.com" &&
      /^\/forms\/(?:u\/\d+\/)?d\/e\/[^/]+\/viewform$/i.test(location.pathname) &&
      destinationHost && destinationHost !== currentHost &&
      control?.getAttribute?.("role") === "button" &&
      /\bsubmit\b|提交/.test(controlHint) &&
      !/\b(next|continue|back|previous)\b|下一步|上一步/.test(controlHint);
    if (event.type !== "submit" && (!control || (!isSubmitControl(control) && !typeformFinalControl && !googleFormFinalControl))) return;
    const scope = event.type === "submit"
      ? event.target
      : control?.form || control?.closest("form") || document;
    if (!scope) return;
    // The profile may promote a deep link while a directory asks for the
    // product homepage. Match the exact host, not the path, before attributing
    // a manual submit to this Profile. Never use a substring host match.
    const hasDescription = !!scope.querySelector("textarea");
    const matchingUrl = [...scope.querySelectorAll("input")].some((input) => {
      const type = String(input.type || "").toLowerCase();
      if (type && !["text", "url", "search"].includes(type)) return false;
      if (!expectedHost || siteHost(String(input.value || "")) !== expectedHost) return false;
      if (type === "url" || hasDescription) return true;
      const labels = [...(input.labels || [])].map((label) => label.textContent || "");
      const labelledBy = String(input.getAttribute?.("aria-labelledby") || "")
        .split(/\s+/).map((id) => document.getElementById?.(id)?.textContent || "");
      const hint = [input.name, input.id, input.placeholder, ...labels, ...labelledBy].join(" ");
      return /\b(url|website|web\s*site|link|domain|site\s*address)\b/i.test(hint);
    });
    // Typeform keeps the product URL in an earlier answer and renders the
    // final action inside a cross-origin frame, so no same-frame URL field is
    // available at the final click. Restrict this fallback to a named final
    // action on Typeform; intermediate question controls stay ignored.
    if (!matchingUrl && !typeformFinalControl) return;
    const watch = manualSubmissionWatch;
    manualSubmissionWatch = null;
    chrome.runtime.sendMessage({
      action: "manualSubmissionClicked",
      token: watch.token,
      frameUrl: String(location.href || ""),
      baselineEvidence: watch.baselineEvidence || "",
    }).then((response) => {
      if (response?.ok !== true && manualSubmissionWatch === null) {
        manualSubmissionWatch = watch;
      }
    }).catch(() => {
      if (manualSubmissionWatch === null) manualSubmissionWatch = watch;
    });
  }
  if (window.__extLinkManualSubmitHandler) {
    document.removeEventListener("click", window.__extLinkManualSubmitHandler, true);
    document.removeEventListener("submit", window.__extLinkManualSubmitHandler, true);
  }
  window.__extLinkManualSubmitHandler = observeManualSubmission;
  document.addEventListener("click", observeManualSubmission, true);
  document.addEventListener("submit", observeManualSubmission, true);

  function onExtensionMessage(msg, sender, sendResponse) {
    if (msg.action === "watchManualSubmission") {
      manualSubmissionWatch = {
        token: msg.token,
        targetDomain: msg.targetDomain,
        destinationUrl: msg.destinationUrl || "",
      };
      const baseline = classifyVisibleEvidence({ destinationUrl: manualSubmissionWatch.destinationUrl });
      manualSubmissionWatch.baselineEvidence = baseline.evidence || "";
      chrome.runtime.sendMessage({
        action: "manualSubmissionWatchReady",
        token: msg.token,
        baseline,
        frameUrl: String(location.href || ""),
      }).catch(() => {});
      sendResponse({ ok: true, baseline });
      return true;
    }
    if (msg.action === "ping") {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === "getSubmissionSourceContext") {
      sendResponse({
        ok: true,
        pageUrl: String(location.href || ""),
        referrer: String(document.referrer || ""),
      });
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
      sendResponse(classifyVisibleEvidence({
        destinationUrl: msg.destinationUrl || manualSubmissionWatch?.destinationUrl || "",
      }));
      return true;
    }
    if (msg.action === "inspectAutoFillGuard") {
      sendResponse(inspectAutoFillGuard(msg.targetDomain || ""));
      return true;
    }
    if (msg.action === "inspectCurrentFormStage") {
      sendResponse({
        signature: formStageSignature(),
        validation: collectFormValidationState(),
      });
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
        const submitBlocker = operable && platform !== "wp_comment" && platform !== "article"
          ? detectSubmitBlockers()
          : null;
        const playbook =
          self.ExtLinkPlaybooks && typeof self.ExtLinkPlaybooks.lookup === "function"
            ? self.ExtLinkPlaybooks.lookup(location.href)
            : null;
        const productHuntReceipt = (() => {
          const match = location.pathname.match(/^\/products\/([^/?#]+)/i);
          if (!match) return null;
          const text = productHuntVisibleText(document);
          const draft = text.match(/this product is a draft[^.]*\.?/i)?.[0] || "";
          const heading = compactText(document.querySelector("h1")?.textContent || "", 160);
          if (!draft || !heading) return null;
          return {
            matched: true,
            productName: heading,
            slug: match[1],
            publicUrl: `${location.origin}/products/${match[1]}`,
            evidence: compactText(draft, 240),
            publicationStatus: "submitted",
          };
        })();
        sendResponse({
          url: location.href,
          hostname: location.hostname,
          platform: platform || snapshot.meta.platform,
          operable,
          commentFound: hasComment,
          standardWpComment: inspectStandardWpCommentForm().ok,
          productHuntReceipt,
          playbook: playbook
            ? { id: playbook.id, title: playbook.title, notes: playbook.notes, hints: playbook.hints || [] }
            : null,
          formFieldCount: scopedFields.length,
          formCount: snapshot.meta.formCount,
          hasCaptcha: snapshot.meta.hasCaptcha,
          submitBlocker: submitBlocker ? {
            blocked: submitBlocker.blocked === true,
            needs_manual: submitBlocker.needs_manual === true,
            payment_uncertain: submitBlocker.payment_uncertain === true,
            reason: String(submitBlocker.reason || ""),
          } : null,
          inModal: !!getActiveFillScope()?.closest?.('dialog[open], [role="dialog"], [role="alertdialog"], .modal.show, .modal.in'),
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

  // The side panel can re-arm an already open tab after an extension reload.
  // Re-injecting this content script must replace the previous listener in
  // this frame, otherwise the old handler can answer fill/count requests first
  // and make the panel report a stale or empty form.
  if (typeof window.__extLinkMessageHandler === "function") {
    try {
      chrome.runtime.onMessage.removeListener(window.__extLinkMessageHandler);
    } catch {
      /* Older Chromium builds may not expose removeListener in test shims. */
    }
  }
  window.__extLinkMessageHandler = onExtensionMessage;
  chrome.runtime.onMessage.addListener(onExtensionMessage);

  // all_frames injects this script into a cross-origin Typeform iframe too.
  // Ask the background for the active tab watch so the frame can report its
  // own frameId and baseline without relying on a cross-origin broadcast.
  chrome.runtime.sendMessage({ action: "manualSubmissionWatchRequest" }).then((response) => {
    if (!response?.ok || !response.watch) return;
    onExtensionMessage({ action: "watchManualSubmission", ...response.watch }, null, () => {});
  }).catch(() => {});

  function maybeRequestAutoFill() {
    if (!chrome.runtime?.id) return null;
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
    pageContextVersion += 1;
    setTimeout(() => {
      if (!chrome.runtime?.id) return;
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

  window.__extLinkOnPageNavigation = onPageNavigation;
  if (!window.__extLinkBootstrapped) {
    window.__extLinkBootstrapped = true;
    onPageNavigation();
    setTimeout(() => {
      initManualIcons().catch(() => {});
    }, 800);

    const pushState = history.pushState;
    history.pushState = function (...args) {
      pushState.apply(this, args);
      window.__extLinkOnPageNavigation?.();
    };
    const replaceState = history.replaceState;
    history.replaceState = function (...args) {
      replaceState.apply(this, args);
      window.__extLinkOnPageNavigation?.();
    };
    window.addEventListener("popstate", () => window.__extLinkOnPageNavigation?.());
  }

  // ─── Main Execution ───
  async function executeSubmit(config, platformType, taskIndex) {
    try {
      if (isAiToolsDirectoryHost()) return aiToolsDirectoryManualGate();
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
    // Keep the generic fallback behind the same form-aware detectors. A
    // directory may use `name=comment` for product copy, which must not turn
    // the page into a blog-comment target.
    if (detectWPComment()) return "wp_comment";
    if (detectArticleComment()) return "article";
    if (detectSubmissionForm()) return "submission";
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
    // Generic profile pages need local page identity. Directory pages often
    // contain a website field and unrelated footer text such as "AI Image
    // Editing" or "Settings", neither of which identifies a profile editor.
    const profileContext = /(?:^|\/)(?:profile|account|settings|user|member|edit-profile|edit-account)(?:\/|$)/i.test(
      location.pathname || "",
    ) || Array.from(document.querySelectorAll("h1, h2, form legend")).some((heading) =>
      /^(?:edit|update|manage|my)?\s*(?:user\s+)?(?:profile|account)(?:\s+(?:settings|details))?$/i.test(
        String(heading.textContent || "").trim(),
      ));
    if (!profileContext) return false;
    return !!document.querySelector('input[name="url"], input[name="website"]');
  }

  function detectWPComment() {
    // Only WordPress's explicit form markers (including its comment widget
    // containers) select this route. Ordinary article forms use the article
    // detector below, even when their field is also named `comment`.
    return !!findVisibleWpCommentForm();
  }

  function fieldHasValue(element) {
    return !!String(element?.value || "").trim();
  }

  function inspectStandardWpCommentForm() {
    if (window.top !== window) {
      return { ok: false, reason: "iframe" };
    }
    const form = findVisibleWpCommentForm();
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

  function findVisibleWpCommentForm() {
    const candidates = [
      ...Array.from(document.querySelectorAll("#commentform, form.comment-form")),
      ...Array.from(document.querySelectorAll(".comment-respond, .wp-block-comments"))
        .map((container) => container.matches?.("form") ? container : container.querySelector?.("form"))
        .filter(Boolean),
    ];
    return candidates.find((form) => {
      if (!isVisibleHumanGate(form)) return false;
      const comment = form.querySelector?.(
        '#comment, textarea[name="comment"], textarea.comment, ' +
          'textarea[aria-label*="comment" i], textarea[placeholder*="comment" i]',
      );
      const submit = form.querySelector?.(
        '#submit, input[type="submit"][name="submit"], button[type="submit"], ' +
          'input.comment-submit, button.comment-submit, .form-submit input[type="submit"]',
      );
      return isVisibleHumanGate(comment) && isVisibleHumanGate(submit);
    }) || null;
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
    const submitContext = submitBtn
      ? getPaymentElementContext(submitBtn, "submit")
      : {
          label: "",
          fieldset: "",
          options: "",
          local: compactText(document.querySelector("form")?.innerText || "", 1200),
          actionType: "submit",
          choiceControl: false,
        };
    const submitClassification = classifyPaymentContext(submitContext);
    if (submitClassification.classification === "confirmed_payment") {
      return submitClassification;
    }

    // Keep this page-level check deliberately narrow. A directory may mention
    // that a product is paid, while the directory submission itself remains
    // free. The action and its local form scope must describe an actual charge.
    const text = String(document.body?.innerText || "").slice(0, 4000).toLowerCase();
    const hasFreeSubmit = /free (submit|listing|launch)|submit for free|no credit card/.test(text);
    const mandatoryCharge = /payment required to (?:submit|publish|list)|pay to (?:submit|publish|list)|every listing carries a fee|submitting takes you to (?:stripe )?checkout|charged on submission|credit card required/.test(text);
    const pagePaymentGate = mandatoryCharge ||
      (!hasFreeSubmit && /listing fee|submission fee|fee to (?:submit|publish|list)|checkout to continue/.test(text));
    if (pagePaymentGate) {
      return {
        classification: "confirmed_payment",
        type: "payment",
        reason: "页面要求付款后才能提交",
        evidence: {
          ...submitClassification.evidence,
          local: submitClassification.evidence?.local || compactText(text, 1200),
          matched: ["page_payment_gate"],
        },
      };
    }

    if (submitClassification.classification === "uncertain_payment") {
      return submitClassification;
    }
    return { classification: "safe", type: "safe", reason: "", evidence: submitClassification.evidence };
  }

  function isVisibleHumanGate(element) {
    if (!element) return false;
    if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return false;
    try {
      if (element.closest?.('[hidden], [aria-hidden="true"]')) return false;
    } catch {
      /* ignore malformed test/third-party nodes */
    }
    if (
      typeof window.getComputedStyle === "function" &&
      typeof element.getBoundingClientRect === "function"
    ) {
      return isVisible(element);
    }
    return true;
  }

  function findVisibleHumanGate(selector, scope = null) {
    return Array.from(document.querySelectorAll(selector)).find((element) => {
      if (!isVisibleHumanGate(element)) return false;
      if (!scope || scope === document) return true;
      return !!scope.contains?.(element);
    }) || null;
  }

  function isVerificationCodeField(element) {
    if (!element) return false;
    const hint = [
      element.name,
      element.id,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
      element.closest?.("label")?.textContent,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /captcha|h[\s-]?captcha|one[\s-]?time|\botp\b|verification|verify|security\s*code|confirmation\s*code|auth(?:entication)?\s*code|email\s*code|验证码|校验码|验证(?:码|代码)/i.test(hint);
  }

  function isLegalAcceptanceField(field) {
    if (!field) return false;
    const parent = field.parentElement;
    const parentText = parent && !/^(?:FORM|MAIN|BODY)$/.test(parent.tagName || "")
      ? compactText(parent.textContent, 260)
      : "";
    const hint = compactText([
      getSnapshotLabel(field), field.name, field.id,
      parentText.length < 240 ? parentText : "",
    ].filter(Boolean).join(" "), 320).toLowerCase();
    return LEGAL_POLICY_REFERENCE_PATTERN.test(hint) ||
      /\basset[_\s-]?permission\b|\b(?:permission|rights?|licen[cs]e)\b.{0,100}\b(?:share|use|reproduce|publish|assets?|logos?|screenshots?)\b|(?:授权|许可).{0,30}(?:使用|发布|图片|素材)/.test(hint);
  }

  function isHumanDeclarationField(field) {
    if (isLegalAcceptanceField(field)) return true;
    const hint = `${getSnapshotLabel(field)} ${field?.name || ""} ${field?.id || ""}`.toLowerCase();
    return /\b(?:i\s+(?:confirm|understand|acknowledge|agree|certify)|acknowledg(?:e|ement)|confirm(?:ation)?|declaration|guarantee|permission|rights?)\b/.test(hint);
  }

  function detectDirectoryLegalAgreement(scope) {
    // Read only the active form or its visible form area. A site's footer may
    // link to its policies without making the current submit action an assent.
    const root = scope === document
      ? document.querySelector("main, [role='main']") || document
      : scope;
    const assentAction = /\bby\s+(?:submitting|continuing|clicking|pressing|selecting)\b|\bupon\s+(?:submission|submitting|continuing)\b|\bwhen\s+you\s+(?:submit|continue)\b|点击.{0,12}(?:提交|继续)|提交(?:即|后|代表)|继续(?:即|后|代表)/;
    const assent = /\b(?:agree|accept|consent|acknowledge|bound\s+by|agreement|acceptance)\b|同意|接受|确认|视为/;

    const requiredLegalCheckbox = Array.from(root.querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
      .find((field) => {
        const visibleControl = isVisibleHumanGate(field) ||
          Array.from(field.labels || []).some(isVisibleHumanGate) ||
          isVisibleHumanGate(field.closest?.("label"));
        if (!visibleControl || field.disabled) return false;
        const required = field.required || field.getAttribute("aria-required") === "true";
        const checked = field.checked === true || field.getAttribute("aria-checked") === "true";
        if (!required || checked) return false;
        return isHumanDeclarationField(field);
      });
    if (requiredLegalCheckbox) {
      return "提交表单要求确认条款、素材权限或声明，需人工确认后再提交";
    }

    const legalNotice = Array.from(root.querySelectorAll('label, p, small, span, div, [role="note"]'))
      .find((element) => {
        if (!isVisibleHumanGate(element) || element.closest("footer, [role='contentinfo']")) return false;
        const text = compactText(
          typeof element.innerText === "string" ? element.innerText : element.textContent,
          420,
        ).toLowerCase();
        if (!text || text.length > 360 || !LEGAL_POLICY_REFERENCE_PATTERN.test(text) || !assentAction.test(text)) return false;
        return assent.test(text);
      });
    return legalNotice ? "当前表单声明提交或继续即表示同意法律条款，需人工确认" : "";
  }

  function detectSubmitBlockers() {
    if (typeof detectCaptcha === "function" && detectCaptcha()) return { captcha: true };
    let activeScope = document;
    try {
      activeScope = getActiveFillScope() || document;
    } catch {
      /* fall back to page scope when a framework exposes a partial DOM */
    }
    if (findVisibleHumanGate('input[type="password"]', activeScope)) {
      return { needs_manual: true, reason: "需要登录或注册" };
    }
    if (isAiToolsDirectoryHost()) {
      return {
        needs_manual: true,
        reason: AI_TOOLS_DIRECTORY_MANUAL_REASON,
      };
    }
    const paid = detectPaidSubmit();
    if (paid?.classification === "confirmed_payment") {
      return {
        blocked: true,
        reason: paid.reason || "当前提交动作需要付款",
        paymentClassification: paid.classification,
        paymentEvidence: paid.evidence,
      };
    }
    if (paid?.classification === "uncertain_payment") {
      return {
        payment_uncertain: true,
        needs_model: true,
        reason: paid.reason || "付款语义不明确，交给模型判断",
        paymentClassification: paid.classification,
        paymentEvidence: paid.evidence,
      };
    }
    const legalAgreement = detectDirectoryLegalAgreement(activeScope);
    if (legalAgreement) return { needs_manual: true, reason: legalAgreement };
    return null;
  }

  function detectSubmissionTransportFailure(sinceStartTime = 0) {
    const failedForm = document.querySelector('.wpcf7 form.failed, .wpcf7 form[data-status="failed"]');
    if (failedForm) {
      return String(failedForm.querySelector('.wpcf7-response-output')?.textContent || "")
        .replace(/\s+/g, " ").trim() || "站方表单发送失败";
    }
    if (/^(?:www\.)?iatool\.online$/i.test(location.hostname) && typeof performance !== "undefined") {
      const failedRequest = performance.getEntriesByType?.("resource")?.find((entry) => {
        try {
          return new URL(entry.name).pathname === "/api/submit-tool" &&
            entry.startTime >= sinceStartTime && Number(entry.responseStatus) >= 400;
        } catch {
          return false;
        }
      });
      if (failedRequest) return `Come AI 提交接口返回 HTTP ${failedRequest.responseStatus}`;
    }
    return "";
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

  function isStartupStashUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return false;
    try {
      const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname
        .replace(/^www\./, "")
        .toLowerCase();
      return host === "startupstash.com" || host.endsWith(".startupstash.com");
    } catch {
      return false;
    }
  }

  function normalizeReceiptText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function classifyVisibleEvidence(options = {}) {
    const text = `${document.title || ""} ${document.body?.innerText || ""}`.replace(/\s+/g, " ").trim();
    const destinationUrl = options.destinationUrl || manualSubmissionWatch?.destinationUrl || "";
    const sourceBoundTallyReceipt = (() => {
      try {
        const page = new URL(String(location.href || ""));
        const source = new URL(String(destinationUrl || ""));
        return page.hostname === "tally.so" && source.hostname !== "tally.so" &&
          /^\/(?:embed|r)\/[^/]+\/?$/i.test(page.pathname) &&
          /^Form submitted$/i.test(String(document.querySelector('[role="status"]')?.textContent || "").trim()) &&
          /^Thanks for completing this form!$/i.test(String(document.querySelector('h1')?.textContent || "").trim());
      } catch {
        return false;
      }
    })();
    if (sourceBoundTallyReceipt) {
      return {
        publicationStatus: "submitted",
        evidence: "Form submitted — Thanks for completing this form!",
        evidenceSignals: [{ type: "visible_confirmation", text: "Form submitted — Thanks for completing this form!", url: String(location.href || ""), matched: true }],
        matched: true,
      };
    }
    // Google Forms shows this confirmation link only after a completed
    // response. Wording elsewhere on the form is not submission evidence.
    const googleFormReceipt = (() => {
      try {
        const page = new URL(String(location.href || ""));
        const source = new URL(String(destinationUrl || ""));
        return page.hostname === "docs.google.com" && source.hostname !== "docs.google.com" &&
          /^\/forms\/(?:u\/\d+\/)?d\/e\/[^/]+\/(?:viewform|formResponse)$/i.test(page.pathname) &&
          Boolean(document.querySelector('a[href*="usp=form_confirm"]'));
      } catch {
        return false;
      }
    })();
    if (googleFormReceipt && /您的回复已记录。?|Your response has been recorded\.?/i.test(text)) {
      const evidence = /您的回复已记录/.test(text) ? "您的回复已记录。" : "Your response has been recorded.";
      return {
        publicationStatus: "submitted",
        evidence,
        evidenceSignals: [{ type: "visible_confirmation", text: evidence, url: String(location.href || ""), matched: true }],
        matched: true,
      };
    }
    // AI Marketing Directory's embedded Tally form replaces the fields with
    // this status after a real submit. Scope the signal to its known form so
    // an unrelated page containing the same words cannot create a record.
    const tallyForm = (() => {
      try {
        const page = new URL(String(location.href || ""));
        return page.hostname === "tally.so" && /^\/(?:embed|r)\/nG1V7j\/?$/i.test(page.pathname);
      } catch {
        return false;
      }
    })();
    if (tallyForm && /\bForm submitted\b/i.test(text) && /\bPage 2 of 2\b|guaranteed spot on our directory/i.test(text)) {
      return {
        publicationStatus: "submitted",
        evidence: "Form submitted",
        evidenceSignals: [{ type: "visible_confirmation", text: "Form submitted", url: String(location.href || ""), matched: true }],
        matched: true,
      };
    }
    // This known Typeform asks for contact information with a pre-submit
    // sentence about being in touch. Only its final thank-you page is proof.
    const aiToolsIncForm = (() => {
      try {
        const page = new URL(String(location.href || ""));
        return page.hostname.endsWith(".typeform.com") && /^\/to\/RB6ZnEf2\/?$/i.test(page.pathname) &&
          /\/\/aitools\.inc(?:\/|$)/i.test(destinationUrl);
      } catch {
        return false;
      }
    })();
    if (aiToolsIncForm && /\bThanks!\s*We['’]ll be in touch over the next few days to proceed with your listing\.?/i.test(text)) {
      return {
        publicationStatus: "submitted",
        playbookId: "aitools-inc",
        evidence: "Thanks! We'll be in touch over the next few days to proceed with your listing.",
        evidenceSignals: [{ type: "visible_confirmation", text: "Thanks! We'll be in touch over the next few days to proceed with your listing.", url: String(location.href || ""), matched: true }],
        matched: true,
      };
    }
    const startupStashContext = isStartupStashUrl(destinationUrl) ||
      isStartupStashUrl(location.href) ||
      isStartupStashUrl(document.referrer || "");
    if (startupStashContext) {
      const normalized = normalizeReceiptText(text);
      if (normalized.includes(normalizeReceiptText(STARTUP_STASH_RECEIPT))) {
        return {
          publicationStatus: "submitted",
          evidence: STARTUP_STASH_RECEIPT,
          evidenceSignals: [{
            type: "visible_confirmation",
            text: STARTUP_STASH_RECEIPT,
            url: String(location.href || ""),
            matched: true,
          }],
          matched: true,
        };
      }
      // StartupStash contains promotional copy and a Typeform ad step. Its
      // generic "thank you" wording must not count as a submission receipt.
      return { publicationStatus: "submitted", evidence: "", matched: false };
    }
    const playbook =
      self.ExtLinkPlaybooks && typeof self.ExtLinkPlaybooks.lookup === "function"
        ? self.ExtLinkPlaybooks.lookup(destinationUrl || location.href) || self.ExtLinkPlaybooks.lookup(location.href)
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

  function inspectAutoFillGuard(targetDomain = "") {
    if (isAiToolsDirectoryHost()) {
      return { blocked: true, ...aiToolsDirectoryManualGate() };
    }
    const evidence = classifyVisibleEvidence({ destinationUrl: location.href });
    if (evidence?.matched && evidence.evidence) {
      return {
        blocked: true,
        reason: "当前页面已有可核验提交回执，已停止覆盖页面",
        evidence: evidence.evidence,
      };
    }
    let expectedHost = "";
    try {
      expectedHost = new URL(String(targetDomain || "").trim()).hostname
        .replace(/^www\./i, "")
        .toLowerCase();
    } catch {
      /* A profile without a product URL cannot provide an identity guard. */
    }
    if (!expectedHost) return { blocked: false, foreignUrls: [] };
    const foreignUrls = [];
    for (const element of queryFillableElements()) {
      const value = String(getElementFillValue(element) || "").trim();
      if (!/^https?:\/\//i.test(value)) continue;
      try {
        const host = new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
        if (host && host !== expectedHost && !host.endsWith(`.${expectedHost}`)) foreignUrls.push(value);
      } catch {
        /* Ignore non-URL field values. */
      }
    }
    if (foreignUrls.length) {
      return {
        blocked: true,
        reason: "当前页面已有其他 Profile 的产品链接，已停止覆盖页面",
        foreignUrls: [...new Set(foreignUrls)].slice(0, 4),
      };
    }
    return { blocked: false, foreignUrls: [] };
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

  function articleCommentField(form) {
    if (!form?.querySelector) return null;
    // Prefer an explicit comment/reply field over a generic body/message
    // editor. Directory forms sometimes render a description textarea first.
    for (const selector of [
      'textarea[name*="comment" i], textarea[id*="comment" i]',
      'textarea[name*="reply" i], textarea[id*="reply" i]',
      'textarea[name*="message" i], textarea[id*="message" i], ' +
        'textarea[name*="body" i], textarea[id*="body" i], ' +
        '[contenteditable="true"], [role="textbox"][contenteditable]',
    ]) {
      const field = form.querySelector(selector);
      if (field) return field;
    }
    return null;
  }

  function articleCommentSubmit(form) {
    return form?.querySelector?.('button[type="submit"], input[type="submit"]');
  }

  function isArticleCommentForm(form) {
    if (!form) return false;
    const commentField = articleCommentField(form);
    const submit = articleCommentSubmit(form);
    if (
      !isVisibleHumanGate(form) ||
      !commentField ||
      !submit ||
      !isVisibleHumanGate(commentField) ||
      !isVisibleHumanGate(submit)
    ) return false;

    // A plain `form[action*=post]` is common on directory/listing forms. It is
    // a comment form only when the form itself, its action, or its local copy
    // explicitly identifies a comment/reply interaction.
    const action = String(form.getAttribute?.("action") || "").toLowerCase();
    const identity = [
      form.id,
      form.className,
      form.getAttribute?.("name"),
      form.getAttribute?.("aria-label"),
      form.getAttribute?.("data-testid"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const localText = compactText(
      [
        form.innerText || form.textContent || "",
        ...Array.from(form.querySelectorAll?.("button, input[type=submit], label") || []).map(
          (element) => element.innerText || element.textContent || element.value || "",
        ),
      ].join(" "),
      1200,
    ).toLowerCase();
    const commentContextPattern = /(?:^|[^a-z])(comments?|repl(?:y|ies))(?=$|[^a-z])|留言|评论|回复/;
    const actionSignal = commentContextPattern.test(action);
    const identitySignal = commentContextPattern.test(identity);
    const textSignal = commentContextPattern.test(localText);
    if (!actionSignal && !identitySignal && !textSignal) return false;

    // When a generic POST form also has listing fields, a message/body
    // textarea is product copy. Do not let that form become a comment target
    // unless the form/action has an explicit comment identity.
    const listingField = form.querySelector?.(
      'input[type="url"], input[name*="url" i], input[name*="website" i], ' +
        'input[name*="product" i], input[name*="title" i], input[id*="product" i], input[id*="title" i], ' +
        'textarea[name*="description" i], textarea[id*="description" i], textarea[name*="summary" i], textarea[id*="summary" i]',
    );
    if (listingField && !actionSignal && !identitySignal) return false;
    return true;
  }

  function isArticleCommentField(element) {
    const form = element?.closest?.("form");
    if (!form || form.contains?.(element) === false || !isArticleCommentForm(form)) return false;
    if (articleCommentField(form) === element) return true;
    const hint = [
      element.name,
      element.id,
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("placeholder"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return /(?:^|[^a-z])(comments?|repl(?:y|ies))(?=$|[^a-z])|留言|评论|回复/.test(hint);
  }

  function detectArticleComment() {
    // Article/blog comment forms (non-WP). Inspect every form so a plain
    // `/post` action can still work when its local heading says "Leave a
    // comment", while generic directory POST forms fail the context check.
    return Array.from(document.querySelectorAll("form")).some((form) => {
      const commentField = articleCommentField(form);
      const submit = articleCommentSubmit(form);
      return !!(commentField && submit && isArticleCommentForm(form));
    });
  }

  function findVisibleArticleCommentForm() {
    return Array.from(document.querySelectorAll("form")).find((form) => isArticleCommentForm(form)) || null;
  }

  function detectSubmissionForm() {
    return Array.from(document.querySelectorAll("form")).some((form) => {
      if (isMarketingOptInForm(form)) return false;
      return hasLikelySubmissionFields(form);
    });
  }

  function hasLikelySubmissionFields(scope = document) {
    if (!scope?.querySelector) return false;
    if (hasLikelyListingFields(scope)) return true;
    return !!scope.querySelector(
      'textarea[name*="message" i], textarea[id*="message" i], ' +
        'textarea[aria-label*="message" i], textarea[placeholder*="message" i]',
    );
  }

  function hasLikelyListingFields(scope) {
    if (!scope?.querySelector) return false;
    return !!scope.querySelector(
      'input[type="url"], input[name*="url" i], input[id*="url" i], ' +
        'input[name*="website" i], input[id*="website" i], input[name*="link" i], input[id*="link" i], ' +
        'input[name*="product" i], input[id*="product" i], input[name*="title" i], input[id*="title" i], ' +
        'input[aria-label*="url" i], input[aria-label*="website" i], input[placeholder*="https"], ' +
        'input[placeholder*="url" i], input[placeholder*="website" i], ' +
        'textarea[name*="description" i], textarea[id*="description" i], textarea[name*="summary" i], ' +
        'textarea[id*="summary" i]',
    );
  }

  function isMarketingOptInForm(form) {
    if (!form?.querySelectorAll) return false;
    const fields = Array.from(
      form.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select',
      ),
    );
    const hasEmail = fields.some((field) => String(field.type || "").toLowerCase() === "email");
    if (!hasEmail || hasLikelyListingFields(form)) return false;

    const context = compactText(
      [
        form.id,
        form.className,
        form.getAttribute?.("name"),
        form.getAttribute?.("aria-label"),
        form.getAttribute?.("action"),
        form.innerText,
        form.textContent,
        ...Array.from(form.querySelectorAll("button, input[type='submit']")).map(
          (button) => button.innerText || button.textContent || button.value || "",
        ),
      ]
        .filter(Boolean)
        .join(" "),
      1200,
    );
    return /newsletter|subscribe|mailing\s+list|join\s+[\d,]+\s+(?:readers|subscribers)|free\s+(?:ai\s+)?database|briefing/i.test(
      context,
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
        pf["Product Hunt First Comment"],
        config.firstComment,
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
        element.getAttribute?.("data-test"),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  function productHuntVisibleText(scope) {
    const requested = scope || document;
    const root = requested === document ? document.body : requested;
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

  function productHuntMakerIdentityMatches(candidate = {}, expected) {
    const wanted = normalizeProductHuntText(expected).replace(/^@/, "");
    if (!wanted) return false;
    const dataTest = normalizeProductHuntText(candidate.dataTest || "")
      .replace(/^maker-/, "")
      .replace(/^@/, "");
    if (dataTest === wanted) return true;
    const text = normalizeProductHuntText(candidate.text || "");
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\s)@?${escaped}(?:$|\\s)`, "i").test(text);
  }

  function productHuntHasExistingMaker(scope, expected) {
    return productHuntQueryVisible(scope, '[data-test^="maker-" i]').some((element) =>
      productHuntMakerIdentityMatches(
        {
          dataTest: element.getAttribute?.("data-test"),
          text: element.innerText || element.textContent,
        },
        expected,
      ),
    );
  }

  function productHuntChoiceControls(scope, pattern) {
    const wanted = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    return productHuntQueryVisible(
      scope,
      'input[type="checkbox"], input[type="radio"], input[name="topics" i], input[id="topics" i], input[data-test*="maker" i], select, [role="combobox"], [aria-haspopup="listbox"]',
    ).filter((element) => wanted.test(productHuntFieldHint(element)) || wanted.test(productHuntChoiceLabel(element)));
  }

  function productHuntSelectedLabels(scope, pattern) {
    const wanted = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
    const selected = productHuntQueryVisible(
      scope,
      'input[type="checkbox"], input[type="radio"], option:checked, [aria-checked="true"], [aria-selected="true"], [data-state="checked"], [data-selected="true"], [data-test^="maker-" i]',
    );
    return selected
      .map((element) => productHuntChoiceLabel(element))
      .filter((label) => wanted.test(label));
  }

  function productHuntSelectionConfirmed(scope, pattern, expected) {
    const wanted = String(expected || "").trim();
    if (!wanted) return false;
    if (productHuntHasExistingMaker(scope, wanted)) return true;
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
          control.matches?.('input[name="topics" i], input[id="topics" i], input[data-test*="maker" i], [role="combobox"]') &&
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
    const semanticMakerInput = productHuntRawControls(scope, 'input[type="radio"], input[type="checkbox"]')
      .find((input) => /i worked on this product|i am (?:a|the) maker|i made this product/i.test(
        normalizeProductHuntText(productHuntChoiceLabel(input)),
      ));
    const hiddenIsMaker = isMakerInputs.find((input) => /^(?:true|yes|1|on)$/i.test(String(input.value || "").trim())) ||
      isMakerInputs[0] || semanticMakerInput;
    const soloMakerInputs = productHuntRawControls(scope, 'input[name="soloMaker"], input[name="solo_maker"]');
    const hiddenSoloMaker = soloMakerInputs.find((input) => /^(?:true|yes|1|on)$/i.test(String(input.value || "").trim())) || soloMakerInputs[0];
    if ((values.makerHandle || values.soloMaker) && hiddenIsMaker && !productHuntBooleanControlChecked(hiddenIsMaker)) {
      productHuntClickAssociatedLabel(hiddenIsMaker);
    }

    let makerResult = { ok: !values.makerHandle, selected: [] };
    if (values.makerHandle) {
      const makerPattern = /maker|founder|creator|who.*mak/;
      // Product Hunt keeps already-added makers in a data-test chip without
      // aria-selected/checked state. Treat that visible identity as selected
      // before typing into the search box, otherwise every retry re-enters the
      // same handle and the workflow never reaches Company info.
      if (productHuntSelectionConfirmed(scope, makerPattern, values.makerHandle)) {
        makerResult = {
          ok: true,
          selected: [values.makerHandle],
          selectedAfter: productHuntSelectedLabels(scope, makerPattern),
          missing: [],
        };
      } else {
        await waitForProductHuntMakerControls(scope);
        makerResult = await productHuntSelectExact(scope, makerPattern, [values.makerHandle], {
          requireExact: true,
        });
      }
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
    const rect = button.getBoundingClientRect();
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
      advancePoint: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      },
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
      const createRect = createButton.getBoundingClientRect();
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
        createPoint: {
          x: Math.round(createRect.left + createRect.width / 2),
          y: Math.round(createRect.top + createRect.height / 2),
        },
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
    makerIdentityMatches: productHuntMakerIdentityMatches,
    classifyResult: classifyProductHuntResult,
  };
  self.__extLinkProductHuntTestHooks = self.__extLinkProductHunt;
  self.__extLinkPaymentTestHooks = {
    classifyPaymentContext,
    getPaymentElementContext,
    detectPaidSubmit,
  };
  self.__extLinkFieldMappingTestHooks = {
    sharedLearnedMappingMatches,
    resolveSharedLearnedProfileValue,
    normalizeLearnedFieldText,
  };
  self.__extLinkFieldRoutingTestHooks = {
    resolveValueForField,
    getFieldConstraints,
    fitValueToConstraints,
    modelFillGuard,
    shouldClearStaleProtectedValue,
    shouldReplaceExistingProfileEmail,
  };
  self.__extLinkCommentTestHooks = {
    detectArticleComment,
    isArticleCommentForm,
    isArticleCommentField,
  };
  self.__extLinkSubmissionTestHooks = {
    identifyPlatform,
    detectDirectory,
    detectSubmissionForm,
    hasLikelySubmissionFields,
    hasLikelyListingFields,
    isMarketingOptInForm,
    queryFillableElements,
    classifyVisibleEvidence,
    inspectAutoFillGuard,
  };
  self.__extLinkContentAuditTestHooks = {
    detectWPComment,
    identifyPlatform,
    detectSubmitBlockers,
    detectSubmissionTransportFailure,
    isLegalAcceptanceField,
    isCommentLikeField,
    submitArticleComment,
    submitWPComment,
    submitFilledForm,
    requestCommentDrafts,
    capturePageContext,
    isCurrentPageContext,
  };

  async function submitFilledForm(config, platform = "directory", fillResult = {}) {
    const pageContext = capturePageContext();
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
    if (blocker?.payment_uncertain) {
      logStep(`🧠 ${blocker.reason} — 保留局部证据，交给模型判断`);
      return {
        needs_manual: true,
        needs_model: true,
        payment_uncertain: true,
        semanticReview: true,
        paymentClassification: blocker.paymentClassification || "uncertain_payment",
        paymentEvidence: blocker.paymentEvidence || null,
        reason: blocker.reason,
        keepTab: true,
        platform,
        ...fillResult,
      };
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
    const beforeStage = formStageSignature();
    const submitStartedAt = performance.now();
    if (!isCurrentPageContext(pageContext)) return stalePageResult(platform, fillResult);
    let classified;
    pluginSubmitInProgress = true;
    try {
      submitBtn.click();
      classified = await waitForSubmissionEvidence(beforeUrl, beforeEvidence);
    } finally {
      pluginSubmitInProgress = false;
    }
    const urlChanged = location.href !== beforeUrl;
    const transportFailure = detectSubmissionTransportFailure(submitStartedAt);
    if (transportFailure) {
      return {
        needs_manual: true,
        semanticReview: true,
        reason: `站方表单发送失败：${transportFailure}`,
        clickedSubmit: true,
        submitted: false,
        keepTab: true,
        advance: false,
        platform,
        ...fillResult,
      };
    }
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

    // Some multi-step forms reuse the same URL and use a submit-styled button
    // to replace the current form with the next stage. A changed form
    // signature without success evidence is progress, not an unconfirmed final
    // submission; let the background loop fill and validate the new stage.
    const afterStage = formStageSignature();
    if (afterStage && beforeStage && afterStage !== beforeStage) {
      return {
        ok: true,
        platform,
        stageAdvanced: true,
        submitted: false,
        matched: false,
        clickedSubmit: true,
        ...fillResult,
      };
    }

    return {
      ok: false,
      needs_manual: true,
      keepTab: true,
      reason: "已点击提交，但未发现新的成功回执，请人工确认",
      platform,
      clickedSubmit: true,
      submitted: false,
      beforeStage,
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
    const pageContext = capturePageContext();
    logStep("🔍 检测到 WordPress 评论表单");
    const commentForm = findVisibleWpCommentForm();
    if (!commentForm) {
      return { manual: true, platform: "wp_comment", reason: "no_visible_comment_form" };
    }
    const findField = (selector) => commentForm.querySelector?.(selector);
    // Step 1: Fill author name
    const authorField = findField(
      '#author, input[name="author"], input[name*="author"], ' +
        'input[aria-label*="Name"], input[placeholder*="name" i], input[placeholder*="Name"]',
    );
    if (authorField) {
      logStep(`✏️ 填写作者名 → ${config.username}`);
      await simulateTyping(authorField, config.username);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("wp_comment");
    }

    // Step 2: Fill email
    const emailField = findField(
      '#email, input[name="email"], input[type="email"], ' +
        'input[aria-label*="Email"], input[placeholder*="email" i], input[placeholder*="Email"]',
    );
    if (emailField) {
      logStep(`✏️ 填写邮箱 → ${config.email}`);
      await simulateTyping(emailField, config.email);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("wp_comment");
    }

    // Step 3: Fill URL (link goes HERE, not in body - Akismet bypass)
    const urlField = findField(
      '#url, input[name="url"], input[name="website"], ' +
        'input[aria-label*="Website"], input[placeholder*="website" i]',
    );
    if (urlField) {
      logStep(`✏️ 填写外链 → ${config.targetDomain}`);
      await simulateTyping(urlField, config.targetDomain);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("wp_comment");
    }

    // Step 4: Generate comment text (link stays in the URL field above, not the body)
    const commentField = findField(
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
      if (!isCurrentPageContext(pageContext)) return stalePageResult("wp_comment");
      await simulateTyping(commentField, commentText);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("wp_comment");
    }

    // Step 5: Check for captcha before submitting
    if (!isCurrentPageContext(pageContext)) return stalePageResult("wp_comment");
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
      commentForm.querySelector?.(
        '#submit, input[type="submit"][name="submit"], button[type="submit"], input.comment-submit, button.comment-submit, .form-submit input[type="submit"]',
      );
    if (submitBtn) {
      if (isFillOnly(config)) {
        return { ...returnAfterFill(config, "wp_comment"), standardWp: preflight.ok };
      }
      logStep(canAutoSubmit ? "🚀 标准评论表单预检通过，代点提交…" : "🚀 提交评论…");
      const beforeUrl = location.href;
      const beforeEvidence = classifyVisibleEvidence();
      if (!isCurrentPageContext(pageContext)) return stalePageResult("wp_comment");
      submitBtn.click();
      const classified = await waitForSubmissionEvidence(beforeUrl, beforeEvidence);
      const matched = classified?.matched === true && Boolean(classified?.evidence);
      if (!matched) {
        return {
          ok: false,
          needs_manual: true,
          keepTab: true,
          reason: "已点击评论提交，但未发现新的成功回执，请人工确认",
          platform: "wp_comment",
          clickedSubmit: true,
          submitted: false,
          standardWp: preflight.ok,
          publicationStatus: classified?.publicationStatus || "submitted",
          evidence: classified?.evidence || "",
          matched: false,
        };
      }
      return {
        ok: true,
        platform: "wp_comment",
        clickedSubmit: true,
        submitted: true,
        standardWp: preflight.ok,
        publicationStatus: classified.publicationStatus || "submitted",
        evidence: classified.evidence || "",
        matched: true,
      };
    }
    if (isFillOnly(config)) {
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
    if (result?.needs_manual) return result;
    if (result?.stale) return result;
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
    const pageContext = capturePageContext();
    logStep("🔍 检测到文章评论表单");
    const commentForm = findVisibleArticleCommentForm();
    if (!commentForm) {
      return { manual: true, platform: "article", reason: "no_visible_comment_form" };
    }
    const findField = (selector) => commentForm.querySelector?.(selector);
    // Similar to WP but with generic selectors
    const nameField = findField(
      'input[name="author"], input[name="name"], ' +
        'input[placeholder*="name" i], input[placeholder*="Name"]',
    );
    if (nameField) {
      logStep(`✏️ 填写名称 → ${config.username}`);
      await simulateTyping(nameField, config.username);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("article");
    }

    const emailField = findField(
      'input[name="email"], input[type="email"], ' +
        'input[placeholder*="email" i], input[placeholder*="Email"]',
    );
    if (emailField) {
      logStep(`✏️ 填写邮箱 → ${config.email}`);
      await simulateTyping(emailField, config.email);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("article");
    }

    const urlField = findField(
      'input[name="url"], input[name="website"], ' +
        'input[placeholder*="website" i], input[placeholder*="URL"]',
    );
    if (urlField) {
      logStep(`✏️ 填写外链 → ${config.targetDomain}`);
      await simulateTyping(urlField, config.targetDomain);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("article");
    }

    const commentField = findField(
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
      if (!isCurrentPageContext(pageContext)) return stalePageResult("article");
      await simulateTyping(commentField, commentText);
      if (!isCurrentPageContext(pageContext)) return stalePageResult("article");
    }

    if (!isCurrentPageContext(pageContext)) return stalePageResult("article");
    if (detectCaptcha()) {
      logStep("🤖 检测到验证码 — 请手动完成");
      highlightCaptchaArea();
      return { captcha: true };
    }

    const submitBtn = commentForm.querySelector?.('input[type="submit"], button[type="submit"]');
    if (submitBtn) {
      if (isFillOnly(config)) return returnAfterFill(config, "article");
      logStep("🚀 提交评论…");
      const beforeUrl = location.href;
      const beforeEvidence = classifyVisibleEvidence();
      if (!isCurrentPageContext(pageContext)) return stalePageResult("article");
      submitBtn.click();
      const classified = await waitForSubmissionEvidence(beforeUrl, beforeEvidence);
      const matched = classified?.matched === true && Boolean(classified?.evidence);
      if (!matched) {
        return {
          ok: false,
          needs_manual: true,
          keepTab: true,
          reason: "已点击评论提交，但未发现新的成功回执，请人工确认",
          platform: "article",
          clickedSubmit: true,
          submitted: false,
          publicationStatus: classified?.publicationStatus || "submitted",
          evidence: classified?.evidence || "",
          matched: false,
        };
      }
      return {
        ok: true,
        platform: "article",
        clickedSubmit: true,
        submitted: true,
        publicationStatus: classified.publicationStatus || "submitted",
        evidence: classified.evidence,
        matched: true,
      };
    } else {
      if (isFillOnly(config)) return returnAfterFill(config, "article");
      logStep("⚠️ 未找到评论提交按钮，已填字段请手动提交");
      return { manual: true, platform: "article", reason: "no_submit_button" };
    }

    return { ok: false, platform: "article", submitted: false };
  }

  // ─── Generic Form Submission ───
  async function submitGenericForm(config) {
    if (isAiToolsDirectoryHost()) return aiToolsDirectoryManualGate();
    const pageContext = capturePageContext();
    logStep("🔍 检测到通用提交表单");
    let filledCount = 0;
    const staleResult = () => stalePageResult("generic", { filledCount });
    // Fill all visible text inputs with relevant data
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="url"], input[type="email"], input:not([type])',
    );
    for (const input of inputs) {
      if (!isCurrentPageContext(pageContext)) return staleResult();
      if (!isFillableField(input)) continue;
      const name = getFieldHint(input);
      if (name.includes("url") || name.includes("website") || name.includes("link")) {
        await simulateTyping(input, config.targetDomain);
        if (!isCurrentPageContext(pageContext)) return staleResult();
        filledCount++;
      } else if (name.includes("name") || name.includes("author")) {
        await simulateTyping(input, config.username);
        if (!isCurrentPageContext(pageContext)) return staleResult();
        filledCount++;
      } else if (name.includes("email")) {
        await simulateTyping(input, config.email);
        if (!isCurrentPageContext(pageContext)) return staleResult();
        filledCount++;
      } else if (name.includes("title") || name.includes("subject")) {
        await simulateTyping(input, config.brandName);
        if (!isCurrentPageContext(pageContext)) return staleResult();
        filledCount++;
      } else if (input.type === "url") {
        await simulateTyping(input, config.targetDomain);
        if (!isCurrentPageContext(pageContext)) return staleResult();
        filledCount++;
      } else if (input.type === "email") {
        await simulateTyping(input, config.email);
        if (!isCurrentPageContext(pageContext)) return staleResult();
        filledCount++;
      }
    }

    const textareas = document.querySelectorAll("textarea");
    for (const ta of textareas) {
      if (!isCurrentPageContext(pageContext)) return staleResult();
      if (!isFillableField(ta)) continue;
      const name = getFieldHint(ta);
      const isRealCommentField = isArticleCommentField(ta);
      const isDescriptionField =
        name.includes("desc") ||
        name.includes("summary") ||
        (/message|body|content|about|details/.test(name) &&
          !!ta.closest?.("form")?.querySelector?.(
            'input[type="url"], input[name*="url" i], input[name*="website" i], ' +
              'input[name*="product" i], input[name*="title" i], textarea[name*="description" i], textarea[name*="summary" i]',
          ));
      if (isRealCommentField) {
        const commentText = await generateComment(config, {
          maxChars: getCommentCharBudget(ta),
        });
        if (commentText) {
          if (!isCurrentPageContext(pageContext)) return staleResult();
          await simulateTyping(ta, commentText);
          if (!isCurrentPageContext(pageContext)) return staleResult();
          filledCount++;
        }
      } else if (isDescriptionField) {
        if (!isCurrentPageContext(pageContext)) return staleResult();
        await simulateTyping(ta, config.commentTemplate || generateDescription(config));
        if (!isCurrentPageContext(pageContext)) return staleResult();
        filledCount++;
      }
    }

    if (!isCurrentPageContext(pageContext)) return staleResult();

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
    if (isAiToolsDirectoryHost()) return aiToolsDirectoryManualGate();
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
    if (element.matches("label[for], [onclick], [tabindex]:not([tabindex='-1'])")) return true;
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

  function isLikelyCustomClickTarget(element) {
    if (!element || !element.matches || !element.matches("div, span, li, section, label")) return false;
    if (!isRelevantSnapshotElement(element)) return false;
    const wrapsChoice = element.matches("label") &&
      !!element.querySelector('input[type="radio"], input[type="checkbox"]');
    if (getComputedStyle(element).cursor !== "pointer" && !wrapsChoice) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 18 || rect.height < 18 || rect.width > window.innerWidth * 0.98) return false;
    const label = compactText(getSnapshotLabel(element), 180);
    if (!label || label.length > 180) return false;
    return !Array.from(element.children || []).some((child) => (
      child.matches?.("div, span, li, section, label") &&
      isVisible(child) &&
      getComputedStyle(child).cursor === "pointer" &&
      compactText(getSnapshotLabel(child), 180) === label
    ));
  }

  function isInVisualViewport(element) {
    if (!isRelevantSnapshotElement(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function collectVisualSnapshotCandidates() {
    const nativeCandidates = Array.from(document.querySelectorAll(
      'input, textarea, select, button, label[for], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [role="button"], [role="combobox"], [role="textbox"], [role="checkbox"], [role="radio"], [role="option"], [role="tab"], [role="menuitem"], [role="link"], [role="switch"], [aria-haspopup="listbox"], .ProseMirror, .ql-editor, a[href]',
    )).filter(isRelevantSnapshotElement);
    const seen = new Set(nativeCandidates);
    const customCandidates = Array.from(document.querySelectorAll("div, span, li, section, label"))
      .slice(0, 4000)
      .filter((element) => !seen.has(element) && isLikelyCustomClickTarget(element))
      .slice(0, 40);
    customCandidates.forEach((element, index) => {
      if (!element.hasAttribute(SNAPSHOT_SELECTOR_ATTR)) {
        element.setAttribute(SNAPSHOT_SELECTOR_ATTR, `${SNAPSHOT_SELECTOR_PREFIX}-custom-${index + 1}`);
      }
    });
    // Framework cards are the reason the visual supervisor was invoked. Keep
    // them ahead of ordinary links, and discard offscreen footer/navigation
    // controls before applying the screenshot budget.
    return [...customCandidates, ...nativeCandidates]
      .filter(isInVisualViewport)
      .slice(0, 80);
  }

  function prepareVisualSnapshot() {
    clearVisualSnapshot();
    assignStableSelectors();
    const candidates = collectVisualSnapshotCandidates();
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
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    });
    return { ok: true, elements, viewport: { width: window.innerWidth, height: window.innerHeight, scrollX, scrollY } };
  }

  async function executeActionPlan(actions) {
    if (isAiToolsDirectoryHost()) {
      return { ...aiToolsDirectoryManualGate(), results: [] };
    }
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
        if (!result.ok || result.needs_manual || result.navigationExpected || result.submitted) break;
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
        const raw = action.value == null ? "" : String(action.value);
        const guardReason = modelFillGuard(element, raw);
        if (guardReason) {
          return {
            ok: true,
            selector: action.selector,
            skipped: true,
            reason: guardReason,
          };
        }
        element.focus();
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
          return actionFailure(action, "action target is not clickable");
        const gate = classifyModelClickGate(element);
        if (gate) {
          return {
            ...actionFailure(action, gate.reason),
            needs_manual: true,
            humanGate: gate.type,
            uncertain: gate.uncertain === true,
            semanticReview: gate.uncertain === true,
            paymentClassification: gate.paymentClassification || "",
            paymentEvidence: gate.paymentEvidence || null,
          };
        }

        const label = compactText(getElementLabel(element), 240);
        const beforeEvidence = classifyVisibleEvidence();
        const beforeUrl = redactSnapshotUrl(location.href);
        const submitted = isModelSubmissionControl(element, label);
        element.scrollIntoView({ block: "center", inline: "center" });
        await sleep(80);

        const tag = element.tagName.toLowerCase();
        const href = tag === "a" ? element.href || element.getAttribute("href") || "" : "";
        if (href && /^https?:/i.test(href)) {
          location.assign(href);
        } else {
          element.focus();
          element.click();
        }
        return {
          ok: true,
          selector: action.selector,
          clicked: true,
          submitted,
          navigationExpected: submitted || Boolean(href) || isLikelyNavigationControl(label),
          beforeUrl,
          evidenceBaseline: beforeEvidence?.matched ? beforeEvidence.evidence || "" : "",
          target: label,
        };
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
        if (isLegalAcceptanceField(element)) {
          return {
            ...actionFailure(action, "法律条款勾选需要人工确认"),
            needs_manual: true,
            humanGate: "legal",
          };
        }
        setCheckedValue(element, action.value !== false && action.checked !== false);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, selector: action.selector };
      }
      case "submit": {
        return actionFailure(action, "AI action plans cannot submit; deterministic preflight owns submission");
      }
      case "scroll": {
        const requested = Number(action.delta_y ?? action.deltaY ?? action.value ?? 0);
        const deltaY = Number.isFinite(requested)
          ? Math.max(-Math.max(window.innerHeight, 900), Math.min(requested, Math.max(window.innerHeight, 900)))
          : Math.round(window.innerHeight * 0.75);
        window.scrollBy({ top: deltaY, left: 0, behavior: "auto" });
        await sleep(180);
        return { ok: true, scrolled: true, deltaY };
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
    if (action.selector) {
      try {
        return document.querySelector(action.selector);
      } catch (e) {
        return null;
      }
    }
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const pointed = document.elementFromPoint(
      Math.max(0, Math.min(x, window.innerWidth - 1)),
      Math.max(0, Math.min(y, window.innerHeight - 1)),
    );
    return pointed?.closest?.(
      'button, a[href], input, select, textarea, label[for], [onclick], [role="button"], [role="link"], [role="option"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [tabindex]:not([tabindex="-1"])',
    ) || pointed;
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
    if (!element.hasAttribute(SNAPSHOT_SELECTOR_ATTR) && actionType !== "click") return false;
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
    if (actionType === "click") {
      const role = (element.getAttribute("role") || "").toLowerCase();
      const inputType = (element.getAttribute("type") || "").toLowerCase();
      return (
        ["button", "a", "summary", "option"].includes(tag) ||
        element.matches("label[for], [onclick], [tabindex]:not([tabindex='-1'])") ||
        (tag === "input" && ["button", "submit", "reset", "checkbox", "radio"].includes(inputType)) ||
        ["button", "link", "option", "tab", "menuitem", "checkbox", "radio", "switch"].includes(role) ||
        element.getAttribute("aria-haspopup") === "listbox"
      );
    }

    return false;
  }

  function normalizePaymentContextText(value, limit = 800) {
    return compactText(value, limit)
      .toLowerCase()
      .replace(/[\u2013\u2014]/g, "-");
  }

  function paymentChoiceControl(element) {
    if (!element) return false;
    const tag = String(element.tagName || "").toLowerCase();
    const type = String(element.type || element.getAttribute?.("type") || "").toLowerCase();
    const role = String(element.getAttribute?.("role") || "").toLowerCase();
    if (["radio", "checkbox"].includes(type)) return true;
    if (["select", "option"].includes(tag)) return true;
    if (["radio", "checkbox", "option", "combobox", "listbox"].includes(role)) return true;
    return !!element.querySelector?.(
      'input[type="radio"], input[type="checkbox"], option, [role="radio"], [role="option"]',
    );
  }

  function paymentLocalContainer(element) {
    if (!element?.closest) return null;
    const selector = [
      "fieldset",
      "[role='group']",
      "[role='radiogroup']",
      "[role='listbox']",
      "[role='combobox']",
      "[data-field]",
      "[data-field-group]",
      "[data-testid*='field' i]",
      "[class*='field' i]",
      "[class*='question' i]",
      "[class*='pricing' i]",
      "[class*='plan' i]",
      "[class*='billing' i]",
      "[class*='payment' i]",
      "[class*='option' i]",
      "[class*='choice' i]",
      ".form-group",
      ".form-control",
      ".input-group",
    ].join(", ");
    const scoped = element.closest(selector);
    if (scoped) return scoped;

    // A plain wrapper is useful for custom controls, but never walk up to the
    // whole form/dialog. That would make an unrelated word such as "Paid" on
    // the page look like a payment action.
    let current = element.parentElement;
    for (let depth = 0; current && depth < 2; depth += 1, current = current.parentElement) {
      const tag = String(current.tagName || "").toLowerCase();
      if (["form", "body", "html", "dialog"].includes(tag)) break;
      const text = compactText(current.innerText || current.textContent || "", 1200);
      if (text && text.length <= 1200) return current;
    }
    return null;
  }

  function paymentAssociatedLabels(element) {
    const labels = [];
    if (element?.labels) labels.push(...Array.from(element.labels));
    const wrapped = element?.closest?.("label");
    if (wrapped) labels.push(wrapped);
    const id = element?.id || element?.getAttribute?.("id");
    if (id && document.querySelectorAll) {
      for (const label of Array.from(document.querySelectorAll("label[for]"))) {
        if (label.getAttribute("for") === id) labels.push(label);
      }
    }
    return [...new Set(labels)];
  }

  function paymentOptionLabels(root) {
    if (!root?.querySelectorAll) return [];
    const controls = Array.from(root.querySelectorAll(
      'input[type="radio"], input[type="checkbox"], select, option, [role="radio"], [role="option"]',
    ));
    const labels = [];
    for (const control of controls) {
      labels.push(getSnapshotLabel(control) || getElementLabel(control));
      paymentAssociatedLabels(control).forEach((label) => labels.push(label.innerText || label.textContent || ""));
    }
    return labels.filter(Boolean);
  }

  function getPaymentElementContext(element, actionType = "click") {
    const localContainer = paymentLocalContainer(element);
    const fieldset = element?.closest?.("fieldset, [role='group'], [role='radiogroup']") || null;
    const labels = paymentAssociatedLabels(element);
    const label = compactText(
      [getElementLabel(element), getSnapshotLabel(element), ...labels.map((item) => item.innerText || item.textContent || "")]
        .filter(Boolean)
        .join(" "),
      600,
    );
    const local = compactText(localContainer?.innerText || localContainer?.textContent || "", 1200);
    const fieldsetText = compactText(fieldset?.innerText || fieldset?.textContent || "", 1000);
    const optionRoot = fieldset || localContainer || (element?.tagName?.toLowerCase() === "select" ? element : null);
    const options = compactText(
      [
        ...paymentOptionLabels(optionRoot),
        ...(element?.tagName?.toLowerCase() === "select"
          ? Array.from(element.options || []).map((option) => option.textContent || option.label || option.value || "")
          : []),
      ].join(" "),
      900,
    );
    return {
      label,
      fieldset: fieldsetText,
      options,
      local,
      actionType,
      choiceControl: paymentChoiceControl(element),
    };
  }

  function classifyPaymentContext(input = {}) {
    const label = normalizePaymentContextText(input.label, 600);
    const fieldset = normalizePaymentContextText(input.fieldset, 1000);
    const options = normalizePaymentContextText(input.options, 900);
    const local = normalizePaymentContextText(input.local, 1200);
    const context = [label, fieldset, options, local].filter(Boolean).join(" ");
    const actionType = String(input.actionType || "click").toLowerCase();
    const choiceControl = input.choiceControl === true;
    const matched = [];

    const optionSignals = [
      /\bfree\b|\bno cost\b|免费/,
      /\bfreemium\b/,
      /\bpaid\b|付费/,
      /\bpremium\b|\bpro\b|\benterprise\b/,
      /\btrial\b|\bpay[- ]as[- ]you[- ]go\b/,
      /\bmonthly\b|\byearly\b|\bannual\b|月付|年付/,
    ].reduce((count, pattern) => count + (pattern.test(options) ? 1 : 0), 0);
    const pricingContext =
      /\bpricing(?:\s+(?:model|type|plan))?\b|\bprice\b|\bcost\b|\bplan(?:s)?\b|\btier(?:s)?\b|\bpricing\b|\bfree\b|\bfreemium\b|\bpaid\b|\bpremium\b|\bsubscription\b|定价|价格|费用|套餐|方案|免费|付费|订阅/.test(
        context,
      );
    const productBillingQuestion =
      (/(?:does|do|is|are|can|will|would|should)\b.{0,100}\b(?:your|the)\b.{0,80}\b(?:website|product|tool|app|service|business)\b.{0,100}\b(?:require|accept|support|offer|charge|have|use)\b.{0,60}\b(?:payment|payments|paid|billing|pricing|subscription|free|freemium|stripe|paypal|credit\s+card)\b/.test(
        context,
      ) ||
        /\b(?:your|the)\s+(?:website|product|tool|app|service)\b.{0,100}\b(?:paid|free|freemium|charge|cost|payment|pricing|stripe|paypal|credit\s+card)\b/.test(
          context,
        )) &&
      !/\b(?:to\s+submit|to\s+publish|to\s+list|to\s+post|listing fee|submission fee|promote|boost|sponsored placement)\b/.test(
        context,
      );
    const explicitSubmissionPayment =
      /\bpay\s+to\s+(?:submit|publish|list|post)\b|\bpayment\s+(?:is\s+)?required\s+to\s+(?:submit|publish|list|post)\b|\b(?:listing|submission)\s+fee\b|\bfee\s+to\s+(?:submit|publish|list|post)\b|\bpay\s+for\s+(?:the\s+)?(?:listing|submission)\b|\bpaid\s+(?:placement|listing)\b|\bpromote\s+(?:this|your)\s+(?:launch|listing)\b|\bboost\s+(?:this|your)\s+(?:launch|listing)\b/.test(
        context,
      );
    const paymentMethodContext = /\bpayment\s+method\b/.test(context);
    const paymentProviderContext = /\bstripe\b|\bpaypal\b/.test(context);
    const checkoutContext =
      /\bcheckout\b|\bcredit\s*card\b|\bcard\s+number\b|\bcvv\b|\bcvc\b|\bexpir(?:y|ation)\s+date\b|\bbilling\s+address\b|\bamount\s+due\b|\btotal\s+due\b|\bplace\s+(?:the\s+)?order\b|\bcomplete\s+(?:the\s+)?order\b|\border\s+(?:a\s+)?subscription\b|\bsubscription\s+(?:order|checkout|payment)\b/.test(
        context,
      ) ||
      ((!productBillingQuestion) && (paymentMethodContext || paymentProviderContext));
    const actionPayment =
      /\bpay(?:\s+now)?\b|\bpay\s+to\s+(?:submit|publish|list|post)\b|\bcheckout\b|\bpurchase\b|\bbuy(?:\s+now)?\b|\bplace\s+(?:the\s+)?order\b|\bcomplete\s+(?:the\s+)?order\b|\bconfirm\s+(?:payment|purchase)\b|\bsubscribe\s+(?:now|to\s+(?:a|the)\s+plan)\b|\bstart\s+(?:a\s+)?subscription\b|\bupgrade\s+(?:now|plan|subscription|account)\b/.test(
        label,
      );

    if (pricingContext) matched.push("pricing_context");
    if (optionSignals > 0) matched.push("pricing_options");
    if (productBillingQuestion) matched.push("product_billing_question");
    if (explicitSubmissionPayment) matched.push("submission_payment");
    if (checkoutContext) matched.push("checkout_context");
    if (actionPayment) matched.push("payment_action");

    // A pricing question/choice describes the product being submitted. It is
    // not a charge to the submitter, even when the selected option is "Paid".
    const productPricing =
      !explicitSubmissionPayment &&
      !actionPayment &&
      ((productBillingQuestion && (choiceControl || actionType === "submit")) ||
        (!checkoutContext &&
          ((pricingContext && optionSignals > 0 && (choiceControl || actionType === "submit")) ||
            (choiceControl && optionSignals >= 2 && pricingContext))));
    if (productPricing) {
      return {
        classification: "product_pricing",
        type: "pricing_choice",
        reason: "这是产品自身的定价/收费选项，不是本次提交付款",
        evidence: { label, fieldset, options, local, matched },
      };
    }

    if (explicitSubmissionPayment || checkoutContext || actionPayment) {
      return {
        classification: "confirmed_payment",
        type: "payment",
        reason: "当前动作明确进入付款、结算或付费提交流程",
        evidence: { label, fieldset, options, local, matched },
      };
    }

    const ambiguousPayment =
      /\bpayment\b|\bpay\b|\bpaid\b|\bbilling\b|\bsubscription\b|\bsubscribe\b|\bupgrade\b|\bprice\b|\bpricing\b|\bcost\b|\bcharge\b|\bplan\b|\btier\b|付款|支付|付费|账单|订阅|升级|价格|定价|费用|套餐/.test(
        context,
      );
    if (ambiguousPayment) {
      return {
        classification: "uncertain_payment",
        type: "payment_uncertain",
        uncertain: true,
        reason: "检测到付款相关语义，但局部表单无法确认是否真的扣款，交给模型判断",
        evidence: { label, fieldset, options, local, matched },
      };
    }

    return {
      classification: "safe",
      type: "safe",
      reason: "",
      evidence: { label, fieldset, options, local, matched },
    };
  }

  function classifyModelClickGate(element) {
    const label = compactText(getElementLabel(element), 500).toLowerCase();
    const paymentContext = getPaymentElementContext(element, "click");
    const payment = classifyPaymentContext(paymentContext);
    if (payment.classification === "confirmed_payment") {
      return {
        type: "payment",
        reason: payment.reason,
        uncertain: false,
        paymentClassification: payment.classification,
        paymentEvidence: payment.evidence,
      };
    }
    if (payment.classification === "uncertain_payment") {
      return {
        type: "payment_uncertain",
        reason: payment.reason,
        uncertain: true,
        paymentClassification: payment.classification,
        paymentEvidence: payment.evidence,
      };
    }

    const nearby = compactText(paymentContext.local || paymentContext.fieldset || "", 1200).toLowerCase();
    const context = `${label} ${nearby}`;
    if (detectCaptcha() || /captcha|recaptcha|hcaptcha|turnstile|验证码|人机验证/.test(context)) {
      return { type: "captcha", reason: "检测到验证码，需要人工完成" };
    }
    if (/\b(log[ -]?in|sign[ -]?in|sign up|continue with (google|github|apple)|oauth)\b|登录|登入|注册账号|第三方授权/.test(label)) {
      return { type: "login", reason: "登录或 OAuth 授权需要人工处理" };
    }
    if (/\b(delete account|delete project|remove account|cancel subscription)\b|删除账号|注销账号|取消订阅/.test(context)) {
      return { type: "destructive", reason: "检测到不可逆或破坏性动作，需要人工确认" };
    }
    if (/\b(i agree|accept terms|agree to (the )?(terms|privacy)|legal agreement|consent)\b|同意.*(条款|协议|隐私)|接受.*(条款|协议)/.test(context)) {
      return { type: "legal", reason: "检测到明确法律条款确认，需要人工处理" };
    }
    if (isModelSubmissionControl(element, label) || isLikelyNavigationControl(label)) {
      if (isAiToolsDirectoryHost()) {
        return { type: "legal", reason: AI_TOOLS_DIRECTORY_MANUAL_REASON };
      }
      const legalAgreement = detectDirectoryLegalAgreement(element.closest("form, [role='form']") || getActiveFillScope());
      if (legalAgreement) return { type: "legal", reason: legalAgreement };
    }
    return null;
  }

  function isModelSubmissionControl(element, label = "") {
    if (isSubmitControl(element)) return true;
    const normalized = String(label || "").toLowerCase();
    return /\b(submit|publish|launch|create draft|send listing|add (my )?(site|product|startup)|post comment)\b|提交|发布|创建草稿|发布评论|添加网站|添加产品/.test(normalized);
  }

  function isLikelyNavigationControl(label = "") {
    return /\b(next|continue|proceed|back|previous|finish|done|save and continue)\b|下一步|继续|上一步|返回|完成/.test(String(label).toLowerCase());
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
    const labelledBy = String(element.getAttribute("aria-labelledby") || "").trim();
    if (labelledBy) {
      labels.push(...labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || ""));
    }
    if (element.id) {
      labels.push(
        ...Array.from(document.querySelectorAll(`label[for="${cssEscape(element.id)}"]`)).map(
          (label) => label.textContent,
        ),
      );
    }
    const wrappingLabel = element.closest("label");
    if (wrappingLabel) labels.push(wrappingLabel.textContent);
    // React forms often place an unbound label next to a single control.
    // Read that visible label before relying on example placeholders.
    const parent = element.parentElement;
    if (parent && parent.querySelectorAll('input:not([type="hidden"]), textarea, select').length === 1) {
      const siblingLabel = parent.querySelector(":scope > label");
      if (siblingLabel) labels.push(siblingLabel.textContent);
    }
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

  function isEmailFieldHint(hint) {
    return /\b(?:e-?mail|email address|business mail|contact mail)\b/.test(String(hint || ""));
  }

  function isSocialMediaFieldHint(hint) {
    const normalized = String(hint || "").replace(/[_-]+/g, " ");
    return /\bsocial(?:\s+media)?\b|\b(?:twitter|linkedin|instagram|facebook|youtube|tiktok)\b|\bx\.com\b/.test(
      normalized,
    );
  }

  function isUnmappedSourceFieldHint(hint) {
    return /\b(?:how did you hear|hear about us|referral source|traffic source|lead source|utm source)\b/.test(
      String(hint || "").replace(/[_-]+/g, " "),
    );
  }

  function socialNetworkToken(hint) {
    const normalized = String(hint || "").toLowerCase();
    if (/\blinkedin\b/.test(normalized)) return "linkedin";
    if (/\binstagram\b/.test(normalized)) return "instagram";
    if (/\bfacebook\b/.test(normalized)) return "facebook";
    if (/\byoutube\b/.test(normalized)) return "youtube";
    if (/\btiktok\b/.test(normalized)) return "tiktok";
    if (/\b(?:twitter|x\.com)\b/.test(normalized)) return "twitter";
    return "";
  }

  function socialFieldKeyMatches(key, network) {
    const normalized = String(key || "").toLowerCase();
    if (!network) return true;
    if (network === "twitter") return /\b(?:twitter|x(?:\/|\s|$)|x\.com)\b/.test(normalized);
    return new RegExp(`\\b${network}\\b`).test(normalized);
  }

  function resolveConfiguredSocialUrl(config, hint) {
    const pf = getProfileFields(config);
    const network = socialNetworkToken(hint);
    const direct = [];
    if (!network && config?.socialMediaUrl) direct.push(config.socialMediaUrl);
    if (!network && config?.socialUrl) direct.push(config.socialUrl);
    if (config?.socialLinks && typeof config.socialLinks === "object") {
      if (network && config.socialLinks[network]) direct.push(config.socialLinks[network]);
      if (!network) direct.push(...Object.values(config.socialLinks));
    }
    const entries = Object.entries(pf).filter(([key]) => {
      if (!/\b(?:extra link|social|twitter|linkedin|instagram|facebook|youtube|tiktok|x\/twitter)\b/i.test(key)) {
        return false;
      }
      return socialFieldKeyMatches(key, network);
    });
    const candidates = [...direct, ...entries.map(([, value]) => value)];
    for (const candidate of candidates) {
      const match = String(candidate || "").match(/https?:\/\/[^\s"'<>),]+/i);
      if (!match) continue;
      const value = match[0].replace(/[.,]+$/, "");
      try {
        const parsed = new URL(value);
        if (!/^https?:$/.test(parsed.protocol)) continue;
        if (/^cdn\./i.test(parsed.hostname) || /\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/i.test(parsed.pathname)) {
          continue;
        }
        return parsed.toString();
      } catch {
        /* Ignore malformed or descriptive profile values. */
      }
    }
    return "";
  }

  function valueSatisfiesFieldConstraints(value, constraints) {
    const text = String(value || "").trim();
    if (!text || !constraints) return !!text;
    if (constraints.minLength && text.length < constraints.minLength) return false;
    if (constraints.maxLength && text.length > constraints.maxLength) return false;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (constraints.minWords && words < constraints.minWords) return false;
    if (constraints.maxWords && words > constraints.maxWords) return false;
    return true;
  }

  function isValidEmailValue(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  }

  function isValidHttpUrlValue(value) {
    try {
      const parsed = new URL(String(value || "").trim());
      return /^https?:$/.test(parsed.protocol) && !!parsed.hostname;
    } catch {
      return false;
    }
  }

  function isMediaUrlValue(value) {
    try {
      const parsed = new URL(String(value || "").trim());
      return /^cdn\./i.test(parsed.hostname) ||
        /\.(?:png|jpe?g|gif|webp|svg|avif|ico)(?:$|[?#])/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function modelFillGuard(element, raw) {
    const text = String(raw == null ? "" : raw).trim();
    const constraints = getFieldConstraints(element);
    const existing = String(getElementFillValue(element) || "").trim();
    if (
      existing &&
      !fieldNeedsRefill(element) &&
      valueSatisfiesFieldConstraints(existing, constraints)
    ) {
      return "preserve-existing-value";
    }
    if (!text) return "ignore-empty-model-value";

    const hint = getFieldHint(element);
    if (
      isUnmappedSourceFieldHint(hint) ||
      isSocialMediaFieldHint(hint) ||
      /\bprimary\s+use\s+case\b/.test(hint)
    ) {
      return "field-requires-configured-profile-value";
    }

    const fitted = fitValueToConstraints(text, constraints);
    if (!valueSatisfiesFieldConstraints(fitted, constraints)) return "field-minimum-not-met";
    if (isEmailFieldHint(hint) && !isValidEmailValue(fitted)) return "invalid-email-value";
    if (/\b(?:url|link|website|homepage)\b/.test(hint) || (element.type || "").toLowerCase() === "url") {
      if (!isValidHttpUrlValue(fitted)) return "invalid-url-value";
    }
    if (isSocialMediaFieldHint(hint) && isMediaUrlValue(fitted)) return "media-url-in-social-field";
    return "";
  }

  function shouldClearStaleProtectedValue(element, value) {
    const text = String(value || "").trim();
    if (!text) return false;
    const hint = getFieldHint(element);
    if (isEmailFieldHint(hint)) return !isValidEmailValue(text);
    return isSocialMediaFieldHint(hint) && isMediaUrlValue(text);
  }

  function shouldReplaceExistingProfileEmail(element, existing, resolved) {
    const current = String(existing || "").trim();
    const configured = String(resolved || "").trim();
    if (!current || !isValidEmailValue(configured)) return false;
    // A CMS may name a category control `email`; its visible label wins.
    const label = String(getSnapshotLabel(element) || "").toLowerCase();
    const isEmail = isEmailFieldHint(label) ||
      ((element.type || "").toLowerCase() === "email" && !label);
    return isEmail && current.toLowerCase() !== configured.toLowerCase();
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
    else if (/subscription|paid|credit|purchase/.test(pricingText))
      priorities.push("paid", "subscription", "one-time", "usage-based");
    else if (/free/.test(pricingText)) priorities.push("free", "freemium");
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
    const tagField = /\b(tags?|keywords?|hashtags?)\b/.test(hint);
    const profileTags = String(config.tags || pf["Tags Keywords/Hashtags"] || "")
      .split(/[,;|/]+/)
      .map((tag) => tag.trim().replace(/^#+/, ""))
      .filter(Boolean);

    if (/pric|plan|model|tier|billing/.test(hint)) {
      const pricingText = String(pf["PRICING TYPE"] || pf.Pricing || "freemium").toLowerCase();
      if (/freemium/.test(pricingText)) tokens.push("freemium", "free");
      else if (/subscription|paid|credit|purchase/.test(pricingText)) tokens.push("paid", "subscription", "one-time", "usage-based");
      else if (/free/.test(pricingText)) tokens.push("free", "freemium");
      else tokens.push("freemium", "free", "paid");
    }

    if (/categor|industry|sector|niche|vertical|topic|type/.test(hint)) {
      tokens.push(...profileTags.filter((tag) => tag.length >= 4));
    }

    if (tagField) {
      return [...new Set(profileTags.slice(0, 5))];
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
    const hint = getFieldHint(element);
    const isCategoryOrPersona = /categor|industry|sector|niche|vertical|profession|audience|persona/.test(hint);
    for (const token of tokens) {
      if (isCategoryOrPersona && String(token).trim().length < 4) continue;
      const match = findBestSelectOption(options, token);
      if (match) return match.value;
    }

    if (isCategoryOrPersona) {
      return options.find((o) => /^other(?:\b|\s)/i.test(o.label))?.value || "";
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
      trigger.tagName?.toLowerCase() === "input"
        ? trigger.value
        : trigger.textContent || trigger.getAttribute("aria-valuetext"),
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
    const visibleOptions = () => {
      const reactSelect = trigger.closest?.('[class*="css-"][class*="-container"]');
      if (reactSelect && trigger.id) {
        const prefix = `react-select-${trigger.id}-option-`;
        return Array.from(document.querySelectorAll('[id*="-option-"]'))
          .filter((el) => el.id?.startsWith(prefix) && isVisible(el))
          .map((el) => ({ el, label: compactText(el.textContent, 120) }))
          .filter((option) => option.label);
      }
      for (const sel of optionSelectors) {
        const options = Array.from(document.querySelectorAll(sel))
          .filter(isVisible)
          .map((el) => ({ el, label: compactText(el.textContent, 120) }))
          .filter((option) => option.label && !/^(select|choose|pick|please)/i.test(option.label));
        if (options.length) return options;
      }
      return [];
    };
    if (!visibleOptions().length) {
      trigger.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }));
      await sleep(120);
    }

    for (const token of desiredTokens.slice(0, 8)) {
      if (!token) continue;
      let options = visibleOptions();
      const n = normalizeOptionText(token);
      let match = options.find(
        (o) =>
          normalizeOptionText(o.label) === n ||
          normalizeOptionText(o.label).includes(n) ||
          n.includes(normalizeOptionText(o.label)),
      );
      if (!match && trigger.tagName?.toLowerCase() === "input") {
        setFieldValue(trigger, token);
        trigger.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: token }));
        await sleep(180);
        options = visibleOptions();
        match = options.find((o) => {
          const label = normalizeOptionText(o.label);
          return label === n || label.includes(n) || n.includes(label);
        });
      }
      if (match) {
        match.el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        await sleep(80);
        if (isCustomDropdownEmpty(trigger)) match.el.click();
        await sleep(150);
        if (!isCustomDropdownEmpty(trigger)) return true;
      }
      if (trigger.tagName?.toLowerCase() === "input") {
        setFieldValue(trigger, "");
        trigger.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
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
    const dialogCandidates = [];
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
          if (fillable.length > 0) dialogCandidates.push({ element: el, fillable });
        }
      } catch {
        /* invalid selector in old browsers */
      }
    }

    let bestForm = null;
    let bestScore = 0;
    for (const form of document.querySelectorAll("form")) {
      if (!isVisible(form) || isMarketingOptInForm(form)) continue;
      const score = queryFillableElements(form).length;
      if (score > bestScore) {
        bestScore = score;
        bestForm = form;
      }
    }
    for (const candidate of dialogCandidates) {
      // A newsletter/login popup can appear before its heading finishes
      // rendering. Require a listing field before it can replace the real
      // submission form as the active fill scope.
      if (!hasLikelyListingFields(candidate.element)) continue;
      const text = String(candidate.element.innerText || candidate.element.textContent || "");
      const onlyEmail =
        candidate.fillable.length === 1 &&
        String(candidate.fillable[0].type || "").toLowerCase() === "email";
      const marketingOptIn =
        isMarketingOptInForm(candidate.element) ||
        Array.from(candidate.element.querySelectorAll?.("form") || []).some(isMarketingOptInForm) ||
        (onlyEmail && /newsletter|subscribe|join\s+[\d,]+|don't miss|free database/i.test(text));
      if (marketingOptIn) continue;
      return candidate.element;
    }
    return bestForm || document;
  }

  function queryFillableElements(scope) {
    const root = scope || getActiveFillScope();
    const primary = Array.from(
      root.querySelectorAll(
        'input, textarea, select, [contenteditable="true"], [role="textbox"][contenteditable]',
      ),
    ).filter((element) => {
      const type = (element.type || "").toLowerCase();
      const owningForm = element.closest?.("form") || (root.matches?.("form") ? root : null);
      if (owningForm && isMarketingOptInForm(owningForm)) return false;
      // Modern upload UIs usually hide the real file control behind a visible
      // dropzone. Keep that control available for DataTransfer injection, but
      // only when the nearby visible label is clearly an upload/media target.
      if (type === "file") return isAutomatableFileInput(element);
      if (!isFillableField(element)) return false;
      if (isContentEditableField(element) && element.parentElement?.isContentEditable) return false;
      if (type === "hidden" || type === "submit" || type === "button" || type === "reset")
        return false;
      return true;
    });

    // Multi-step pages sometimes render the next-step taxonomy controls beside
    // (rather than inside) the URL form. Keep the best-form scope for avoiding
    // newsletter/search fields, but include visible discovery selects wherever
    // the framework mounted them so the run can finish the current stage.
    if (root !== document) {
      const supplemental = Array.from(document.querySelectorAll("select"))
        .filter((element) => !root.contains(element))
        .filter((element) => isVisible(element) && isFillableField(element))
        .filter((element) => /categor|industry|sector|niche|vertical|topic|project\s*kind|product\s*type/.test(getFieldHint(element)));
      for (const element of supplemental) {
        if (!primary.includes(element)) primary.push(element);
      }
    }

    return primary;
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
    if (constraints.minWords) {
      const wc = String(value).split(/\s+/).filter(Boolean).length;
      if (wc < constraints.minWords) return true;
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

    if (/\b(short description|short desc)\b/.test(hint)) {
      const candidates = [
        pf["Short description(20-30 words)"],
        pf["Short Discription(100-150 words)"],
        pickShortPitch(config),
        pickDescription(config),
      ].filter(Boolean);
      const minWords = constraints.minWords || 0;
      const source = candidates.find((value) => String(value).trim().split(/\s+/).length >= minWords) || "";
      return fitValueToConstraints(source, {
        ...constraints,
        maxWords: constraints.maxWords || 30,
        maxLength: constraints.maxLength || 200,
      });
    }
    if (/\b2\s*[-–]\s*3\s+sentences?\b/.test(hint)) {
      const sentences = String(pickDescription(config)).split(/(?<=[.!?])\s+/).filter(Boolean);
      return fitValueToConstraints(sentences.slice(0, 3).join(" "), constraints);
    }

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
      const match = text.match(/(\d+)\s*\/\s*(\d+)\s*(words?)?/i);
      if (match) {
        const max = parseInt(match[2], 10);
        if (max > 0 && max <= 5000) {
          return { current: parseInt(match[1], 10), max, unit: match[3] ? "words" : "characters" };
        }
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
    } else {
      const maxWord = combined.match(/(?:max|up to|limit)\s*(\d+)\s*words?/i);
      if (maxWord) {
        maxWords = parseInt(maxWord[1], 10);
      }
      const minWord = combined.match(/(?:min(?:imum)?|at least)\s*(\d+)\s*words?/i);
      if (minWord) minWords = parseInt(minWord[1], 10);
    }

    const charLimit = combined.match(/(?:max|up to|limit)\s*(\d+)\s*(?:character|char)/i);
    if (charLimit) maxLength = maxLength || parseInt(charLimit[1], 10);

    const counter = findCharCounter(element);
    if (counter?.max) {
      if (counter.unit === "words") {
        if (!maxWords || counter.max < maxWords) maxWords = counter.max;
      } else if (!maxLength || counter.max < maxLength) {
        maxLength = counter.max;
      }
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
    if (isAiToolsDirectoryHost()) return aiToolsDirectoryManualGate();
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

  function normalizeLearnedFieldText(value) {
    return compactText(value, 320)
      .toLowerCase()
      .replace(/[\u00a0*_]/g, " ")
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function learnedFieldTextMatches(expected, actual) {
    const wanted = normalizeLearnedFieldText(expected);
    const current = normalizeLearnedFieldText(actual);
    if (!wanted || !current) return false;
    if (wanted === current) return true;
    if (wanted.length < 4 || current.length < 4) return false;
    return current.includes(wanted) || wanted.includes(current);
  }

  function sharedLearnedMappingMatches(learned, current = {}) {
    if (!learned?.shared) return true;
    const expectedLabel = normalizeLearnedFieldText(learned.label);
    const expectedHint = normalizeLearnedFieldText(learned.hint);
    const currentLabel = normalizeLearnedFieldText(current.label);
    const currentHint = normalizeLearnedFieldText(current.hint);
    const checks = [];
    if (expectedLabel) checks.push(learnedFieldTextMatches(expectedLabel, currentLabel));
    if (expectedHint) checks.push(learnedFieldTextMatches(expectedHint, currentHint));
    // A shared mapping without a semantic fingerprint is unsafe to replay.
    // Requiring every stored part to match also makes a changed form fall back
    // to the normal field resolver instead of silently reusing an old value.
    return checks.length > 0 && checks.every(Boolean);
  }

  function resolveSharedLearnedProfileValue(learned, current, profileFields = {}) {
    if (learned?.shared !== true || !sharedLearnedMappingMatches(learned, current)) return "";
    const value = learned.profileKey ? profileFields[learned.profileKey] : "";
    return value == null ? "" : String(value);
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
      if (options.some(isHumanDeclarationField)) continue;
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

  function publicMediaUrlForField(config, hint) {
    const pf = getProfileFields(config);
    const normalizedHint = String(hint || "").replace(/[_-]+/g, " ");
    if (/\b(?:screenshot|screen shot)\b/.test(normalizedHint)) {
      const screenshot = String(pf["Screenshot 1"] || config.screenshots?.[0] || "").trim();
      const featured = String(pf["Featured image"] || config.featuredImage || "").trim();
      if (!screenshot || screenshot === featured || screenshot === String(pf.LOGO || config.logoUrl || "").trim()) return "";
      try {
        const parsed = new URL(screenshot);
        // A Profile can also store example output art under "Screenshot 1".
        // A URL-only field needs an actual product-screen image, so leave it
        // blank when the public path does not identify a screen capture.
        const screenPath = /(?:^|[\/_-])(?:screenshots?|screen[-_]?shots?|screen|dashboard|editor|homepage|home|ui)(?=[\/_.-]|$)/i.test(parsed.pathname);
        return /^https?:$/.test(parsed.protocol) && screenPath && /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(parsed.pathname)
          ? parsed.toString() : "";
      } catch {
        return "";
      }
    }
    const iconField = /\b(icon|logo|avatar|favicon)\b/.test(normalizedHint);
    const candidates = iconField
      ? [pf.LOGO, config.logoUrl, pf["Featured image"], config.featuredImage]
      : [pf["Featured image"], config.featuredImage, pf.LOGO, config.logoUrl];
    for (const candidate of candidates) {
      const raw = String(candidate || "").trim();
      try {
        const parsed = new URL(raw);
        if (/^https?:$/.test(parsed.protocol) && /\.(?:png|jpe?g|gif|webp|svg|avif|ico)$/i.test(parsed.pathname)) {
          return parsed.toString();
        }
      } catch {
        /* Private cloud-media references and non-URLs cannot be sent as public image URLs. */
      }
    }
    return "";
  }

  function resolveValueForField(config, element) {
    const pf = getProfileFields(config);
    const hint = getFieldHint(element);
    const type = (element.type || "").toLowerCase();
    const tag = element.tagName.toLowerCase();
    const normalizedHint = hint.replace(/[_-]+/g, " ");
    const visibleHint = getSnapshotLabel(element).toLowerCase();

    if (tag === "input" && /\b(?:one[\s_-]?line|one[\s_-]?liner)\b/.test(`${visibleHint} ${normalizedHint}`)) {
      const constraints = getFieldConstraints(element);
      return fitValueToConstraints(
        pf["Short description(20-30 words)"] || pf.Note || config.brandName || "",
        { ...constraints, maxWords: constraints.maxWords || 30, maxLength: constraints.maxLength || 200 },
      );
    }

    if (tag === "textarea" && /\bscreenshots?\b/.test(visibleHint) && /\b(?:image\s+urls?|urls?|one\s+image)\b/.test(visibleHint)) {
      const sources = [
        ...(Array.isArray(config.screenshots) ? config.screenshots : []),
        ...[1, 2, 3, 4].flatMap((index) => [pf[`Screenshot ${index}`], pf[`Screenshot-${index}`]]),
      ];
      return [...new Set(sources.map((source) => String(source || "").trim()).filter((source) => {
        try {
          const url = new URL(source);
          return /^https?:$/.test(url.protocol) && /\.(?:png|jpe?g|gif|webp|svg|avif)$/i.test(url.pathname);
        } catch { return false; }
      }))].slice(0, 4).join("\n");
    }
    // A description placeholder may mention its audience, use cases, or
    // features. The field's explicit description label takes precedence.
    if (/\b(?:short|full(?:\s+product)?|long|detailed|product)\s+description\b/.test(visibleHint)) {
      return pickDescriptionForField(config, element);
    }

    // Field intent must outrank the HTML input type and historical mappings.
    // TipSeason labels its email and social fields inconsistently, and the
    // social URL is optional when the current Profile has no matching value.
    const visibleCategoryField =
      tag === "input" &&
      ["text", "search", ""].includes(type) &&
      /\b(tags?|categor(?:y|ies)|keywords?)\b/.test(visibleHint) &&
      !/\be-?mail\b/.test(visibleHint);
    const visibleUrlField =
      tag === "input" &&
      /\b(?:website\s+url|product\s+url|tool\s+url|homepage|url|link)\b/.test(visibleHint);
    if (
      !visibleCategoryField &&
      !visibleUrlField &&
      (type === "email" || isEmailFieldHint(`${hint} ${visibleHint}`))
    ) {
      return config.email || pf["Business mail"] || pf["Feedback mail"] || "";
    }
    if (isSocialMediaFieldHint(`${hint} ${visibleHint}`)) {
      return resolveConfiguredSocialUrl(config, `${hint} ${visibleHint}`);
    }
    if (isUnmappedSourceFieldHint(`${hint} ${visibleHint}`)) return "";
    if (/\baffiliate\s*(?:link|url)?\b|\breferral\s+(?:link|url)\b/.test(`${hint} ${visibleHint}`)) {
      const affiliate = pf["Affiliate Link"] || pf["Affiliate URL"] || pf["Referral Link"] || pf["Referral URL"] || "";
      return /^https?:\/\/[^\s]+$/i.test(String(affiliate).trim()) ? String(affiliate).trim() : "";
    }
    if (/\bprimary\s+use\s+case\b/.test(`${hint} ${visibleHint}`)) {
      const useCase =
        (Array.isArray(config.useCases) ? config.useCases.find(Boolean) : "") ||
        pf["Primary Use Case"] ||
        pf["Use Case"] ||
        "";
      return fitValueToConstraints(useCase || "", getFieldConstraints(element));
    }
    if (/\b(?:target\s+audience|intended\s+users?|ideal\s+customers?)\b/.test(visibleHint)) {
      const audience = config.targetAudience || pf["Target Audience"] || pf["Target audience"] || pf.Audience || "";
      return fitValueToConstraints(audience, getFieldConstraints(element));
    }
    if (/\b(?:pros|advantages|strengths)\b/.test(visibleHint) && !/\b(?:cons|disadvantages)\b/.test(visibleHint)) {
      return fitValueToConstraints(pf.Pros || pf.Advantages || "", getFieldConstraints(element));
    }
    if (/\b(?:cons|disadvantages|limitations)\b/.test(visibleHint)) {
      return fitValueToConstraints(pf.Cons || pf.Limitations || "", getFieldConstraints(element));
    }
    if (/\bfounder\s*(?:\/|or)\s*company(?:\s+name)?\b/.test(visibleHint)) {
      return fitValueToConstraints(pf.Founder || pf.Company || config.username || "", getFieldConstraints(element));
    }
    if (/\bwhy\s+(?:should|would)\s+(?:we|you)\s+list\b/.test(visibleHint)) {
      return fitValueToConstraints(pf.Note || pf["Short description(20-30 words)"] || "", getFieldConstraints(element));
    }

    // A repository URL is not the product homepage. Resolve it before legacy
    // learned mappings, which may already contain the old generic URL answer.
    if (/\bgithub\b/.test(hint)) {
      const entry = Object.entries(pf).find(([key]) => /\bgithub\b/i.test(key));
      const repositoryUrl = String(entry?.[1] || "").trim();
      return /^https?:\/\/(?:www\.)?github\.com\/[^\s]+$/i.test(repositoryUrl) ? repositoryUrl : "";
    }
    if (
      (type === "url" || /\b(url|link)\b/.test(normalizedHint)) &&
      /\b(image|icon|logo|avatar|favicon|thumbnail|banner|cover|screenshot|photo|media)\b/.test(normalizedHint)
    ) {
      return publicMediaUrlForField(config, normalizedHint);
    }
    // Custom listboxes need a selected option. Typing the entire profile tag
    // string into their search input leaves an invalid, unselected value.
    if (
      tag === "input" &&
      (element.getAttribute("role") === "combobox" ||
        element.getAttribute("aria-autocomplete") === "list" ||
        element.getAttribute("aria-haspopup") === "listbox")
    ) {
      return "";
    }
    if (/\bother tags?\b/.test(normalizedHint)) {
      return String(config.tags || pf["Tags Keywords/Hashtags"] || "")
        .split(/[,;|/]+/)
        .map((tagValue) => tagValue.trim().replace(/^#+/, ""))
        .filter(Boolean)
        .slice(0, 5)
        .join(", ");
    }
    // Some directories use an ordinary text input as the search half of a
    // category picker. Its hidden slug, not the search text, is the selection.
    if (
      tag === "input" && /\bcategory\b/.test(normalizedHint) &&
      element.parentElement?.querySelector('input[type="hidden"][name*="category"]')
    ) {
      return "";
    }
    // CMS forms can name a category field `email` internally. Its visible
    // label is the intent; never paste a business email into a tag field.
    if (
      tag === "input" && ["text", "search", ""].includes(type) &&
      /\b(tags?|categor(?:y|ies)|keywords?)\b/.test(visibleHint) &&
      !/\be-?mail\b/.test(visibleHint)
    ) {
      if (/\bcategory\b/.test(visibleHint) && /^(?:www\.)?iatool\.online$/i.test(location.hostname)) {
        const product = String(config.brandName || pf.Name || "").trim().toLowerCase();
        if (/^(?:graffiti name ai|oldphotolive ai)$/.test(product)) return "Image Generation & Editing";
        // Come AI has no gaming category. Its category field is optional, so
        // leave an unrepresented product blank rather than submit a keyword.
        return "";
      }
      const tags = String(config.tags || pf["Tags Keywords/Hashtags"] || "")
        .split(/[,;|/]+/).map((value) => value.trim().replace(/^#+/, "")).filter(Boolean);
      return /\b(tags|keywords)\b/.test(visibleHint) ? tags.slice(0, 5).join(", ") : (tags[0] || "");
    }
    // Explicit field labels outrank old learned answers. A learned mapping
    // from another submission must not put the product URL in Title/Description.
    if (
      type === "url" ||
      (tag === "input" && /^(?:website\s+url|url\b|link\b|product\s+url|tool\s+url|homepage\b)/.test(visibleHint))
    ) {
      return config.targetDomain || pf.Url || "";
    }
    if (type === "email" || /\b(e-?mail|email address)\b/.test(hint)) {
      return config.email || pf["Business mail"] || pf["Feedback mail"] || "";
    }
    if (/\b(title|subject|headline)\b/.test(hint) && type !== "url") {
      return fitValueToConstraints(pf.Title || config.brandName || "", getFieldConstraints(element));
    }
    if (/\b(?:key\s+)?features?\b/.test(visibleHint)) {
      return fitValueToConstraints(pf["Feature description"] || pf.Features || "", getFieldConstraints(element));
    }
    if (/\buse\s+cases?\b/.test(visibleHint)) {
      const useCases = Array.isArray(config.useCases) ? config.useCases.filter(Boolean).join("; ") : "";
      return fitValueToConstraints(useCases || pf["Primary Use Case"] || pf["Use Case"] || "", getFieldConstraints(element));
    }
    if (/\b(?:pricing|price|cost)\s+(?:details?|description|information)\b/.test(visibleHint)) {
      return fitValueToConstraints(
        pf.Pricing || pf["Cost & Subscription"] || config.pricing || "",
        getFieldConstraints(element),
      );
    }
    if (tag === "textarea" || /\b(descrip\w*|describ\w*|summary|about|details?)\b/.test(visibleHint)) {
      return pickDescriptionForField(config, element);
    }
    if (/\bfirst\s+name\b/.test(hint)) {
      return String(config.username || "").trim().split(/\s+/)[0] || "";
    }
    if (/\blast\s+name\b|\bsurname\b|\bfamily\s+name\b/.test(hint)) {
      const parts = String(config.username || "").trim().split(/\s+/).filter(Boolean);
      return parts.length > 1 ? parts.slice(1).join(" ") : "";
    }
    const host = location.hostname;
    const learnedKey = fieldMappingKey(element);
    const learned =
      config.learnedFieldMappings &&
      config.learnedFieldMappings[host] &&
      config.learnedFieldMappings[host][learnedKey];

    if (learned) {
      const sharedMatches = learned.shared
        ? sharedLearnedMappingMatches(learned, {
            label: getSnapshotLabel(element),
            hint: getFieldHint(element),
          })
        : true;
      if (sharedMatches) {
        const constraints = getFieldConstraints(element);
        // Shared mappings are semantic hints only. They must resolve against
        // the current profile and must never replay a value learned from a
        // different profile or an older form.
        if (learned.shared === true) {
          const sharedValue = resolveSharedLearnedProfileValue(
            learned,
            { label: getSnapshotLabel(element), hint: getFieldHint(element) },
            pf,
          );
          if (sharedValue) {
            return fitValueToConstraints(sharedValue, constraints);
          }
        } else if (learned.profileKey && pf[learned.profileKey]) {
          // Historical profile-local mappings may contain a literal answer
          // captured from another product's still-filled form. Resolve only
          // the current Profile's field value.
          return fitValueToConstraints(pf[learned.profileKey], constraints);
        }
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

    const pageContext = capturePageContext();
    const useLogoDataUrl = media === true || media?.useLogoDataUrl === true;
    const descriptor = media && typeof media === "object" ? media : null;
    const dataUrl = useLogoDataUrl ? config?.logoDataUrl : "";

    try {
      if (dataUrl && String(dataUrl).startsWith("data:")) {
        const blob = await (await fetch(dataUrl)).blob();
        if (!isCurrentPageContext(pageContext)) return false;
        if (await attachBlobToFileInput(input, blob, "logo")) {
          if (!isCurrentPageContext(pageContext)) return false;
          reportMediaUpload("success", { name: "logo", source: "embedded", bytes: blob.size, mime: blob.type });
          return true;
        }
      }
      if (imageUrl) {
        if (isCloudMediaRef(imageUrl)) {
          const cloud = await fetchCloudMediaBlob(imageUrl, descriptor?.profileKey || "cloud-media");
          if (!isCurrentPageContext(pageContext)) return false;
          if (await attachBlobToFileInput(input, cloud.blob, cloud.name)) {
            if (!isCurrentPageContext(pageContext)) return false;
            logStep(`☁️ 已用云端媒体上传 ${cloud.name}`);
            reportMediaUpload("success", { name: cloud.name, source: "cloud", bytes: cloud.blob.size, mime: cloud.blob.type });
            return true;
          }
        }
        const absolute = new URL(imageUrl, baseUrl || location.href).href;
        const sourceName = absolute.split("/").pop()?.split("?")[0] || "image";
        const blob = await fetchSubmissionMediaBlob(absolute);
        if (!isCurrentPageContext(pageContext)) return false;
        if (await attachBlobToFileInput(input, blob, sourceName)) {
          if (!isCurrentPageContext(pageContext)) return false;
          reportMediaUpload("success", { name: sourceName, source: "remote", bytes: blob.size, mime: blob.type });
          return true;
        }
      }
    } catch {
      /* The page may block remote image reads; report the usable cloud reference below. */
    }
    if (isCurrentPageContext(pageContext)) {
      reportMediaUpload("failed", { profile: config?.projectKey || "", reason: "没有可用或符合要求的云端媒体文件" });
    }
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

  function clearStaleProfileListingForm(elements, config) {
    const expected = String(config.targetDomain || "").trim();
    const expectedBrand = String(config.brandName || "").trim();
    if (!/^https?:\/\//i.test(expected)) return 0;
    let expectedHost;
    try { expectedHost = new URL(expected).hostname.replace(/^www\./, ""); }
    catch { return 0; }
    const staleForms = new Set();
    for (const element of elements) {
      const current = String(getElementFillValue(element) || "").trim();
      if (!/^https?:\/\//i.test(current)) continue;
      if (String(resolveValueForField(config, element) || "").trim() !== expected) continue;
      try {
        if (new URL(current).hostname.replace(/^www\./, "") !== expectedHost) {
          const form = element.closest("form");
          if (form) staleForms.add(form);
        }
      } catch { /* An invalid existing URL is handled by normal validation. */ }
    }
    // Some sites restore the previous submission's draft across tabs. If the
    // operator has already changed the website to this Profile, the URL-only
    // check above cannot see the stale title/description left behind.
    if (expectedBrand) {
      for (const element of elements) {
        const label = `${getSnapshotLabel(element)} ${element.name || ""}`.toLowerCase();
        if (!/\b(?:tool|product|app|startup|company)\s*name\b/.test(label)) continue;
        const currentBrand = String(getElementFillValue(element) || "").trim();
        if (!currentBrand || currentBrand.toLowerCase() === expectedBrand.toLowerCase()) continue;
        const form = element.closest("form");
        if (!form) continue;
        const hasCurrentProductUrl = elements.some((candidate) => {
          if (candidate.closest("form") !== form) return false;
          if (String(resolveValueForField(config, candidate) || "").trim() !== expected) return false;
          try {
            return new URL(String(getElementFillValue(candidate) || "").trim()).hostname.replace(/^www\./, "") === expectedHost;
          } catch { return false; }
        });
        if (hasCurrentProductUrl) staleForms.add(form);
      }
    }
    let cleared = 0;
    for (const element of elements) {
      if (!staleForms.has(element.closest("form"))) continue;
      const tag = element.tagName.toLowerCase();
      const type = String(element.type || "").toLowerCase();
      if (!(tag === "textarea" || tag === "select" || (tag === "input" && ["text", "url", "email", "search", ""].includes(type)))) continue;
      if (!getElementFillValue(element)) continue;
      setFieldValue(element, "");
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      cleared++;
    }
    if (cleared) logStep(`↻ 当前表单含其他产品链接，已清空 ${cleared} 个旧字段`);
    return cleared;
  }

  async function smartFillFromConfig(config) {
    if (isAiToolsDirectoryHost()) return aiToolsDirectoryManualGate();
    const pageContext = capturePageContext();
    logStep("🧠 智能填写全部表单字段…");
    const pf = getProfileFields(config);
    const baseUrl = config.targetDomain || pf.Url || location.href;
    const elements = queryFillableElements();
    clearStaleProfileListingForm(elements, config);
    const choiceResult = fillChoiceGroups(elements, config);
    let filledCount = choiceResult.filledCount;
    const mappings = { ...choiceResult.mappings };
    const skippedFiles = [];
    const uploadedFiles = [];
    const inferredFields = new Set();
    let screenshotCursor = 0;

    for (const element of elements) {
      if (!isCurrentPageContext(pageContext)) {
        return stalePageResult("form", {
          filledCount,
          mappings,
          skippedFiles,
          uploadedFiles,
          inferredFields: [...inferredFields],
        });
      }
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
        if (!isCurrentPageContext(pageContext)) {
          return stalePageResult("form", {
            filledCount,
            mappings,
            skippedFiles,
            uploadedFiles,
            inferredFields: [...inferredFields],
          });
        }
        if (ok) {
          filledCount++;
          uploadedFiles.push(getSnapshotLabel(element) || element.name || "image");
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
      let existing = existingValue && String(existingValue).trim();
      if (existing && shouldClearStaleProtectedValue(element, existing)) {
        setFieldValue(element, "");
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        existing = "";
      }
      if (existing && !fieldNeedsRefill(element) &&
          !shouldReplaceExistingProfileEmail(element, existing, value)) continue;

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
      if (!valueSatisfiesFieldConstraints(fitted, getFieldConstraints(element))) continue;
      await simulateTyping(element, fitted);
      if (!isCurrentPageContext(pageContext)) {
        return stalePageResult("form", {
          filledCount,
          mappings,
          skippedFiles,
          uploadedFiles,
          inferredFields: [...inferredFields],
        });
      }
      filledCount++;
      mappings[fieldMappingKey(element)] = {
        profileKey: inferProfileKeyForValue(config, fitted),
        value: fitted,
        label: getSnapshotLabel(element),
      };
    }

    for (const trigger of queryCustomDropdowns()) {
      if (!isCurrentPageContext(pageContext)) {
        return stalePageResult("form", {
          filledCount,
          mappings,
          skippedFiles,
          uploadedFiles,
          inferredFields: [...inferredFields],
        });
      }
      if (!isCustomDropdownEmpty(trigger)) continue;
      const ok = await tryFillCustomDropdown(trigger, config);
      if (!isCurrentPageContext(pageContext)) {
        return stalePageResult("form", {
          filledCount,
          mappings,
          skippedFiles,
          uploadedFiles,
          inferredFields: [...inferredFields],
        });
      }
      if (ok) {
        filledCount++;
        mappings[fieldMappingKey(trigger)] = {
          profileKey: "select",
          value: compactText(trigger.textContent, 120),
          label: getSnapshotLabel(trigger),
        };
      }
    }

    return { filledCount, mappings, skippedFiles, uploadedFiles, inferredFields: [...inferredFields] };
  }

  function isCustomDropdownEmpty(trigger) {
    const reactSelect = trigger.closest?.('[class*="css-"][class*="-container"]');
    if (reactSelect?.querySelector?.('[class*="singleValue"], [class*="multiValue"]')) {
      return false;
    }
    if (reactSelect && trigger.tagName?.toLowerCase() === "input" && trigger.getAttribute("role") === "combobox") {
      // React Select search text is not a selected option, even when nonempty.
      return true;
    }
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
    const customDropdownSet = new Set(customDropdowns);
    const choiceGroups = collectChoiceGroups(elements);
    const choiceElements = new Set([...choiceGroups.values()].flat());
    let emptyCount = 0;
    let invalidCount = 0;
    const totalCount =
      elements.length - choiceElements.size - elements.filter((element) => customDropdownSet.has(element)).length +
      choiceGroups.size + customDropdowns.length;

    for (const element of elements) {
      if (choiceElements.has(element) || customDropdownSet.has(element)) continue;
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

    // An open custom picker can hide the parent form from the visible-field
    // scan. Its one search control is not proof that the form is complete.
    if (Array.from(document.querySelectorAll('[role="listbox"][data-state="open"]')).some(isVisible)) {
      emptyCount = Math.max(emptyCount, 1);
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
    // AISuperHub's free form validates these fields in React but omits HTML
    // required attributes; an empty form otherwise appears ready to submit.
    if (typeof location !== "undefined" && /(?:^|\.)aisuperhub\.io$/i.test(location.hostname)) {
      if (["email", "name", "shortDescription", "longDescription", "useCase", "website"].includes(element.name)) {
        return true;
      }
    }
    return /\*(?=\s|$)|\brequired\b/i.test(getSnapshotLabel(element));
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
      const profileKey = inferProfileKeyForValue(config, val);
      if (!profileKey) continue;
      mappings[key] = {
        profileKey,
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

  function isAutomatableFileInput(element) {
    if (!element || String(element.type || "").toLowerCase() !== "file") return false;
    if (element.disabled || element.readOnly || element.closest('[aria-hidden="true"], [hidden]')) return false;
    if (isVisible(element)) return true;

    const labels = Array.from(element.labels || []);
    const wrapper = element.closest(
      'label, [data-dropzone], [data-upload], [class*="dropzone" i], [class*="upload" i]',
    );
    const nearby = [wrapper, ...labels, element.parentElement, element.parentElement?.parentElement]
      .filter(Boolean)
      .filter(isVisible);
    if (!nearby.length) return false;

    const hint = compactText(
      [getSnapshotLabel(element), element.name, element.id, ...nearby.map((node) => node.textContent || "")]
        .filter(Boolean)
        .join(" "),
      800,
    ).toLowerCase();
    return /upload|drop|image|logo|screenshot|gallery|media|photo|thumbnail|attachment|文件|上传|图片|封面|截图|媒体|附件/.test(hint);
  }

  // ─── Captcha Detection ───
  function detectCaptcha() {
    // reCAPTCHA
    if (findVisibleHumanGate(
      '.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="captcha"], .grecaptcha-badge',
    )) return true;
    // hCaptcha
    if (findVisibleHumanGate('.h-captcha, iframe[src*="hcaptcha"]')) return true;
    // Cloudflare Turnstile
    if (findVisibleHumanGate('.cf-turnstile, iframe[src*="challenges.cloudflare"]')) return true;
    // Image captcha
    if (findVisibleHumanGate('img[src*="captcha"], img.captcha, img[alt*="captcha" i]')) return true;
    // Generic captcha input
    if (findVisibleHumanGate(
      'input[name*="captcha"], input[id*="captcha"], input[placeholder*="captcha" i]',
    )) return true;
    // Math captcha
    if (findVisibleHumanGate('input[name*="math"], input[name*="spam"]')) return true;
    // OTP / Verification code
    const verificationInput = Array.from(document.querySelectorAll(
      'input[name*="code"], input[id*="code"], input[name*="otp"], input[id*="otp"], ' +
        'input[name*="verification"], input[id*="verification"], input[name*="emailCode"], input[id*="emailCode"]',
    )).find((element) => isVisibleHumanGate(element) && isVerificationCodeField(element));
    if (verificationInput) return true;

    return false;
  }

  function highlightCaptchaArea() {
    const captchaEl = findVisibleHumanGate(
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
    const labels = textMatches.map((text) => text.toLowerCase());
    const direct = Array.from(document.querySelectorAll(selector));
    const candidates = Array.from(new Set([
      ...direct,
      ...Array.from(
      document.querySelectorAll(
        'button, input[type="submit"], input[type="button"], a[role="button"], .button, .btn',
      ),
      ),
    ]));
    const fillable = queryFillableElements();
    const lastControl = fillable[fillable.length - 1] || null;

    return candidates
      .filter((element) => {
        if (!isVisible(element) || element.disabled || element.getAttribute("aria-disabled") === "true") {
          return false;
        }
        // Links styled as buttons usually reopen or navigate to a submission
        // page; they are entry points, not the form action itself.
        if (element.tagName.toLowerCase() === "a") return false;
        const label = getElementLabel(element);
        return direct.includes(element) || labels.some((text) => label.includes(text));
      })
      .map((element, index) => {
        const label = getElementLabel(element).replace(/\s+/g, " ").trim();
        let score = direct.includes(element) ? 20 : 0;
        if (labels.some((text) => label.includes(text))) score += 15;
        // Prefer the action belonging to the latest visible form stage. This
        // matters when an SPA keeps an earlier "Submit link" form mounted
        // above a newly-rendered review/category stage.
        if (/submit for review|skip.*submit|finish|complete|publish|send for review|final/i.test(label)) score += 80;
        if (/submit\s+(?:the\s+)?(?:link|url)|next|continue|proceed/i.test(label)) score -= 35;
        if (lastControl) {
          const relation = lastControl.compareDocumentPosition(element);
          if (relation & Node.DOCUMENT_POSITION_FOLLOWING) score += 30;
          if (relation & Node.DOCUMENT_POSITION_PRECEDING) score -= 20;
        }
        const form = element.closest("form");
        if (form) score += Math.min(25, queryFillableElements(form).length * 5);
        return { element, score, index };
      })
      .sort((a, b) => b.score - a.score || b.index - a.index)[0]?.element || null;
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
    if (detectWPComment() || detectArticleComment() || detectDirectory()) return true;
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
    if (!field || field.tagName?.toLowerCase() !== "textarea") return false;
    if (isArticleCommentField(field)) return true;
    const wpForm = findVisibleWpCommentForm();
    if (!wpForm || !wpForm.contains?.(field)) return false;
    const wpField = wpForm.querySelector?.(
      '#comment, textarea[name="comment"], textarea.comment, ' +
        'textarea[aria-label*="comment" i], textarea[placeholder*="comment" i]',
    );
    return wpField === field;
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
    const pageContext = options.__pageContext || capturePageContext();
    if (!isCurrentPageContext(pageContext)) return null;
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

    if (!isCurrentPageContext(pageContext)) {
      logStep("ℹ️ 页面已切换，已丢弃旧评论草稿");
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
    const pageContext = capturePageContext();
    if (config?.commentTemplate && options.preferTemplate !== false) {
      return config.commentTemplate;
    }

    const drafts = await requestCommentDrafts(config, { ...options, __pageContext: pageContext });
    if (!isCurrentPageContext(pageContext)) {
      logStep("ℹ️ 页面已切换，已跳过旧评论内容");
      return "";
    }
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
      if (!chrome.runtime?.id) {
        clearInterval(checkInterval);
        return;
      }
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
