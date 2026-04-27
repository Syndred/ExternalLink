"""
Interactive Semi-Auto Submission Mode

Browser opens VISIBLE (not headless).
For each candidate:
  1. Navigate to site
  2. Analyze page, fill all form fields
  3. PAUSE - user solves captcha / human verification
  4. User presses Enter → system clicks submit
  5. Verify rel, write to DB
  6. Next candidate
"""

import asyncio
import json
import time
import random
import sys
from pathlib import Path
from datetime import datetime
from typing import Optional

from .browser import BrowserController, CommentGenerator
from .db import (
    get_candidates, insert_submitted_link,
    log_attempt, get_connection
)
from .submitter import SkillKnowledge


class InteractiveSubmitter:
    """
    One-by-one interactive submission.
    Each candidate: navigate → fill → pause → submit → verify → next.
    """

    def __init__(self, browser: BrowserController, site_config: dict):
        self.browser = browser
        self.config = site_config
        self.site_id = site_config['site_id']
        self.domain = site_config.get('domain', '')
        self.anchor = site_config.get('default_anchor', '')
        self.brand_name = site_config.get('brand_name', self.domain)
        self.brand_description = site_config.get('brand_description', '')

        self.results = {'total': 0, 'success': 0, 'dofollow': 0, 'skipped': 0, 'failed': 0}
        self.paused = False  # True when waiting for user input

    async def run(self):
        """Main interactive loop"""
        print_line()
        print(f"  INTERACTIVE SEMI-AUTO MODE")
        print(f"  Site: [{self.site_id}] {self.brand_name} ({self.domain})")
        print(f"  Anchor: {self.anchor}")
        print_line()
        print()
        print("  HOW IT WORKS:")
        print("    1. I open a candidate site")
        print("    2. I fill ALL form fields")
        print("    3. I pause → you solve captcha/human verification")
        print("    4. You press ENTER → I click submit")
        print("    5. I verify the link and write to database")
        print()
        print("  Commands during pause:")
        print("    [Enter]   = Submit & continue")
        print("    s         = Skip this site")
        print("    q         = Quit entirely")
        print()

        input("  Press ENTER to start...")

        # Load candidates
        candidates = get_candidates(self.site_id, limit=200)
        candidates.sort(key=lambda c: c.get('traffic', 0), reverse=True)

        print(f"\n  Loaded {len(candidates)} candidates. Let's go!\n")
        self.results['total'] = len(candidates)

        for i, candidate in enumerate(candidates):
            domain = candidate['domain']
            traffic = candidate.get('traffic', 0)
            dr = candidate.get('dr', 0)
            platform_type = candidate.get('platform_type', 'unknown')
            url = candidate.get('url', f'https://{domain}')

            print_line()
            print(f"  [{i+1}/{len(candidates)}] {domain}")
            print(f"        Traffic: {traffic}  |  DR: {dr}  |  Type: {platform_type}")
            print(f"        URL: {url}")
            print_line()

            # Check if already done
            if self._already_done(domain):
                print(f"  [SKIP] Already submitted previously")
                self.results['skipped'] += 1
                continue

            try:
                result = await self._process_one(domain, url, platform_type, traffic)
            except KeyboardInterrupt:
                print("\n\n  [!] User interrupted. Saving progress...")
                break
            except Exception as e:
                print(f"  [ERROR] {e}")
                log_attempt(self.site_id, domain, 'failed', platform_type, url, error_msg=str(e)[:200])
                self.results['failed'] += 1

        # Summary
        print_line()
        print(f"  COMPLETE!")
        print(f"  Total: {self.results['total']}  |  Success: {self.results['success']}  |  "
              f"Dofollow: {self.results['dofollow']}  |  Skipped: {self.results['skipped']}  |  Failed: {self.results['failed']}")
        print_line()

    async def _process_one(self, domain: str, url: str, platform_type: str, traffic: int) -> Optional[str]:
        """Process one candidate end-to-end with interactive pauses"""

        # Step 1: Navigate
        print(f"  [1/5] Navigating to {url}...")
        try:
            await self.browser.navigate(url)
            await asyncio.sleep(3)
        except Exception as e:
            print(f"  [DEAD] Cannot reach page: {e}")
            log_attempt(self.site_id, domain, 'dead', platform_type, url, error_msg=str(e)[:200])
            self.results['failed'] += 1
            return None

        print(f"  [2/5] Analyzing page structure...")
        await asyncio.sleep(1)

        # Step 2: Analyze and fill all fields
        filled = await self._fill_all_fields(domain, platform_type, url)

        if not filled:
            print(f"  [NO-FORM] No fillable form found.")
            choice = await self._user_choice(f"  [{domain}] No form detected. Skip?")
            if choice == 'quit':
                raise KeyboardInterrupt()
            self.results['skipped'] += 1
            log_attempt(self.site_id, domain, 'no_form_found', platform_type, url)
            return None

        # Step 3: Pause for user
        print(f"\n  ╔══════════════════════════════════════════════╗")
        print(f"  ║  ALL FIELDS FILLED                           ║")
        print(f"  ║  Solve captcha / human verification now!     ║")
        print(f"  ║  Then press ENTER to submit                  ║")
        print(f"  ╚══════════════════════════════════════════════╝")
        print(f"  [3/5] WAITING for you...")

        choice = await self._user_choice(f"  [{domain}] Ready to submit?")

        if choice == 'quit':
            raise KeyboardInterrupt()
        elif choice == 'skip':
            print(f"  [SKIP] User chose to skip")
            self.results['skipped'] += 1
            log_attempt(self.site_id, domain, 'skipped_user', platform_type, url)
            return None

        # Step 4: Click submit
        print(f"  [4/5] Clicking submit...")
        submitted = await self._click_submit()

        if not submitted:
            print(f"  [FAIL] Could not submit. Moving on.")
            self.results['failed'] += 1
            log_attempt(self.site_id, domain, 'submit_failed', platform_type, url)
            return None

        await asyncio.sleep(2)
        submitted_url = self.browser.page.url
        print(f"  [OK] Submitted! Now at: {submitted_url[:80]}")

        # Step 5: Verify rel
        print(f"  [5/5] Checking rel attribute...")
        rel_results = await self.browser.check_rel(self.domain)
        rel_value = 'nofollow'
        if rel_results:
            for r in rel_results:
                if r.get('rel') == 'EMPTY':
                    rel_value = 'dofollow'
                    break
                rel_value = r.get('rel', 'nofollow')

        is_dofollow = rel_value == 'dofollow'
        print(f"  [REL] {rel_value.upper()} {'✅ DOFOLLOW!' if is_dofollow else '❌ nofollow'}")

        # Write to DB
        link_id = insert_submitted_link(
            site_id=self.site_id,
            domain=domain,
            url=submitted_url,
            platform_type=platform_type,
            anchor_text=self.anchor,
            rel=rel_value,
            traffic=traffic,
            status='success'
        )
        print(f"  [DB] Saved as link #{link_id}")

        self.results['success'] += 1
        if is_dofollow:
            self.results['dofollow'] += 1

        return submitted_url

    async def _fill_all_fields(self, domain: str, platform_type: str, url: str) -> bool:
        """Analyze page and fill every form field found. Returns True if anything was filled."""

        # Get page structure
        try:
            page_text = await self.browser.page.evaluate("() => document.body.innerText")
        except:
            page_text = ""

        # Detect anti-spam system
        spam_system = 'Unknown'
        page_lower = page_text.lower()
        if 'akismet' in page_lower:
            spam_system = 'Akismet'
        elif 'antispam bee' in page_lower or 'antispambee' in page_lower:
            spam_system = 'Antispam Bee'
        elif 'wpantispam' in page_lower:
            spam_system = 'WPantispam Protect'
        elif 'cleantalk' in page_lower:
            spam_system = 'CleanTalk'
        elif 'hcaptcha' in page_lower:
            spam_system = 'hCaptcha'

        print(f"  [DETECT] Anti-spam: {spam_system}")

        if spam_system == 'CleanTalk':
            print(f"  [SKIP] CleanTalk cannot be bypassed")
            return False

        # Get all inputs on the page
        try:
            inputs_js = await self.browser.page.evaluate("""() => {
                const inputs = document.querySelectorAll('input, textarea, select');
                return Array.from(inputs).map(el => ({
                    tag: el.tagName.toLowerCase(),
                    name: el.name || '',
                    id: el.id || '',
                    type: el.type || '',
                    placeholder: el.placeholder || '',
                    required: el.required || false,
                    visible: el.offsetParent !== null
                }));
            }""")
        except:
            inputs_js = []

        # Filter visible inputs
        visible_inputs = [i for i in inputs_js if i['visible']]

        # Categorize inputs
        author_fields = []
        email_fields = []
        url_fields = []
        comment_fields = []
        name_fields = []
        title_fields = []
        desc_fields = []
        tag_fields = []
        submit_buttons = []
        other_fields = []

        for inp in visible_inputs:
            name = (inp['name'] + ' ' + inp['id'] + ' ' + inp['placeholder']).lower()
            tag = inp['tag']
            itype = inp['type']

            if itype in ('submit', 'button') or 'submit' in name:
                submit_buttons.append(inp)
                continue

            if tag == 'textarea' or ('comment' in name) or ('message' in name and 'author' not in name):
                comment_fields.append(inp)
            elif any(kw in name for kw in ['author', 'writer']):
                author_fields.append(inp)
            elif 'email' in name:
                email_fields.append(inp)
            elif any(kw in name for kw in ['url', 'website', 'homepage', 'blog_url', 'link']):
                url_fields.append(inp)
            elif any(kw in name for kw in ['title', 'headline', 'subject']):
                title_fields.append(inp)
            elif any(kw in name for kw in ['description', 'desc', 'about', 'summary', 'bio', 'info']):
                desc_fields.append(inp)
            elif any(kw in name for kw in ['tag', 'keyword', 'category', 'label']):
                tag_fields.append(inp)
            elif any(kw in name for kw in ['firstname', 'lastname', 'fullname', 'name', 'nickname', 'display_name', 'realname']):
                name_fields.append(inp)
            else:
                other_fields.append(inp)

        # Also find buttons
        try:
            buttons_js = await self.browser.page.evaluate("""() => {
                const btns = document.querySelectorAll('button, input[type="submit"], [role="button"]');
                return Array.from(btns).map(el => ({
                    text: (el.textContent || el.value || '').trim().substring(0, 50),
                    visible: el.offsetParent !== null,
                    id: el.id || '',
                    className: el.className || ''
                }));
            }""")
        except:
            buttons_js = []

        visible_buttons = [b for b in buttons_js if b['visible']]

        filled_anything = False

        # Decide what kind of form this is
        is_comment_form = bool(comment_fields) or (author_fields and email_fields)
        is_profile_form = bool(url_fields) and not comment_fields and not title_fields
        is_directory_form = bool(url_fields) and (name_fields or title_fields) and not comment_fields
        is_article_form = bool(title_fields) and comment_fields

        if is_comment_form:
            print(f"  [FORM] WordPress comment form detected")
        elif is_profile_form:
            print(f"  [FORM] Profile/website URL form detected")
        elif is_directory_form:
            print(f"  [FORM] Directory submission form detected")
        elif is_article_form:
            print(f"  [FORM] Article editor detected")

        # Generate content
        comment_data = CommentGenerator.generate()
        profile_email = self.config.get('anti_spam_email', f'user_{random.randint(1000,9999)}@gmail.com')

        # --- FILL FIELDS ---
        fill_tasks = []

        # Author fields
        for inp in author_fields + name_fields[:1]:  # Only fill first name field
            fill_tasks.append((inp, comment_data['author']))

        # Email fields
        for inp in email_fields:
            fill_tasks.append((inp, profile_email))

        # URL fields - KEY: put our domain here
        for inp in url_fields:
            fill_tasks.append((inp, f'https://{self.domain}'))

        # Comment/content fields
        for inp in comment_fields:
            fill_tasks.append((inp, comment_data['comment']))

        # Title fields
        for inp in title_fields:
            article_title = f"How to Use {self.brand_name} Effectively - Tips & Guide"
            fill_tasks.append((inp, article_title))

        # Description fields
        for inp in desc_fields:
            fill_tasks.append((inp, self.brand_description or f'{self.brand_name} - {self.anchor}'))

        # Tag fields
        for inp in tag_fields:
            fill_tasks.append((inp, self.config.get('tags', 'tool,ai,free')))

        # Other fields - fill with generic values
        for inp in other_fields:
            name_lower = (inp.get('name', '') + inp.get('id', '')).lower()
            if 'password' in name_lower:
                fill_tasks.append((inp, 'Password123!'))
            elif 'username' in name_lower or 'login' in name_lower:
                fill_tasks.append((inp, f'user_{random.randint(10000,99999)}'))
            elif 'phone' in name_lower or 'tel' in name_lower:
                fill_tasks.append((inp, f'{random.randint(200,999)}{random.randint(100,999)}{random.randint(1000,9999)}'))
            elif 'company' in name_lower or 'organization' in name_lower:
                fill_tasks.append((inp, self.brand_name))
            elif any(kw in name_lower for kw in ['city', 'location', 'country']):
                fill_tasks.append((inp, 'New York'))
            elif 'captcha' in name_lower:
                # Skip captcha fields - leave for user
                pass
            else:
                fill_tasks.append((inp, 'General info'))

        print(f"  [FILL] Found {len(fill_tasks)} fields to fill...")

        step = 0
        for inp, value in fill_tasks:
            step += 1
            selector = self._make_selector(inp)
            if not selector:
                continue

            try:
                label = inp.get('name', '') or inp.get('id', '') or inp.get('placeholder', '') or 'field'
                # Use pressSequentially for textareas (anti Antispam Bee)
                if inp.get('tag') == 'textarea' or 'comment' in (inp.get('name', '') + inp.get('id', '')).lower():
                    await self.browser.press_sequentially(selector, value)
                    print(f"  [{step}/{len(fill_tasks)}] Typed '{label}' ({len(value)} chars)")
                else:
                    el = self.browser.page.locator(selector).first
                    if await el.count() > 0:
                        await el.click()
                        await el.fill('')
                        await el.fill(value)
                        print(f"  [{step}/{len(fill_tasks)}] Filled '{label}' = '{value[:60]}'")
                filled_anything = True
            except Exception as e:
                print(f"  [{step}/{len(fill_tasks)}] Failed '{inp.get('name','?')}': {str(e)[:50]}")

        # Try to check consent/agree checkboxes
        try:
            checkboxes = await self.browser.page.evaluate("""() => {
                const cbs = document.querySelectorAll('input[type="checkbox"]');
                return Array.from(cbs).map(cb => ({
                    id: cb.id,
                    name: cb.name,
                    label: cb.closest('label')?.textContent?.trim() || '',
                    checked: cb.checked,
                    visible: cb.offsetParent !== null
                }));
            }""")
            for cb in checkboxes:
                if cb['visible'] and not cb['checked']:
                    text = (cb['label'] + cb['name'] + cb['id']).lower()
                    if any(kw in text for kw in ['agree', 'terms', 'consent', 'accept', 'policy', 'privacy']):
                        sel = f'#{cb["id"]}' if cb['id'] else f'input[name="{cb["name"]}"]'
                        await self.browser.page.locator(sel).first.check()
                        print(f"  [OK] Checked consent checkbox")
                        filled_anything = True
                        break
        except:
            pass

        # Store submit button info for later
        self._submit_selectors = []
        for btn in submit_buttons:
            if btn.get('id'):
                self._submit_selectors.append(f'#{btn["id"]}')
            if btn.get('name'):
                self._submit_selectors.append(f'[name="{btn["name"]}"]')
            if btn.get('type'):
                self._submit_selectors.append(f'input[type="{btn["type"]}"]')

        # Also find submit buttons
        self._button_selectors = []
        for btn in visible_buttons:
            text = btn['text'].lower()
            if any(kw in text for kw in ['submit', 'post', 'save', 'publish', 'add', 'create', 'register', 'sign up', 'join']):
                if btn.get('id'):
                    self._button_selectors.append(f'#{btn["id"]}')
                else:
                    self._button_selectors.append(f'button:has-text("{btn["text"]}")')

        # Fallback selectors
        self._fallback_submit = [
            'input[type="submit"]', 'button[type="submit"]',
            '#submit', '.submit', '[name="submit"]',
            'button:has-text("Post Comment")', 'button:has-text("Submit")',
            'button:has-text("Save")', 'button:has-text("Publish")',
            'button:has-text("Add")', 'button:has-text("Create")',
            'button:has-text("Register")', 'button:has-text("Sign Up")',
        ]

        return filled_anything

    async def _click_submit(self) -> bool:
        """Click the submit button"""
        all_selectors = self._submit_selectors + self._button_selectors + self._fallback_submit

        for sel in all_selectors:
            try:
                btn = self.browser.page.locator(sel).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click()
                    print(f"  [CLICK] Clicked: {sel}")
                    await asyncio.sleep(3)
                    return True
            except:
                continue

        # Last resort: try pressing Enter on the form
        try:
            await self.browser.page.keyboard.press('Enter')
            print(f"  [CLICK] Pressed Enter (last resort)")
            await asyncio.sleep(3)
            return True
        except:
            pass

        print(f"  [WARN] No submit button found!")
        return False

    def _make_selector(self, inp: dict) -> Optional[str]:
        """Create a CSS selector for an input element"""
        if inp.get('id'):
            sel = f'#{inp["id"]}'
            # Verify it's unique enough
            return sel
        if inp.get('name'):
            return f'[name="{inp["name"]}"]'
        if inp.get('placeholder'):
            return f'[placeholder="{inp["placeholder"]}"]'
        if inp.get('type') and inp.get('tag') == 'input':
            return f'input[type="{inp["type"]}"]'
        return inp.get('tag', 'input')

    async def _user_choice(self, prompt_text: str) -> str:
        """
        Wait for user input.
        Returns: 'submit', 'skip', or 'quit'
        """
        while True:
            try:
                choice = input(f"{prompt_text} [Enter=submit / s=skip / q=quit]: ").strip().lower()
                if choice == '':
                    return 'submit'
                if choice in ('s', 'skip'):
                    return 'skip'
                if choice in ('q', 'quit', 'exit'):
                    return 'quit'
                print("  Invalid choice. [Enter]=submit, s=skip, q=quit")
            except (EOFError, KeyboardInterrupt):
                return 'quit'

    def _already_done(self, domain: str) -> bool:
        """Check domain-level dedup"""
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) FROM submitted_links WHERE domain = ? AND site_id = ? AND status = 'success'",
            (domain, self.site_id)
        )
        count = cursor.fetchone()[0]
        conn.close()
        return count > 0


def print_line():
    print("=" * 60)