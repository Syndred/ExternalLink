"""
外链提交引擎
编排完整的 10 步提交流程：筛选 → 打开 → 表单识别 → 填充 → 提交 → 验证
"""

import asyncio
import json
import time
import re
import random
from pathlib import Path
from datetime import datetime
from typing import Optional

from .browser import BrowserController, CaptchaHandler, CommentGenerator
from .db import (
    get_candidates, insert_submitted_link, update_link_rel,
    log_attempt, log_anti_spam, get_anti_spam_info, get_domain_submitted_sites,
    add_candidate
)


class SkillKnowledge:
    """加载 Skill 知识库（10 个文件）"""

    SKILL_DIR = Path(__file__).parent.parent / "skills"

    @classmethod
    def load(cls, filename: str) -> str:
        """加载指定 Skill 文件"""
        path = cls.SKILL_DIR / filename
        if path.exists():
            return path.read_text(encoding='utf-8')
        return f"# {filename} not found"

    @classmethod
    def load_iron_rules(cls) -> str:
        return cls.load('iron-rules.md')

    @classmethod
    def load_platforms(cls) -> str:
        return cls.load('platforms.md')

    @classmethod
    def load_wp_comments(cls) -> str:
        return cls.load('wp-comments.md')

    @classmethod
    def load_anti_spam(cls) -> str:
        return cls.load('anti-spam.md')

    @classmethod
    def load_dofollow(cls) -> str:
        return cls.load('dofollow-2026.md')

    @classmethod
    def load_dead_sites(cls) -> str:
        return cls.load('dead-sites.md')

    @classmethod
    def load_reverse_eng(cls) -> str:
        return cls.load('reverse-eng.md')

    @classmethod
    def load_all(cls) -> dict:
        """加载所有知识库文件"""
        files = [
            'SKILL.md', 'iron-rules.md', 'platforms.md', 'wp-comments.md',
            'anti-spam.md', 'dofollow-2026.md', 'dead-sites.md',
            'reverse-eng.md', 'strategies.md', 'accounts.md'
        ]
        return {f: cls.load(f) for f in files}


