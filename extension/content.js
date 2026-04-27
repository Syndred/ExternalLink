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

  // ─── Message Handler ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'executeSubmit') {
      executeSubmit(msg.config, msg.platformType, msg.taskIndex).then(sendResponse);
      return true; // keep channel open for async
    }
    if (msg.action === 'finalizeSubmit') {
      finalizeSubmit(msg.config, msg.taskIndex).then(sendResponse);
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
      // Block anti-spam systems
      injectAntiSpamBypass();

      // Determine platform
      let platform = platformType;
      if (platform === 'auto' || !platform) {
        platform = identifyPlatform();
      }

      if (!platform) {
        return { error: 'no_platform_match', skipReason: '无法识别平台类型' };
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
    if (/submit.*tool|submit.*product|submit.*startup|submit.*saas|add.*tool|add.*product/i.test(body)) return true;
    if (document.querySelector('form[action*="submit"], form[action*="add"]') &&
        (document.querySelector('input[name="url"], input[name="website"]'))) return true;
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
    );
  }

  // ==============================
  //  SUBMISSION HANDLERS
  // ==============================

  // ─── Profile Link Submission ───
  async function submitProfileLink(config) {
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
      return { error: 'no_url_field', skipReason: '未找到 URL 输入框' };
    }

    // phpBB needs pressSequentially simulation
    if (input.name === 'pf_phpbb_website') {
      await simulateTyping(input, config.targetDomain);
    } else {
      input.value = config.targetDomain;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Try to find and click submit
    const submitBtn = document.querySelector(
      'input[type="submit"], button[type="submit"], ' +
      'button:has-text("Save"), button:has-text("Update"), ' +
      'input[name="submit"], input[value*="Save"], input[value*="Update"]'
    );

    if (submitBtn) {
      submitBtn.click();
      await sleep(3000);
    }

    return { ok: true, platform: 'profile' };
  }

  // ─── WordPress Comment Submission ───
  async function submitWPComment(config) {
    // Step 1: Fill author name
    const authorField = document.querySelector(
      '#author, input[name="author"], input[name*="author"], ' +
      'input[aria-label*="Name"], input[placeholder*="name" i], input[placeholder*="Name"]'
    );
    if (authorField) {
      await simulateTyping(authorField, config.username);
    }

    // Step 2: Fill email
    const emailField = document.querySelector(
      '#email, input[name="email"], input[type="email"], ' +
      'input[aria-label*="Email"], input[placeholder*="email" i], input[placeholder*="Email"]'
    );
    if (emailField) {
      await simulateTyping(emailField, config.email);
    }

    // Step 3: Fill URL (link goes HERE, not in body - Akismet bypass)
    const urlField = document.querySelector(
      '#url, input[name="url"], input[name="website"], ' +
      'input[aria-label*="Website"], input[placeholder*="website" i]'
    );
    if (urlField) {
      await simulateTyping(urlField, config.targetDomain);
    }

    // Step 4: Generate comment text (no URL in body!)
    const commentText = generateComment(config);
    const commentField = document.querySelector(
      '#comment, textarea[name="comment"], textarea.comment, ' +
      'textarea[aria-label*="Comment"], textarea[placeholder*="comment" i]'
    );
    if (commentField) {
      await simulateTyping(commentField, commentText);
    }

    // Step 5: Check for captcha before submitting
    if (detectCaptcha()) {
      return { captcha: true };
    }

    // Step 6: Submit
    const submitBtn = document.querySelector(
      '#submit, input[type="submit"][name="submit"], ' +
      'button[type="submit"], input.comment-submit, ' +
      'button.comment-submit, .form-submit input[type="submit"]'
    );
    if (submitBtn) {
      submitBtn.click();
      await sleep(3000);
    }

    return { ok: true, platform: 'wp_comment' };
  }

  // ─── Forum Profile Link ───
  async function submitForumProfile(config) {
    // Try phpBB website field first
    let input = document.querySelector(
      '#pf_phpbb_website, input[name="pf_phpbb_website"]'
    );

    // Discuz site field
    if (!input) input = document.querySelector('input[name="site"]');

    // Generic
    if (!input) input = document.querySelector('input[name="url"], input[name="website"]');

    if (!input) return { error: 'no_forum_field', skipReason: '未找到论坛个人信息字段' };

    await simulateTyping(input, config.targetDomain);
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const submitBtn = document.querySelector(
      'input[name="submit"], button[type="submit"], ' +
      'input[type="submit"], button:has-text("Submit"), button:has-text("Save")'
    );
    if (submitBtn) {
      submitBtn.click();
      await sleep(3000);
    }

    return { ok: true, platform: 'forum' };
  }

  // ─── SaaS Directory Submission ───
  async function submitDirectoryLink(config) {
    // Fill URL
    let urlInput = document.querySelector(
      'input[name="url"], input[name="website"], input[name="link"], ' +
      'input[placeholder*="URL"], input[placeholder*="url"], ' +
      'input[placeholder*="https"], input[name="product_url"]'
    );
    if (urlInput) {
      await simulateTyping(urlInput, config.targetDomain);
    }

    // Fill name/title
    let nameInput = document.querySelector(
      'input[name="name"], input[name="title"], input[name="tool_name"], ' +
      'input[name="product_name"], input[placeholder*="name" i]'
    );
    if (nameInput) {
      await simulateTyping(nameInput, config.brandName);
    }

    // Fill description if exists
    let descInput = document.querySelector(
      'textarea[name="description"], textarea[name="desc"], ' +
      'textarea[placeholder*="description" i], textarea[name="summary"]'
    );
    if (descInput) {
      const desc = config.commentTemplate || generateDescription(config);
      await simulateTyping(descInput, desc);
    }

    // Fill tags
    let tagInput = document.querySelector(
      'input[name="tags"], input[name="categories"], input[placeholder*="tag" i]'
    );
    if (tagInput) {
      await simulateTyping(tagInput, 'productivity,tools,software');
    }

    if (detectCaptcha()) return { captcha: true };

    const submitBtn = document.querySelector(
      'button[type="submit"], input[type="submit"], ' +
      'button:has-text("Submit"), button:has-text("Add"), ' +
      'button:has-text("List"), button:has-text("Publish")'
    );
    if (submitBtn) {
      submitBtn.click();
      await sleep(3000);
    }

    return { ok: true, platform: 'directory' };
  }

  // ─── Article Comment Submission ───
  async function submitArticleComment(config) {
    // Similar to WP but with generic selectors
    const nameField = document.querySelector(
      'input[name="author"], input[name="name"], ' +
      'input[placeholder*="name" i], input[placeholder*="Name"]'
    );
    if (nameField) await simulateTyping(nameField, config.username);

    const emailField = document.querySelector(
      'input[name="email"], input[type="email"], ' +
      'input[placeholder*="email" i], input[placeholder*="Email"]'
    );
    if (emailField) await simulateTyping(emailField, config.email);

    const urlField = document.querySelector(
      'input[name="url"], input[name="website"], ' +
      'input[placeholder*="website" i], input[placeholder*="URL"]'
    );
    if (urlField) await simulateTyping(urlField, config.targetDomain);

    const commentField = document.querySelector(
      'textarea[name="comment"], textarea.comment, ' +
      'textarea[name="body"], textarea[placeholder*="comment" i]'
    );
    if (commentField) await simulateTyping(commentField, generateComment(config));

    if (detectCaptcha()) return { captcha: true };

    const submitBtn = document.querySelector(
      'input[type="submit"], button[type="submit"], ' +
      'button:has-text("Post"), button:has-text("Submit"), ' +
      'button:has-text("Comment")'
    );
    if (submitBtn) {
      submitBtn.click();
      await sleep(3000);
    }

    return { ok: true, platform: 'article' };
  }

  // ─── Generic Form Submission ───
  async function submitGenericForm(config) {
    // Fill all visible text inputs with relevant data
    const inputs = document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])');
    for (const input of inputs) {
      const name = (input.name || input.id || '').toLowerCase();
      if (name.includes('url') || name.includes('website') || name.includes('link')) {
        await simulateTyping(input, config.targetDomain);
      } else if (name.includes('name') || name.includes('author')) {
        await simulateTyping(input, config.username);
      } else if (name.includes('email')) {
        await simulateTyping(input, config.email);
      } else if (name.includes('title') || name.includes('subject')) {
        await simulateTyping(input, config.brandName);
      }
    }

    const textareas = document.querySelectorAll('textarea');
    for (const ta of textareas) {
      const name = (ta.name || ta.id || '').toLowerCase();
      if (name.includes('comment') || name.includes('body') || name.includes('message')) {
        await simulateTyping(ta, generateComment(config));
      } else if (name.includes('desc') || name.includes('summary')) {
        await simulateTyping(ta, config.commentTemplate || generateDescription(config));
      }
    }

    if (detectCaptcha()) return { captcha: true };

    const submitBtn = document.querySelector(
      'input[type="submit"], button[type="submit"], ' +
      'button[name="submit"], input[name="submit"]'
    );
    if (submitBtn) {
      submitBtn.click();
      await sleep(3000);
    }

    return { ok: true, platform: 'generic' };
  }

  // ─── Finalize After Captcha ───
  async function finalizeSubmit(config, taskIndex) {
    // Click submit button
    const submitBtn = document.querySelector(
      'input[type="submit"], button[type="submit"], ' +
      '#submit, .form-submit input, button:has-text("Submit"), ' +
      'button:has-text("Post"), button:has-text("Save")'
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

  // ==============================
  //  HELPERS
  // ==============================

  // ─── Simulate human typing (Antispam Bee bypass) ───
  async function simulateTyping(element, text) {
    if (!element || !text) return;
    element.focus();
    element.value = '';
    element.dispatchEvent(new Event('focus', { bubbles: true }));

    // Type character by character with realistic delays
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
      element.value += char;
      element.dispatchEvent(inputEvent);

      // Random delay 30-120ms (human typing speed)
      await sleep(30 + Math.random() * 90);
    }

    element.dispatchEvent(new Event('keyup', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true }));
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

  // ─── Anti-spam bypass ───
  function injectAntiSpamBypass() {
    // Neutralize common anti-spam listeners that detect bot filling
    // (Some plugins watch for too-fast input field changes)
    // We already use simulateTyping with delays, so this is a safety net.

    // Override common spam detection functions
    const overrides = `
      if (typeof window.akismet_check !== 'undefined') {
        const _akismet = window.akismet_check;
        window.akismet_check = function(...args) { return true; };
      }
      if (typeof window.antispam_validate !== 'undefined') {
        const _aspam = window.antispam_validate;
        window.antispam_validate = function(...args) { return true; };
      }
    `;

    try {
      const script = document.createElement('script');
      script.textContent = overrides;
      (document.head || document.documentElement).appendChild(script);
    } catch(e) { /* ignore CSP errors */ }
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