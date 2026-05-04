// ExternalLink Extension - Content Script (Form Filling Engine)
'use strict';

(function() {
  // Prevent double injection
  if (window.__extLinkLoaded) return;
  window.__extLinkLoaded = true;

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
  const SNAPSHOT_SELECTOR_ATTR = 'data-extlink-selector';
  const SNAPSHOT_SELECTOR_PREFIX = 'extlink';
  const SNAPSHOT_TEXT_LIMIT = 1500;
  const ACTION_WAIT_LIMIT_MS = 5000;
  const SENSITIVE_URL_PARAM_PATTERN = /token|key|secret|code|session|csrf|nonce/i;

  // ─── Message Handler ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'getPageSnapshot' || msg.action === 'getPageSnapshot') {
      try {
        sendResponse(getPageSnapshot());
      } catch (err) {
        sendResponse({ url: redactSnapshotUrl(location.href), title: document.title, error: err.message });
      }
      return true;
    }
    if (msg.type === 'executeActionPlan' || msg.action === 'executeActionPlan') {
      executeActionPlan(msg.actions).then(sendResponse).catch(err => {
        sendResponse({ ok: false, results: [], error: err.message });
      });
      return true;
    }
    if (msg.action === 'executeSubmit') {
      executeSubmit(msg.config, msg.platformType, msg.taskIndex).then(sendResponse);
      return true; // keep channel open for async
    }
    if (msg.action === 'finalizeSubmit') {
      finalizeSubmit(msg.config, msg.taskIndex).then(sendResponse);
      return true;
    }
    if (msg.action === 'trySubmit') {
      // User clicked "继续填表" from overlay banner
      removeWaitingBanner();
      executeSubmit(msg.config, msg.platformType, msg.taskIndex).then(sendResponse);
      return true;
    }
  });

  // Page loaded notification
  setTimeout(() => {
    const mode = identifyPlatform();
    chrome.runtime.sendMessage({
      action: 'contentReady',
      mode: mode || 'unknown',
    }).catch(() => {});
  }, 1500);

  // ─── Main Execution ───
  async function executeSubmit(config, platformType, taskIndex) {
    try {
      // Determine platform
      let platform = platformType;
      if (platform === 'auto' || !platform) {
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
        return { waiting: true, skipReason: '无表单 — 等待用户导航到提交页' };
      }

      // Execute platform-specific form filling
      const handler = PLATFORMS[platform];
      if (!handler) {
        return { error: 'unknown_platform', skipReason: '不支持的平台类型: ' + platform };
      }

      const result = await handler.submit(config);

      if (result && result.captcha) {
        // Mark captcha area and notify user
        highlightCaptchaArea();
        chrome.runtime.sendMessage({ action: 'log', msg: '🤖 请手动完成验证码', cls: 'warn' }).catch(()=>{});
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
      return { error: err.message, skipReason: '执行异常: ' + err.message };
    }
  }

  // ─── Platform Detection ───
  function identifyPlatform() {
    for (const [name, handler] of Object.entries(PLATFORMS)) {
      if (handler.match()) return name;
    }
    // Generic detection
    if (document.querySelector('textarea[name="comment"], #comment, textarea.comment')) return 'wp_comment';
    if (document.querySelector('input[name="url"], input[name="website"], input[name="pf_phpbb_website"]')) return 'profile';
    if (document.querySelector('form[action*="submit"], form[action*="add"], form.submit-tool')) return 'directory';
    if (document.querySelector('form') && hasLikelySubmissionFields()) return 'submission';
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
    if (location.href.includes('op=info') && document.querySelector('input[name="site"]')) return true;
    // Generic profile edit
    if (document.querySelector('input[name="url"]') &&
        (document.body.textContent.includes('profile') || document.body.textContent.includes('Profile'))) return true;
    if (document.querySelector('input[name="website"]') &&
        (document.body.textContent.includes('Edit') || document.body.textContent.includes('Settings'))) return true;
    return false;
  }

  function detectWPComment() {
    return !!document.querySelector(
      '#commentform, form.comment-form, textarea[name="comment"], #comment, ' +
      '.comment-respond, .wp-block-comments'
    );
  }

  function detectForum() {
    if (document.querySelector('#pf_phpbb_website, input[name="pf_phpbb_website"]')) return true;
    if (document.querySelector('input[name="site"]')) return true;
    if (document.querySelector('.profile') && document.querySelector('input[name="url"]')) return true;
    return false;
  }

  function detectDirectory() {
    // SaaS directory submission forms
    const body = document.body.textContent;
    const hasDirectoryKeyword = /submit.*tool|submit.*product|submit.*startup|submit.*saas|add.*tool|add.*product|list.*startup|list.*product|get listed/i.test(body);
    const hasUrlField = !!document.querySelector(
      'input[name="url"], input[name="website"], input[name="link"], ' +
      'input[name="product_url"], input[type="url"], input[placeholder*="https"], ' +
      'input[placeholder*="URL" i], input[placeholder*="website" i]'
    );
    const hasDirectoryForm = !!document.querySelector('form[action*="submit"], form[action*="add"], form.submit-tool');
    const hasProductFields = !!document.querySelector(
      'input[name="product_name"], input[name="tool_name"], input[name="title"], ' +
      'textarea[name="description"], textarea[name="summary"]'
    );

    if (hasDirectoryForm && (hasUrlField || hasProductFields)) return true;
    if (hasDirectoryKeyword && hasUrlField) return true;
    return false;
  }

  function detectArticleComment() {
    // Article/blog comment forms (non-WP)
    return !!document.querySelector(
      'form[action*="comment"], form[action*="post"], ' +
      '.comment-form:not(.wp-block-comments), ' +
      '#comment-form:not(#commentform)'
    );
  }

  function detectSubmissionForm() {
    return !!document.querySelector(
      'form[action*="submit"], form[action*="contact"], form[action*="send"]'
    ) || (!!document.querySelector('form') && hasLikelySubmissionFields());
  }

  function hasLikelySubmissionFields() {
    return !!document.querySelector(
      'input[type="url"], input[type="email"], input[name*="url" i], input[id*="url" i], ' +
      'input[name*="website" i], input[id*="website" i], input[name*="link" i], input[id*="link" i], ' +
      'input[name*="product" i], input[id*="product" i], input[name*="title" i], input[id*="title" i], ' +
      'textarea[name*="description" i], textarea[id*="description" i], textarea[name*="message" i]'
    );
  }

  // ─── Waiting banner overlay (injected into page DOM) ───
  function showWaitingBanner(config, platformType, taskIndex) {
    if (document.getElementById('__extlink_wait_banner')) return;

    const banner = document.createElement('div');
    banner.id = '__extlink_wait_banner';
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

    document.getElementById('__extlink_go_btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'manualSubmit',
        taskIndex: taskIndex,
        config: config,
        platformType: platformType,
      });
    });
    document.getElementById('__extlink_skip_btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'manualSkip',
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
          action: 'manualSubmit',
          taskIndex: taskIndex,
          config: config,
          platformType: platformType,
        });
      }
    }, 2000);
  }

  function removeWaitingBanner() {
    const banner = document.getElementById('__extlink_wait_banner');
    if (banner) banner.remove();
    if (window.__extlink_waitPoll) {
      clearInterval(window.__extlink_waitPoll);
      delete window.__extlink_waitPoll;
    }
  }

  function findSubmissionLink() {
    const candidates = Array.from(document.querySelectorAll('a[href], area[href]'))
      .map(link => scoreSubmissionLink(link))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    return candidates[0] || null;
  }

  function scoreSubmissionLink(link) {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
      return null;
    }

    let url;
    try {
      url = new URL(href, location.href);
    } catch (e) {
      return null;
    }

    if (!/^https?:$/.test(url.protocol)) return null;
    if (url.href.replace(/#.*$/, '') === location.href.replace(/#.*$/, '')) return null;

    const label = getElementLabel(link);
    const path = `${url.pathname} ${url.search}`.toLowerCase().replace(/[-_]/g, ' ');
    const haystack = `${label} ${path}`;

    const negativeTerms = [
      'login', 'log in', 'signin', 'sign in', 'privacy', 'terms', 'cookie',
      'pricing', 'newsletter', 'facebook', 'twitter', 'linkedin', 'instagram',
      'youtube', 'github', 'discord', 'rss',
    ];
    if (negativeTerms.some(term => haystack.includes(term))) return null;

    const strongTerms = [
      'submit your', 'add your', 'list your', 'get listed', 'submit tool',
      'submit product', 'submit startup', 'submit saas', 'add tool',
      'add product', 'add startup', 'list product', 'list startup',
      'post your', 'share your', 'contribute',
    ];
    const mediumTerms = [
      'submit', 'submission', 'add', 'list', 'post', 'create', 'register',
      'join', 'publish', 'upload', 'new product', 'new tool',
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
      label: (link.textContent || link.getAttribute('aria-label') || url.pathname || url.href).trim().slice(0, 80),
      score,
    };
  }

  // ==============================
  //  SUBMISSION HANDLERS
  // ==============================

  function logStep(msg) {
    chrome.runtime.sendMessage({ action: 'log', msg, cls: '' }).catch(() => {});
  }

  // ─── Profile Link Submission ───
  async function submitProfileLink(config) {
    logStep('🔍 检测到个人资料页 — 查找 URL 字段…');
    const selectors = [
      '#pf_phpbb_website',
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
      logStep('❌ 未找到 URL 输入框');
      return { error: 'no_url_field', skipReason: '未找到 URL 输入框' };
    }

    logStep(`✏️ 填充外链 → ${config.targetDomain}`);
    // phpBB needs pressSequentially simulation
    if (input.name === 'pf_phpbb_website') {
      await simulateTyping(input, config.targetDomain);
    } else {
      input.value = config.targetDomain;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Try to find and click submit
    const submitBtn = findSubmitButton(
      'input[type="submit"], button[type="submit"], input[name="submit"], input[value*="Save"], input[value*="Update"]',
      ['save', 'update', 'submit']
    );

    if (submitBtn) {
      logStep('🚀 点击提交…');
      submitBtn.click();
      await sleep(3000);
    } else {
      logStep('⚠️ 未找到提交按钮，已填字段请手动提交');
      return { manual: true, platform: 'profile', reason: 'no_submit_button' };
    }

    return { ok: true, platform: 'profile' };
  }

  // ─── WordPress Comment Submission ───
  async function submitWPComment(config) {
    logStep('🔍 检测到 WordPress 评论表单');
    // Step 1: Fill author name
    const authorField = document.querySelector(
      '#author, input[name="author"], input[name*="author"], ' +
      'input[aria-label*="Name"], input[placeholder*="name" i], input[placeholder*="Name"]'
    );
    if (authorField) {
      logStep(`✏️ 填写作者名 → ${config.username}`);
      await simulateTyping(authorField, config.username);
    }

    // Step 2: Fill email
    const emailField = document.querySelector(
      '#email, input[name="email"], input[type="email"], ' +
      'input[aria-label*="Email"], input[placeholder*="email" i], input[placeholder*="Email"]'
    );
    if (emailField) {
      logStep(`✏️ 填写邮箱 → ${config.email}`);
      await simulateTyping(emailField, config.email);
    }

    // Step 3: Fill URL (link goes HERE, not in body - Akismet bypass)
    const urlField = document.querySelector(
      '#url, input[name="url"], input[name="website"], ' +
      'input[aria-label*="Website"], input[placeholder*="website" i]'
    );
    if (urlField) {
      logStep(`✏️ 填写外链 → ${config.targetDomain}`);
      await simulateTyping(urlField, config.targetDomain);
    }

    // Step 4: Generate comment text (no URL in body!)
    const commentText = generateComment(config);
    const commentField = document.querySelector(
      '#comment, textarea[name="comment"], textarea.comment, ' +
      'textarea[aria-label*="Comment"], textarea[placeholder*="comment" i]'
    );
    if (commentField) {
      logStep('✏️ 填写评论文本…');
      await simulateTyping(commentField, commentText);
    }

    // Step 5: Check for captcha before submitting
    if (detectCaptcha()) {
      logStep('🤖 检测到验证码 — 请手动完成');
      highlightCaptchaArea();
      return { captcha: true };
    }

    // Step 6: Submit
    const submitBtn = findSubmitButton(
      '#submit, input[type="submit"][name="submit"], button[type="submit"], input.comment-submit, button.comment-submit, .form-submit input[type="submit"]',
      ['post comment', 'submit', 'comment']
    );
    if (submitBtn) {
      logStep('🚀 提交评论…');
      submitBtn.click();
      await sleep(3000);
    } else {
      logStep('⚠️ 未找到评论提交按钮，已填字段请手动提交');
      return { manual: true, platform: 'wp_comment', reason: 'no_submit_button' };
    }

    return { ok: true, platform: 'wp_comment' };
  }

  // ─── Forum Profile Link ───
  async function submitForumProfile(config) {
    logStep('🔍 检测到论坛个人资料页 — 查找 URL 字段…');
    // Try phpBB website field first
    let input = document.querySelector(
      '#pf_phpbb_website, input[name="pf_phpbb_website"]'
    );

    // Discuz site field
    if (!input) input = document.querySelector('input[name="site"]');

    // Generic
    if (!input) input = document.querySelector('input[name="url"], input[name="website"]');

    if (!input) {
      logStep('❌ 未找到论坛个人信息字段');
      return { error: 'no_forum_field', skipReason: '未找到论坛个人信息字段' };
    }

    logStep(`✏️ 填充外链 → ${config.targetDomain}`);
    await simulateTyping(input, config.targetDomain);
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const submitBtn = findSubmitButton(
      'input[name="submit"], button[type="submit"], input[type="submit"]',
      ['submit', 'save', 'update']
    );
    if (submitBtn) {
      logStep('🚀 点击提交…');
      submitBtn.click();
      await sleep(3000);
    } else {
      logStep('⚠️ 未找到提交按钮，已填字段请手动提交');
      return { manual: true, platform: 'forum', reason: 'no_submit_button' };
    }

    return { ok: true, platform: 'forum' };
  }

  // ─── SaaS Directory Submission ───
  async function submitDirectoryLink(config) {
    logStep('🔍 检测到目录提交表单');
    let filledCount = 0;
    // Fill URL
    let urlInput = document.querySelector(
      'input[type="url"], input[name="url"], input[name="website"], input[name="link"], ' +
      'input[id*="url" i], input[id*="website" i], input[id*="link" i], ' +
      'input[placeholder*="URL" i], input[placeholder*="url" i], ' +
      'input[placeholder*="website" i], input[placeholder*="https"], input[name="product_url"]'
    );
    if (urlInput) {
      logStep(`✏️ 填写链接 → ${config.targetDomain}`);
      await simulateTyping(urlInput, config.targetDomain);
      filledCount++;
    }

    // Fill name/title
    let nameInput = document.querySelector(
      'input[name="name"], input[name="title"], input[name="tool_name"], ' +
      'input[name="product_name"], input[id*="name" i], input[id*="title" i], ' +
      'input[id*="product" i], input[placeholder*="name" i], input[placeholder*="title" i]'
    );
    if (nameInput) {
      logStep(`✏️ 填写名称 → ${config.brandName}`);
      await simulateTyping(nameInput, config.brandName);
      filledCount++;
    }

    // Fill description if exists
    let descInput = document.querySelector(
      'textarea[name="description"], textarea[name="desc"], ' +
      'textarea[placeholder*="description" i], textarea[name="summary"], ' +
      'textarea[id*="description" i], textarea[id*="summary" i], textarea[id*="message" i]'
    );
    if (descInput) {
      logStep('✏️ 填写描述…');
      const desc = config.commentTemplate || generateDescription(config);
      await simulateTyping(descInput, desc);
      filledCount++;
    }

    // Fill tags
    let tagInput = document.querySelector(
      'input[name="tags"], input[name="categories"], input[placeholder*="tag" i]'
    );
    if (tagInput) {
      logStep('✏️ 填写标签 → productivity,tools,software');
      await simulateTyping(tagInput, 'productivity,tools,software');
      filledCount++;
    }

    if (filledCount === 0) {
      const submissionLink = findSubmissionLink();
      if (submissionLink) {
        logStep(`🔗 当前页没有可填字段，打开提交入口: ${submissionLink.label}`);
        return { navigating: true, url: submissionLink.url, label: submissionLink.label };
      }
      return { error: 'no_directory_fields', skipReason: '未找到目录提交字段' };
    }

    if (detectCaptcha()) {
      logStep('🤖 检测到验证码 — 请手动完成');
      highlightCaptchaArea();
      return { captcha: true };
    }

    const submitBtn = findSubmitButton(
      'button[type="submit"], input[type="submit"]',
      ['submit', 'add', 'list', 'publish']
    );
    if (submitBtn) {
      logStep('🚀 提交目录…');
      submitBtn.click();
      await sleep(3000);
    } else {
      logStep('⚠️ 未找到目录提交按钮，已填字段请手动提交');
      return { manual: true, platform: 'directory', reason: 'no_submit_button' };
    }

    return { ok: true, platform: 'directory' };
  }

  // ─── Article Comment Submission ───
  async function submitArticleComment(config) {
    logStep('🔍 检测到文章评论表单');
    // Similar to WP but with generic selectors
    const nameField = document.querySelector(
      'input[name="author"], input[name="name"], ' +
      'input[placeholder*="name" i], input[placeholder*="Name"]'
    );
    if (nameField) {
      logStep(`✏️ 填写名称 → ${config.username}`);
      await simulateTyping(nameField, config.username);
    }

    const emailField = document.querySelector(
      'input[name="email"], input[type="email"], ' +
      'input[placeholder*="email" i], input[placeholder*="Email"]'
    );
    if (emailField) {
      logStep(`✏️ 填写邮箱 → ${config.email}`);
      await simulateTyping(emailField, config.email);
    }

    const urlField = document.querySelector(
      'input[name="url"], input[name="website"], ' +
      'input[placeholder*="website" i], input[placeholder*="URL"]'
    );
    if (urlField) {
      logStep(`✏️ 填写外链 → ${config.targetDomain}`);
      await simulateTyping(urlField, config.targetDomain);
    }

    const commentField = document.querySelector(
      'textarea[name="comment"], textarea.comment, ' +
      'textarea[name="body"], textarea[placeholder*="comment" i]'
    );
    if (commentField) {
      logStep('✏️ 填写评论文本…');
      await simulateTyping(commentField, generateComment(config));
    }

    if (detectCaptcha()) {
      logStep('🤖 检测到验证码 — 请手动完成');
      highlightCaptchaArea();
      return { captcha: true };
    }

    const submitBtn = findSubmitButton(
      'input[type="submit"], button[type="submit"]',
      ['post', 'submit', 'comment']
    );
    if (submitBtn) {
      logStep('🚀 提交评论…');
      submitBtn.click();
      await sleep(3000);
    } else {
      logStep('⚠️ 未找到评论提交按钮，已填字段请手动提交');
      return { manual: true, platform: 'article', reason: 'no_submit_button' };
    }

    return { ok: true, platform: 'article' };
  }

  // ─── Generic Form Submission ───
  async function submitGenericForm(config) {
    logStep('🔍 检测到通用提交表单');
    let filledCount = 0;
    // Fill all visible text inputs with relevant data
    const inputs = document.querySelectorAll(
      'input[type="text"], input[type="url"], input[type="email"], input:not([type])'
    );
    for (const input of inputs) {
      if (!isFillableField(input)) continue;
      const name = getFieldHint(input);
      if (name.includes('url') || name.includes('website') || name.includes('link')) {
        await simulateTyping(input, config.targetDomain);
        filledCount++;
      } else if (name.includes('name') || name.includes('author')) {
        await simulateTyping(input, config.username);
        filledCount++;
      } else if (name.includes('email')) {
        await simulateTyping(input, config.email);
        filledCount++;
      } else if (name.includes('title') || name.includes('subject')) {
        await simulateTyping(input, config.brandName);
        filledCount++;
      } else if (input.type === 'url') {
        await simulateTyping(input, config.targetDomain);
        filledCount++;
      } else if (input.type === 'email') {
        await simulateTyping(input, config.email);
        filledCount++;
      }
    }

    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      if (!isFillableField(ta)) continue;
      const name = getFieldHint(ta);
      if (name.includes('comment') || name.includes('body') || name.includes('message')) {
        await simulateTyping(ta, generateComment(config));
        filledCount++;
      } else if (name.includes('desc') || name.includes('summary')) {
        await simulateTyping(ta, config.commentTemplate || generateDescription(config));
        filledCount++;
      }
    }

    logStep(`✏️ 填充了 ${filledCount} 个字段`);
    if (filledCount === 0) {
      return { error: 'no_fillable_fields', skipReason: '未找到可自动填写字段' };
    }

    if (detectCaptcha()) {
      logStep('🤖 检测到验证码 — 请手动完成');
      highlightCaptchaArea();
      return { captcha: true };
    }

    const submitBtn = findSubmitButton(
      'input[type="submit"], button[type="submit"], button[name="submit"], input[name="submit"]',
      ['submit', 'send', 'save', 'publish']
    );
    if (submitBtn) {
      logStep('🚀 提交表单…');
      submitBtn.click();
      await sleep(3000);
    } else {
      logStep('⚠️ 未找到提交按钮，已填字段请手动提交');
      return { manual: true, platform: 'generic', reason: 'no_submit_button' };
    }

    return { ok: true, platform: 'generic' };
  }

  // ─── Finalize After Captcha ───
  async function finalizeSubmit(config, taskIndex) {
    // Click submit button
    const submitBtn = findSubmitButton(
      'input[type="submit"], button[type="submit"], #submit, .form-submit input',
      ['submit', 'post', 'save']
    );
    if (submitBtn) {
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

    const fields = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(isRelevantSnapshotElement)
      .map(snapshotField);
    const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="reset"], a[href], [role="button"]'))
      .filter(isRelevantSnapshotElement)
      .map(snapshotButton);
    const forms = Array.from(document.querySelectorAll('form'))
      .filter(form => isVisible(form) && !form.closest('[aria-hidden="true"]'))
      .map(form => {
        const formFields = Array.from(form.querySelectorAll('input, textarea, select'))
          .filter(isRelevantSnapshotElement)
          .map(extSelector)
          .filter(Boolean);
        const formButtons = Array.from(form.querySelectorAll('button, input[type="button"], input[type="submit"], input[type="reset"], a[href], [role="button"]'))
          .filter(isRelevantSnapshotElement)
          .map(extSelector)
          .filter(Boolean);

        return {
          selector: extSelector(form),
          id: form.id || '',
          name: form.getAttribute('name') || '',
          action: redactSnapshotUrl(form.getAttribute('action') || ''),
          method: (form.getAttribute('method') || 'get').toLowerCase(),
          fields: formFields,
          buttons: formButtons,
        };
      });

    return {
      url: redactSnapshotUrl(location.href),
      title: document.title || '',
      text: compactText(document.body ? document.body.innerText : '', SNAPSHOT_TEXT_LIMIT),
      forms,
      fields,
      buttons,
      meta: {
        platform: identifyPlatform() || 'unknown',
        hasCaptcha: detectCaptcha(),
        fieldCount: fields.length,
        buttonCount: buttons.length,
        formCount: forms.length,
      },
    };
  }

  function assignStableSelectors() {
    const elements = Array.from(document.querySelectorAll(
      'form, input, textarea, select, button, input[type="button"], input[type="submit"], input[type="reset"], a[href], [role="button"]'
    ));
    let counter = 1;

    for (const element of elements) {
      if (!isRelevantSnapshotElement(element) && element.tagName.toLowerCase() !== 'form') continue;
      if (element.hasAttribute(SNAPSHOT_SELECTOR_ATTR)) continue;

      let value;
      do {
        value = `${SNAPSHOT_SELECTOR_PREFIX}-${counter}`;
        counter++;
      } while (document.querySelector(`[${SNAPSHOT_SELECTOR_ATTR}="${cssEscape(value)}"]`));

      element.setAttribute('data-extlink-selector', value);
    }
  }

  function extSelector(element) {
    if (!element || !element.getAttribute) return '';

    const stable = element.getAttribute(SNAPSHOT_SELECTOR_ATTR);
    if (stable) return `[${SNAPSHOT_SELECTOR_ATTR}="${cssEscape(stable)}"]`;

    if (element.id && document.querySelectorAll(`#${cssEscape(element.id)}`).length === 1) {
      return `#${cssEscape(element.id)}`;
    }

    const tag = element.tagName.toLowerCase();
    const safeAttributes = ['name', 'aria-label', 'placeholder', 'title', 'role', 'type'];
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
    const type = (element.getAttribute('type') || tag).toLowerCase();
    const label = getSnapshotLabel(element);
    const valueInfo = getSnapshotValueInfo(element, type);

    return {
      selector: extSelector(element),
      tag,
      type,
      name: element.getAttribute('name') || '',
      id: element.id || '',
      label,
      placeholder: element.getAttribute('placeholder') || '',
      aria: element.getAttribute('aria-label') || '',
      required: !!element.required || element.getAttribute('aria-required') === 'true',
      disabled: !!element.disabled || element.getAttribute('aria-disabled') === 'true',
      visible: isVisible(element),
      value: valueInfo,
    };
  }

  function snapshotButton(element) {
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || (tag === 'a' ? 'link' : 'button')).toLowerCase();

    return {
      selector: extSelector(element),
      tag,
      type,
      text: compactText([element.innerText, element.textContent, element.value].filter(Boolean).join(' '), 160),
      aria: element.getAttribute('aria-label') || '',
      title: element.getAttribute('title') || '',
      disabled: !!element.disabled || element.getAttribute('aria-disabled') === 'true',
      visible: isVisible(element),
      href: redactSnapshotUrl(element.href || element.getAttribute('href') || ''),
    };
  }

  function isRelevantSnapshotElement(element) {
    if (!element || !element.matches) return false;
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    if (!isVisible(element)) return false;

    const tag = element.tagName.toLowerCase();
    if (tag === 'form') return true;
    if (tag === 'textarea' || tag === 'select' || tag === 'button') return true;
    if (tag === 'a') {
      const href = element.getAttribute('href') || '';
      return !!href && !href.startsWith('#') && !/^javascript:/i.test(href) && compactText(getElementLabel(element), 80).length > 0;
    }
    if (element.getAttribute('role') === 'button') return true;
    if (tag !== 'input') return false;

    const type = (element.getAttribute('type') || 'text').toLowerCase();
    return !['hidden', 'image', 'file'].includes(type);
  }

  async function executeActionPlan(actions) {
    if (!Array.isArray(actions)) {
      return {
        ok: false,
        results: [{ ok: false, error: 'actions must be an array' }],
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
      ok: results.every(result => result.ok),
      results,
    };
  }

  async function executeModelAction(action) {
    switch (action.type) {
      case 'fill': {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, 'selector not found');
        if (!isActionElementAllowed(element, action.type)) return actionFailure(action, 'action target is not allowed');
        if (element.disabled || element.readOnly) return actionFailure(action, 'field is disabled or readonly');
        element.focus();
        setFieldValue(element, action.value == null ? '' : action.value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selector: action.selector };
      }
      case 'click': {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, 'selector not found');
        if (!isActionElementAllowed(element, action.type)) return actionFailure(action, 'action target is not allowed');
        if (element.disabled || element.getAttribute('aria-disabled') === 'true') return actionFailure(action, 'element is disabled');
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        element.click();
        return { ok: true, selector: action.selector };
      }
      case 'select': {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, 'selector not found');
        if (!isActionElementAllowed(element, action.type)) return actionFailure(action, 'action target is not allowed');
        if (element.tagName.toLowerCase() !== 'select') return actionFailure(action, 'selector is not a select');
        if (element.disabled) return actionFailure(action, 'select is disabled');
        if (!setSelectValue(element, action.value)) return actionFailure(action, 'select option not found');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selector: action.selector };
      }
      case 'check': {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, 'selector not found');
        if (!isActionElementAllowed(element, action.type)) return actionFailure(action, 'action target is not allowed');
        if (!['checkbox', 'radio'].includes((element.type || '').toLowerCase())) {
          return actionFailure(action, 'selector is not checkable');
        }
        if (element.disabled) return actionFailure(action, 'field is disabled');
        setCheckedValue(element, action.value !== false && action.checked !== false);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selector: action.selector };
      }
      case 'submit': {
        const element = resolveActionElement(action);
        if (!element) return actionFailure(action, 'selector not found');
        if (!isActionElementAllowed(element, action.type)) return actionFailure(action, 'action target is not allowed');
        const form = element.tagName.toLowerCase() === 'form' ? element : element.closest('form');
        if (form && typeof form.requestSubmit === 'function') {
          form.requestSubmit(isSubmitControl(element) ? element : undefined);
          return { ok: true, selector: action.selector, submitted: 'requestSubmit' };
        }
        if (form && element === form) {
          const submitter = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
          if (submitter) {
            submitter.click();
            return { ok: true, selector: action.selector, submitted: 'click' };
          }
        }
        element.click();
        return { ok: true, selector: action.selector, submitted: 'click' };
      }
      case 'wait': {
        const requestedMs = action.timeout_ms ?? action.ms ?? action.duration ?? 0;
        const parsedMs = Number(requestedMs);
        const ms = Number.isFinite(parsedMs) ? Math.max(0, Math.min(parsedMs, ACTION_WAIT_LIMIT_MS)) : 0;
        await sleep(ms);
        return { ok: true, waitedMs: ms };
      }
      default:
        return { ok: false, error: `unsupported action type: ${action.type || 'missing'}` };
    }
  }

  // ==============================
  //  HELPERS
  // ==============================

  // ─── Simulate human typing (Antispam Bee bypass) ───
  async function simulateTyping(element, text) {
    if (!element || !text) return;
    element.focus();
    setFieldValue(element, '');
    element.dispatchEvent(new Event('focus', { bubbles: true }));

    // Type character by character with realistic delays
    let value = '';
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const keydown = new KeyboardEvent('keydown', {
        key: char, bubbles: true, cancelable: true,
        keyCode: char.charCodeAt(0), which: char.charCodeAt(0)
      });
      const keypress = new KeyboardEvent('keypress', {
        key: char, bubbles: true, cancelable: true,
        keyCode: char.charCodeAt(0), which: char.charCodeAt(0)
      });
      const inputEvent = new InputEvent('input', {
        data: char, bubbles: true, inputType: 'insertText'
      });

      element.dispatchEvent(keydown);
      element.dispatchEvent(keypress);
      value += char;
      setFieldValue(element, value);
      element.dispatchEvent(inputEvent);

      // Random delay 30-120ms (human typing speed)
      await sleep(30 + Math.random() * 90);
    }

    element.dispatchEvent(new Event('keyup', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
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
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
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
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    return descriptor && descriptor.set;
  }

  function setSelectValue(element, value) {
    const desired = String(value == null ? '' : value);
    const normalizedDesired = normalizeOptionText(desired);
    const options = Array.from(element.options || []);
    let option = options.find(option => option.value === desired);

    if (!option) {
      option = options.find(option => (
        normalizeOptionText(option.textContent) === normalizedDesired ||
        normalizeOptionText(option.label) === normalizedDesired
      ));
    }

    if (!option) return false;
    setFieldValue(element, option.value);
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
      selector: action.selector || '',
      error,
    };
  }

  function isActionElementAllowed(element, actionType) {
    if (!element || !element.matches) return false;
    if (!element.hasAttribute(SNAPSHOT_SELECTOR_ATTR)) return false;
    if (element.closest('[aria-hidden="true"], [hidden]')) return false;
    if (!isVisible(element)) return false;

    const tag = element.tagName.toLowerCase();
    const disabled = !!element.disabled || element.getAttribute('aria-disabled') === 'true';
    if (disabled && actionType !== 'wait') return false;

    if (actionType === 'fill') {
      return (tag === 'input' || tag === 'textarea') && !['hidden', 'file', 'image', 'submit', 'button', 'reset', 'checkbox', 'radio'].includes((element.type || '').toLowerCase());
    }
    if (actionType === 'select') return tag === 'select';
    if (actionType === 'check') return tag === 'input' && ['checkbox', 'radio'].includes((element.type || '').toLowerCase());
    if (actionType === 'submit') return tag === 'form' || isSubmitControl(element) || !!element.closest('form');
    if (actionType === 'click') {
      return tag === 'button' || tag === 'a' || element.getAttribute('role') === 'button' ||
        ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase());
    }

    return false;
  }

  function isSubmitControl(element) {
    if (!element || !element.tagName) return false;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute('type') || '').toLowerCase();
    return (tag === 'button' && (!type || type === 'submit')) || (tag === 'input' && (type === 'submit' || type === 'image'));
  }

  function redactSnapshotUrl(url) {
    const raw = String(url || '');
    if (!raw) return '';

    try {
      const parsed = new URL(raw, location.href);
      parsed.hash = '';
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (SENSITIVE_URL_PARAM_PATTERN.test(key)) {
          parsed.searchParams.set(key, 'REDACTED');
        }
      }
      return parsed.toString();
    } catch (e) {
      return compactText(raw.split('#')[0], 300)
        .replace(/(^|[?&\s])((?:token|key|secret|code|session|csrf|nonce)[^=\s&]*=)[^&\s]*/gi, '$1$2REDACTED');
    }
  }

  function compactText(text, limit) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function getSnapshotLabel(element) {
    const labels = [];
    if (element.id) {
      labels.push(...Array.from(document.querySelectorAll(`label[for="${cssEscape(element.id)}"]`)).map(label => label.textContent));
    }
    const wrappingLabel = element.closest('label');
    if (wrappingLabel) labels.push(wrappingLabel.textContent);
    labels.push(
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('title'),
      element.textContent
    );
    return compactText(labels.filter(Boolean).join(' '), 180);
  }

  function getSnapshotValueInfo(element, type) {
    if (type === 'password') {
      return { present: !!element.value, kind: 'secret' };
    }
    if (type === 'checkbox' || type === 'radio') {
      return { checked: !!element.checked, kind: 'checked' };
    }
    if (element.tagName.toLowerCase() === 'select') {
      return {
        present: !!element.value,
        kind: 'select',
        selectedLabel: compactText(element.selectedOptions && element.selectedOptions[0] ? element.selectedOptions[0].textContent : '', 80),
      };
    }
    return {
      present: !!element.value,
      kind: type || 'text',
      length: element.value ? String(element.value).length : 0,
    };
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function nthOfTypeSelector(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const index = Array.from(parent.children)
        .filter(child => child.tagName.toLowerCase() === tag)
        .indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
      current = parent;
    }
    return parts.length ? parts.join(' > ') : element.tagName.toLowerCase();
  }

  function getFieldHint(element) {
    return [
      element.name,
      element.id,
      element.type,
      element.getAttribute('aria-label'),
      element.getAttribute('placeholder'),
      element.getAttribute('autocomplete'),
      element.closest('label') && element.closest('label').textContent,
    ].filter(Boolean).join(' ').toLowerCase();
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
    if (document.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="captcha"], .grecaptcha-badge')) return true;
    // hCaptcha
    if (document.querySelector('.h-captcha, iframe[src*="hcaptcha"]')) return true;
    // Cloudflare Turnstile
    if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare"]')) return true;
    // Image captcha
    if (document.querySelector('img[src*="captcha"], img.captcha, img[alt*="captcha" i]')) return true;
    // Generic captcha input
    if (document.querySelector('input[name*="captcha"], input[id*="captcha"], input[placeholder*="captcha" i]')) return true;
    // Math captcha
    if (document.querySelector('input[name*="math"], input[name*="spam"]')) return true;
    // OTP / Verification code
    if (document.querySelector('input[name*="code"], input[name*="otp"], input[name*="verification"], input[name*="emailCode"]')) return true;

    return false;
  }

  function highlightCaptchaArea() {
    const captchaEl = document.querySelector(
      '.g-recaptcha, .h-captcha, iframe[src*="captcha"], iframe[src*="recaptcha"], ' +
      'img[src*="captcha"], .captcha'
    );
    if (captchaEl) {
      captchaEl.style.outline = '4px solid #eab308';
      captchaEl.style.outlineOffset = '4px';
      captchaEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function findSubmitButton(selector, textMatches) {
    const directMatch = safeQuerySelector(selector);
    if (directMatch && isVisible(directMatch)) return directMatch;

    const labels = textMatches.map(text => text.toLowerCase());
    const candidates = Array.from(document.querySelectorAll(
      'button, input[type="submit"], input[type="button"], a[role="button"], .button, .btn'
    ));

    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const label = getElementLabel(el);
      return labels.some(text => label.includes(text));
    }) || null;
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
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
      el.id,
      el.name,
    ].filter(Boolean).join(' ').trim().toLowerCase();
  }

  function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ─── Rel Verification ───
  async function verifyRel(domain) {
    const domainClean = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const result = { isDofollow: false, rel: 'not_found', links: [] };

    // Wait for page updates after submission
    await sleep(2000);

    const links = document.querySelectorAll(`a[href*="${domainClean}"]`);
    if (links.length === 0) {
      result.rel = 'not_found';
      return result;
    }

    let allDofollow = true;
    for (const link of links) {
      const rel = (link.rel || '').trim();
      result.links.push({ href: link.href, rel });
      if (rel.includes('nofollow') || rel.includes('ugc') || rel.includes('sponsored')) {
        allDofollow = false;
      }
    }

    result.isDofollow = allDofollow && links.length > 0;
    result.rel = links.map(l => l.rel || 'EMPTY').join('|');
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
    return `${config.brandName} is a productivity tool that helps teams work more efficiently. Features include task automation, real-time collaboration, and seamless integrations with popular platforms.`;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─── Auto-resume after captcha (polling) ───
  // Check periodically if captcha is gone (user solved it)
  if (detectCaptcha()) {
    const checkInterval = setInterval(() => {
      if (!detectCaptcha()) {
        clearInterval(checkInterval);
        // Notify background that captcha is resolved
        chrome.runtime.sendMessage({
          action: 'captchaResolved',
        }).catch(() => {});
      }
    }, 3000);
  }

})();