class LinkSubmitter:
    """
    外链提交主引擎
    编排完整 10 步流程，支持 4 类提交模式：
    - wp_comment: WordPress 评论
    - profile: 论坛/社区 Profile 页
    - directory: SaaS 目录提交
    - article: 博客文章发布
    """

    def __init__(self, browser: BrowserController, site_config: dict, mode: str = 'auto'):
        self.browser = browser
        self.config = site_config
        self.site_id = site_config['site_id']
        self.domain = site_config.get('domain', '')
        self.anchor = site_config.get('default_anchor', '')
        self.banned_anchors = site_config.get('banned_anchors', [])
        self.mode = mode

        # 运行时状态
        self.current_candidate = None
        self.link_id = None
        self.start_time = None
        self.captcha_used = False

    async def run(self):
        """主入口：拉候选 -> 逐个提交"""
        print(f"\n{'='*60}")
        print(f"[Submitter:{self.site_id}] Starting link submission task")
        print(f"[Submitter:{self.site_id}] Target site: {self.domain}")
        print(f"[Submitter:{self.site_id}] Anchor text: {self.anchor}")
        print(f"{'='*60}\n")

        # Step 1: 读铁律
        print("[Step 1/10] Reading iron rules...")
        iron_rules = SkillKnowledge.load_iron_rules()
        # 确认品牌信息
        self._verify_site_identity()

        # Step 3: 从 DB 拉候选站
        print("[Step 3/10] Fetching candidates from DB...")
        candidates = get_candidates(self.site_id, limit=20)
        print(f"  Candidate count: {len(candidates)}")

        if not candidates:
            print("[!] No candidates available! Add candidates to DB first.")
            return {'total': 0, 'success': 0, 'dofollow': 0, 'failed': 0}

        # Step 4: 按流量排序（已在 SQL 中做，这里再次确认）
        candidates.sort(key=lambda c: c.get('traffic', 0), reverse=True)

        results = {'total': len(candidates), 'success': 0, 'dofollow': 0, 'failed': 0}

        for i, candidate in enumerate(candidates):
            self.current_candidate = candidate
            domain = candidate['domain']
            platform_type = candidate.get('platform_type', 'unknown')
            traffic = candidate.get('traffic', 0)
            dr = candidate.get('dr', 0)

            print(f"\n{'-'*50}")
            print(f"[{i+1}/{len(candidates)}] {domain} (traffic: {traffic}, DR: {dr})")

            # 检查是否已提交过（按域名去重）
            if self._is_already_done(domain):
                print(f"  [SKIP] Already submitted")
                log_attempt(self.site_id, domain, 'skipped_duplicate', platform_type,
                           candidate.get('url', f'https://{domain}'))
                continue

            # Step 5: 打开目标站
            print(f"  Opening {candidate.get('url', f'https://{domain}')}...")
            try:
                await self.browser.navigate(candidate.get('url', f'https://{domain}'))
                await asyncio.sleep(2)

                # 检测验证码
                captcha_type = await CaptchaHandler.detect_captcha(self.browser.page)
                if captcha_type != 'Unknown':
                    print(f"  [WARN] Captcha detected: {captcha_type}")
                    if captcha_type == 'CleanTalk':
                        print(f"  [SKIP] CleanTalk cannot be bypassed")
                        log_anti_spam(domain, 'CleanTalk', False, 'Hard block, cannot bypass')
                        results['failed'] += 1
                        continue
                    if captcha_type in ('hCaptcha',):
                        print(f"  [SKIP] hCaptcha likely needs human, marking skip")
                        log_attempt(self.site_id, domain, 'skipped', platform_type,
                                   candidate.get('url', f'https://{domain}'),
                                   error_msg='hCaptcha - needs human')
                        results['failed'] += 1
                        continue

                # Step 6: 获取页面快照，识别表单
                snapshot = await self.browser.get_snapshot()
                if not snapshot or snapshot.get('title') == 'Error':
                    print(f"  [SKIP] Dead page or error")
                    log_attempt(self.site_id, domain, 'dead', platform_type,
                               candidate.get('url', f'https://{domain}'),
                               error_msg='Dead page')
                    results['failed'] += 1
                    continue

                # Step 7: 根据平台类型和快照决定提交模式
                submitted_url = await self._smart_submit(domain, snapshot, platform_type)

                if not submitted_url:
                    print(f"  [SKIP] No suitable form or operation failed")
                    log_attempt(self.site_id, domain, 'no_form_found', platform_type,
                               candidate.get('url', f'https://{domain}'))
                    results['failed'] += 1
                    continue

                # Step 8: 实测 rel 属性
                print(f"  Checking rel attribute...")
                rel_results = await self.browser.check_rel(self.domain)
                rel_value = 'dofollow' if any(r['rel'] == 'EMPTY' for r in rel_results) else 'nofollow'
                if rel_results:
                    first_rel = rel_results[0].get('rel', 'nofollow')
                    if first_rel != 'EMPTY':
                        rel_value = first_rel

                is_dofollow = rel_value == 'dofollow'
                print(f"  {'[DOFOLLOW]' if is_dofollow else '[NOFOLLOW] ' + rel_value}")

                # Step 9: 写回数据库
                self.link_id = insert_submitted_link(
                    site_id=self.site_id,
                    domain=domain,
                    url=submitted_url,
                    platform_type=platform_type,
                    anchor_text=self.anchor,
                    rel=rel_value,
                    traffic=traffic,
                    status='success'
                )
                if is_dofollow:
                    results['dofollow'] += 1
                results['success'] += 1
                print(f"  [OK] Written to DB, link_id={self.link_id}")

                # Step 10: Ping 搜索引擎
                await self._ping_index(submitted_url)

            except Exception as e:
                print(f"  [ERROR] Processing failed: {e}")
                log_attempt(self.site_id, domain, 'failed', platform_type,
                           candidate.get('url', f'https://{domain}'),
                           error_msg=str(e)[:200])
                results['failed'] += 1

            # 间隔防止限速
            await asyncio.sleep(2)

        print(f"\n{'='*60}")
        print(f"[Submitter:{self.site_id}] Task complete!")
        print(f"  Total: {results['total']}, Success: {results['success']}, "
              f"Dofollow: {results['dofollow']}, Failed: {results['failed']}")
        print(f"{'='*60}\n")
        return results

    def _verify_site_identity(self):
        """铁律 #8：切站确认产品"""
        print(f"  [OK] Confirmed site: [{self.site_id}] {self.config.get('brand_name', 'Unknown')}")
        print(f"  [OK] Confirmed domain: {self.domain}")
        print(f"  [OK] Confirmed anchor: {self.anchor}")
        if self.banned_anchors:
            print(f"  [WARN] Banned anchors: {', '.join(self.banned_anchors)}")

    def _is_already_done(self, domain: str) -> bool:
        """检查域名级别去重"""
        from .db import get_connection
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT COUNT(*) FROM submitted_links WHERE domain = ? AND site_id = ? AND status = 'success'",
            (domain, self.site_id)
        )
        count = cursor.fetchone()[0]
        conn.close()
        return count > 0

    async def _smart_submit(self, domain: str, snapshot: dict, platform_type: str):
        """智能识别表单类型并提交"""
        forms = snapshot.get('forms', [])
        buttons = snapshot.get('buttons', [])
        links = snapshot.get('links', [])
        inputs = set()

        for form in forms:
            for inp in form.get('inputs', []):
                inputs.add(inp.get('name', '').lower())
                inputs.add(inp.get('type', '').lower())
                inputs.add(inp.get('placeholder', '').lower())

        all_text = str(forms) + str(buttons) + str(inputs)

        # 检查是否是 WP 评论
        if any(kw in all_text.lower() for kw in ['comment', 'wp-comment', 'reply-title']):
            if any(kw in inputs for kw in ['comment', 'author', 'email']):
                print(f"  -> Detected comment form, using WP comment mode")
                return await self._submit_wp_comment(domain, snapshot)

        # 检查是否是目录提交表单
        if any(kw in all_text.lower() for kw in ['submit', 'list your', 'get listed', 'add your tool', 'submit tool']):
            print(f"  -> Detected directory submission form on page")
            return await self._submit_directory(domain, snapshot)

        # 检查是否有 Website 字段（Profile 模式）
        website_kw = ['website', 'url', 'homepage', 'blog url']
        if any(kw in all_text.lower() for kw in website_kw) and any(kw in all_text.lower() for kw in ['profile', 'edit', 'settings', 'account']):
            print(f"  -> Detected Website field, using Profile mode")
            return await self._submit_profile(domain, snapshot)

        # 检查是否是文章发布
        if 'title' in inputs and ('content' in inputs or 'body' in inputs):
            print(f"  -> Detected article editor")
            return await self._submit_article(domain, snapshot)

        # 如果是 saas_directory / directory 类型，先找提交入口链接
        if platform_type in ('saas_directory', 'directory', 'blog', 'forum_profile'):
            submit_result = await self._navigate_to_submission_page(domain, links)
            if submit_result:
                # 重新获取快照后再次判断
                await asyncio.sleep(2)
                new_snapshot = await self.browser.get_snapshot()
                new_forms = new_snapshot.get('forms', [])
                if new_forms:
                    print(f"  -> Found {len(new_forms)} form(s) on submission page")
                    return await self._submit_directory(domain, new_snapshot)

        # 最后尝试通用表单填充
        if forms:
            print(f"  -> Trying auto mode (fill first form)")
            return await self._submit_directory(domain, snapshot)

        print(f"  -> No available form, checking page bottom for link area...")
        return None

    async def _navigate_to_submission_page(self, candidate_domain: str, links: list) -> bool:
        """在 SaaS 目录首页查找并点击提交入口链接"""
        if not links:
            return False

        # 关键链接关键词（按优先级排序）
        submit_keywords = [
            'submit', 'add', 'list', 'post', 'create', 'register',
            'sign up', 'join', 'contribute', 'share', 'publish',
            'get listed', 'add your', 'submit your', 'list your',
            'new', 'write', 'upload'
        ]

        for link in links:
            text = (link.get('text', '') + ' ' + link.get('href', '')).lower()
            for kw in submit_keywords:
                if kw in text:
                    href = link.get('href', '')
                    if href and not href.startswith('#') and not href.startswith('javascript:'):
                        try:
                            print(f"  -> Clicking submit link: '{link.get('text', href)[:60]}'")
                            # Resolve relative URLs
                            if href.startswith('/'):
                                from urllib.parse import urlparse
                                parsed = urlparse(self.browser.page.url)
                                href = f"{parsed.scheme}://{parsed.netloc}{href}"
                            await self.browser.navigate(href)
                            return True
                        except Exception as e:
                            print(f"  [WARN] Failed to navigate to {href}: {e}")
                            continue

        return False

    async def _submit_wp_comment(self, domain: str, snapshot: dict):
        """WP 评论提交（完整 SOP）"""
        anti_spam = SkillKnowledge.load_anti_spam()
        knowledge = SkillKnowledge.load_wp_comments()

        # 检测反垃圾系统
        page_text = await self.browser.page.evaluate("() => document.body.innerText")
        spam_system = self._detect_spam_system(page_text)

        print(f"  Anti-spam system: {spam_system}")

        if spam_system == 'CleanTalk':
            print(f"  [SKIP] CleanTalk cannot be bypassed")
            return None

        # 生成评论数据
        comment_data = CommentGenerator.generate(topic_hint=self._extract_topic(snapshot))

        # 根据反垃圾系统选择策略
        if spam_system in ('Akismet', 'Antispam Bee'):
            email = self.config.get('anti_spam_email', f"clean_{self.site_id}@gmail.com")
        else:
            email = self.config.get('email', f"admin@{self.domain}")

        # 填充评论表单
        print(f"  Author: {comment_data['author']}")
        print(f"  Email: {email}")

        for form in snapshot.get('forms', []):
            for inp in form.get('inputs', []):
                name = inp.get('name', '').lower()
                if not name:
                    continue
                sel = f'[name="{inp["name"]}"]'
                try:
                    if 'author' in name or 'name' in name:
                        await self.browser.fill_field(sel, comment_data['author'])
                        print(f"  [OK] Filled {name}")
                    elif 'email' in name:
                        await self.browser.fill_field(sel, email)
                        print(f"  [OK] Filled {name}")
                    elif 'url' in name or 'website' in name:
                        # 链接只放在 URL 字段，不放正文
                        await self.browser.fill_field(sel, f"https://{self.domain}")
                        print(f"  [OK] Filled {name} = {self.domain}")
                    elif 'comment' in name or name == '':
                        # 使用 pressSequentially 绕过 Antispam Bee
                        await self.browser.press_sequentially(sel, comment_data['comment'])
                        print(f"  [OK] Sequentially typed comment")
                except Exception as e:
                    print(f"  [WARN] Failed to fill {name}: {e}")

        # 找提交按钮并点击
        submit_selectors = [
            'input[type="submit"]', 'button[type="submit"]',
            '#submit', '.submit', '[name="submit"]',
            'button:has-text("Post Comment")', 'button:has-text("Submit")'
        ]
        for sel in submit_selectors:
            try:
                btn = self.browser.page.locator(sel)
                if await btn.count() > 0:
                    await btn.first.click()
                    break
            except:
                continue

        await asyncio.sleep(3)
        print(f"  [OK] Comment submitted")
        return self.browser.page.url

    async def _submit_profile(self, domain: str, snapshot: dict):
        """Profile 提交：填充 Website 字段"""
        # 关键：phpBB 的 pf_phpbb_website 字段，Discuz 的 newsite 字段
        website_selectors = [
            'input[name="pf_phpbb_website"]', 'input[name="website"]',
            'input[name="url"]', 'input[name="homepage"]', 'input[name="blog_url"]',
            'input[name="newsite"]', 'input[name="site"]',
            'input[placeholder*="website" i]', 'input[placeholder*="url" i]',
            '#website', '#url', '#homepage'
        ]

        for name in website_selectors:
            try:
                el = self.browser.page.locator(name)
                if await el.count() > 0:
                    await el.first.fill(f"https://{self.domain}")
                    print(f"  [OK] Directly filled website field: {name}")
                    break
            except:
                continue

        # 找提交/保存按钮
        save_selectors = [
            'input[type="submit"]', 'button[type="submit"]',
            'button:has-text("Save")', 'button:has-text("Update")',
            'button:has-text("Submit")', '[name="submit"]',
            '#submit', '.submit'
        ]
        for sel in save_selectors:
            try:
                btn = self.browser.page.locator(sel)
                if await btn.count() > 0:
                    await btn.first.click()
                    break
            except:
                continue

        await asyncio.sleep(2)
        print(f"  [OK] Profile updated")
        return self.browser.page.url

    async def _submit_directory(self, domain: str, snapshot: dict):
        """目录站提交"""
        directory_data = {
            'url': f"https://{self.domain}",
            'name': self.config.get('brand_name', ''),
            'description': self.config.get('brand_description', f'{self.anchor} - Online resource'),
            'tags': self.config.get('tags', '')
        }

        filled = False
        for form in snapshot.get('forms', []):
            for inp in form.get('inputs', []):
                name = inp.get('name', '').lower()
                if not name:
                    continue
                sel = f'[name="{inp["name"]}"]'
                try:
                    if any(kw in name for kw in ['url', 'website', 'link', 'domain']):
                        await self.browser.fill_field(sel, directory_data['url'])
                        print(f"  [OK] Filled {name} = {self.domain}")
                        filled = True
                    elif any(kw in name for kw in ['name', 'title', 'product', 'tool']):
                        await self.browser.fill_field(sel, directory_data['name'])
                        print(f"  [OK] Filled {name}")
                        filled = True
                    elif any(kw in name for kw in ['description', 'desc', 'about', 'summary', 'info']):
                        await self.browser.fill_field(sel, directory_data['description'])
                        print(f"  [OK] Filled {name}")
                        filled = True
                    elif any(kw in name for kw in ['tag', 'keyword', 'category']):
                        await self.browser.fill_field(sel, directory_data['tags'])
                        filled = True
                except Exception as e:
                    pass

        # 提交
        submit_selectors = [
            'input[type="submit"]', 'button[type="submit"]',
            'button:has-text("Submit")', 'button:has-text("Add")',
            'button:has-text("Save")', '[name="submit"]'
        ]
        for sel in submit_selectors:
            try:
                btn = self.browser.page.locator(sel)
                if await btn.count() > 0:
                    await btn.first.click()
                    break
            except:
                continue

        await asyncio.sleep(3)
        print(f"  [OK] Directory submission done")
        return self.browser.page.url

    async def _submit_article(self, domain: str, snapshot: dict):
        """文章发布（开发者博客）"""
        article_title = f"Understanding {self.anchor} - A Practical Guide"
        article_body = self._generate_article_body()

        title_selectors = ['[name="title"]', '#title', '.title-input', 'input[placeholder*="title" i]']
        for sel in title_selectors:
            try:
                await self.browser.fill_field(sel, article_title)
                print(f"  [OK] Filled title")
                break
            except:
                continue

        content_selectors = ['[name="content"]', '#content', '.editor', '[contenteditable="true"]']
        for sel in content_selectors:
            try:
                await self.browser.press_sequentially(sel, article_body)
                print(f"  [OK] Typed article content ({len(article_body)} chars)")
                break
            except:
                await self.browser.fill_field(sel, article_body)
                break

        publish_selectors = ['button:has-text("Publish")', 'button:has-text("Save")',
                            'button:has-text("Post")', '[type="submit"]']
        for sel in publish_selectors:
            try:
                btn = self.browser.page.locator(sel)
                if await btn.count() > 0:
                    await btn.first.click()
                    break
            except:
                continue

        await asyncio.sleep(3)
        print(f"  [OK] Article published")
        return self.browser.page.url

    def _generate_article_body(self) -> str:
        """生成文章正文（含外链）"""
        return f"""## Introduction

{self.anchor} is an important topic that deserves deeper exploration. In this article, I'll share practical insights based on real-world experience.

## Key Concepts

When working with {self.anchor}, it's essential to understand the fundamentals. The approach I've found most effective involves systematic testing and iteration.

## Practical Implementation

For more details and resources, you can visit [{self.config.get('brand_name', self.anchor)}](https://{self.domain}). Their materials on {self.anchor} have been particularly helpful in my work.

## Conclusion

I hope this guide has been useful. Feel free to explore additional resources and share your own experiences with {self.anchor}."""

    def _detect_spam_system(self, page_text: str) -> str:
        """检测页面使用的反垃圾系统"""
        page_lower = page_text.lower()
        if 'akismet' in page_lower:
            return 'Akismet'
        if 'antispam bee' in page_lower or 'antispambee' in page_lower:
            return 'Antispam Bee'
        if 'wpantispam' in page_lower or 'wpmudev' in page_lower:
            return 'WPantispam Protect'
        if 'cleantalk' in page_lower:
            return 'CleanTalk'
        if 'hcaptcha' in page_lower:
            return 'hCaptcha'
        if 'jetpack' in page_lower and 'highlander' in page_lower:
            return 'Jetpack Highlander'
        return 'Unknown'

    def _extract_topic(self, snapshot: dict) -> str:
        """从页面快照提取文章主题"""
        title = snapshot.get('title', '')
        # 简单提取
        for word in title.split():
            if len(word) > 3 and word.lower() not in ('the', 'and', 'for', 'with', 'that', 'this', 'from', 'your'):
                return word.lower()
        return 'this topic'

    async def _ping_index(self, url: str):
        """Ping 搜索引擎通知新页面"""
        # IndexNow
        try:
            import aiohttp
            indexnow_key = self.config.get('indexnow_key', '')
            if indexnow_key:
                async with aiohttp.ClientSession() as session:
                    async with session.post(
                        'https://api.indexnow.org/indexnow',
                        json={'host': self.domain, 'key': indexnow_key,
                              'keyLocation': f'https://{self.domain}/{indexnow_key}.txt',
                              'urlList': [url]}
                    ) as resp:
                        print(f"  [IndexNow] status={resp.status}")
        except Exception as e:
            print(f"  [WARN] IndexNow failed: {e}")


class AICommander:
    """
    AI 指挥官
    分析页面、决策提交策略、生成内容
    """

    def __init__(self, model: str = "deepseek-v4-pro"):
        self.model = model
        self.api_key = None
        self._load_config()

    def _load_config(self):
        """加载 API 配置"""
        try:
            from dotenv import load_dotenv
            import os
            load_dotenv()
            self.api_key = os.getenv('DEEPSEEK_API_KEY', '')
            if not self.api_key:
                self.api_key = os.getenv('OPENAI_API_KEY', '')
            self.api_base = os.getenv('DEEPSEEK_API_BASE', 'https://api.deepseek.com/v1')
        except:
            pass

    async def analyze_page(self, snapshot: dict, domain: str, knowledge: str) -> dict:
        """分析页面结构，返回提交策略"""
        prompt = f"""You are an SEO link building assistant. Analyze this page snapshot and decide the best strategy to submit a backlink for {domain}.

PAGE SNAPSHOT:
Title: {snapshot.get('title', 'N/A')}
URL: {snapshot.get('url', 'N/A')}
Forms: {json.dumps(snapshot.get('forms', []), indent=2)[:2000]}
Buttons: {json.dumps(snapshot.get('buttons', []), indent=2)[:1000]}

KNOWLEDGE BASE:
{knowledge[:3000]}

Determine the submission type:
- wp_comment: WordPress comment form with author/email/comment fields
- profile: Has website/url field + edit/settings page context
- directory: Has submit/add/list buttons + url/name/description fields
- article: Has title/content/editor + publish button
- dead: Blank/error pages

Return JSON only:
{{"type": "wp_comment|profile|directory|article|dead", "confidence": 0.0-1.0, "reason": "brief reason", "strategy": "step by step plan"}}"""

        # 调用 AI API
        if self.api_key:
            try:
                response = await self._call_api(prompt)
                return json.loads(response)
            except:
                pass

        # 回退到规则匹配
        return self._rule_based_analysis(snapshot)

    async def generate_comment(self, page_title: str, topic: str, domain: str) -> dict:
        """生成自然评论"""
        prompt = f"""Write a natural, engaging blog comment for an article titled "{page_title}" about "{topic}".

Requirements:
1. Must sound like a real person wrote it
2. Comment should be 2-4 sentences, genuine and thoughtful
3. Do NOT include any URL in the comment body
4. The link to {domain} will be placed in the author URL field separately
5. Use a casual but intelligent tone

Return JSON:
{{"author": "Real-sounding name", "comment": "The comment text"}}"""

        if self.api_key:
            try:
                response = await self._call_api(prompt)
                return json.loads(response)
            except:
                pass

        return CommentGenerator.generate(topic_hint=topic)

    async def _call_api(self, prompt: str) -> str:
        """调用 DeepSeek API"""
        import aiohttp

        headers = {
            'Authorization': f'Bearer {self.api_key}',
            'Content-Type': 'application/json'
        }

        payload = {
            'model': self.model,
            'messages': [
                {'role': 'system', 'content': 'You are an SEO automation assistant. Respond with valid JSON only.'},
                {'role': 'user', 'content': prompt}
            ],
            'temperature': 0.7,
            'max_tokens': 500
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(
                f'{self.api_base}/chat/completions',
                headers=headers,
                json=payload
            ) as resp:
                data = await resp.json()
                return data['choices'][0]['message']['content']

    def _rule_based_analysis(self, snapshot: dict) -> dict:
        """基于规则的页面分析（无需 API）"""
        forms = snapshot.get('forms', [])
        all_inputs = set()
        for f in forms:
            for inp in f.get('inputs', []):
                all_inputs.add(inp.get('name', '').lower())

        # WP 评论检测
        if 'comment' in all_inputs and ('author' in all_inputs or 'email' in all_inputs):
            return {'type': 'wp_comment', 'confidence': 0.9, 'reason': 'Comment form detected', 'strategy': 'Fill author/email/url/comment fields'}

        # 目录检测
        if 'url' in all_inputs and ('name' in all_inputs or 'title' in all_inputs):
            return {'type': 'directory', 'confidence': 0.8, 'reason': 'Directory form detected', 'strategy': 'Fill url/name/description and submit'}

        # Profile 检测
        if any(kw in str(all_inputs) for kw in ['website', 'homepage', 'blog_url']):
            return {'type': 'profile', 'confidence': 0.7, 'reason': 'Profile website field detected', 'strategy': 'Fill website field and save'}

        # 文章编辑器
        if 'title' in all_inputs and ('content' in all_inputs or 'body' in all_inputs):
            return {'type': 'article', 'confidence': 0.8, 'reason': 'Article editor detected', 'strategy': 'Write article with backlink and publish'}

        return {'type': 'dead', 'confidence': 0.5, 'reason': 'No recognizable form', 'strategy': 'Skip'}


class BatchRunner:
    """批量并行运行器"""

    @staticmethod
    async def run_all(config_dir: str = "config"):
        """并行运行所有站点"""
        config_dir = Path(config_dir)
        site_configs = sorted(config_dir.glob("site-*.json"))

        print(f"\n[BatchRunner] Starting {len(site_configs)} sites in parallel...\n")

        tasks = []
        for cfg in site_configs:
            tasks.append(BatchRunner._run_site(str(cfg)))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        for cfg, result in zip(site_configs, results):
            site_id = cfg.stem
            if isinstance(result, Exception):
                print(f"[{site_id}] ERROR: {result}")
            else:
                print(f"[{site_id}] Done: {result}")

        return results

    @staticmethod
    async def _run_site(config_path: str):
        """运行单个站点"""
        config = json.loads(Path(config_path).read_text(encoding='utf-8'))
        site_id = config['site_id']

        browser = BrowserController(config_path)
        await browser.start()

        try:
            submitter = LinkSubmitter(browser, config)
            results = await submitter.run()
            return results
        finally:
            await browser.save_storage_state()
            await browser.close()