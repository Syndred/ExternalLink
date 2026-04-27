"""
Playwright 浏览器控制器
每站独立 browser context，支持 ISP 代理和独立 Chrome Profile
"""

import asyncio
import json
import os
import time
from pathlib import Path
from datetime import datetime

try:
    from playwright.async_api import async_playwright, Browser, BrowserContext, Page
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False
    print("[WARNING] Playwright 未安装。运行: pip install playwright && playwright install chromium")


class BrowserController:
    """管理单个站点的浏览器实例"""

    def __init__(self, config_path: str):
        with open(config_path, 'r', encoding='utf-8') as f:
            self.config = json.load(f)
        self.site_id = self.config['site_id']
        self.browser_config = self.config.get('browser', {})
        self.proxy_config = self.config.get('proxy', {})
        self.pw_config = self.config.get('playwright', {})
        self.domain = self.config.get('domain', '')

        self.playwright = None
        self.browser: Browser = None
        self.context: BrowserContext = None
        self.page: Page = None
        self.tabs: dict = {}  # 多标签页管理

    async def start(self):
        """启动浏览器实例"""
        if not PLAYWRIGHT_AVAILABLE:
            raise RuntimeError("Playwright 未安装")

        self.playwright = await async_playwright().start()

        # 启动选项
        launch_options = {
            'headless': self.browser_config.get('headless', False),
        }
        if self.pw_config.get('executable_path'):
            launch_options['executable_path'] = self.pw_config['executable_path']
        if self.pw_config.get('channel'):
            launch_options['channel'] = self.pw_config['channel']

        self.browser = await self.playwright.chromium.launch(**launch_options)

        # Context 选项（带独立 profile 和代理）
        context_options = {
            'viewport': self.browser_config.get('viewport', {'width': 1280, 'height': 900}),
            'locale': self.browser_config.get('locale', 'en-US'),
            'timezone_id': self.browser_config.get('timezone_id', 'America/New_York'),
        }

        # 独立 Chrome Profile 目录
        profile_dir = self.browser_config.get('profile_dir', '')
        if profile_dir:
            profile_dir = Path(profile_dir)
            profile_dir.mkdir(parents=True, exist_ok=True)
            # Playwright 使用 user_data_dir 或 storage_state 来隔离
            context_options['storage_state'] = str(profile_dir / 'state.json') if (profile_dir / 'state.json').exists() else None

        # 代理配置
        proxy_server = self.proxy_config.get('server', '')
        if proxy_server:
            context_options['proxy'] = {'server': proxy_server}
            if self.proxy_config.get('username'):
                context_options['proxy']['username'] = self.proxy_config['username']
            if self.proxy_config.get('password'):
                context_options['proxy']['password'] = self.proxy_config['password']

        self.context = await self.browser.new_context(**context_options)
        self.page = await self.context.new_page()

        # 监听新标签页
        self.context.on('page', self._on_new_tab)

        print(f"[Browser:{self.site_id}] 浏览器已启动" +
              (f" | 代理: {proxy_server}" if proxy_server else ""))

        # 加载已有 storage state（如果有）
        storage_path = Path(profile_dir) / 'state.json' if profile_dir else None

        return self.page

    async def _on_new_tab(self, page: Page):
        """处理新标签页打开"""
        await page.wait_for_load_state()
        tab_id = page.url
        self.tabs[tab_id] = page
        print(f"[Browser:{self.site_id}] 新标签页: {page.url[:80]}")

    async def navigate(self, url: str, wait_until: str = 'domcontentloaded'):
        """导航到 URL"""
        print(f"[Browser:{self.site_id}] Navigate -> {url[:100]}")
        await self.page.goto(url, wait_until=wait_until, timeout=30000)
        return self.page

    async def open_new_tab(self, url: str = ''):
        """在新标签页中打开（用于查邮件等，不离开有表单的页面）"""
        new_page = await self.context.new_page()
        if url:
            await new_page.goto(url, wait_until='domcontentloaded')
        tab_id = url or f"tab_{len(self.tabs)}"
        self.tabs[tab_id] = new_page
        print(f"[Browser:{self.site_id}] 开新标签页: {url[:80] if url else '(空白)'}")
        return new_page

    async def get_main_page(self) -> Page:
        """获取主标签页"""
        return self.page

    async def screenshot(self, name: str = ''):
        """截图"""
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        filename = f"screenshot_{self.site_id}_{ts}_{name}.png" if name else f"screenshot_{self.site_id}_{ts}.png"
        filepath = Path.cwd() / "screenshots" / filename
        filepath.parent.mkdir(exist_ok=True)
        await self.page.screenshot(path=str(filepath), full_page=True)
        print(f"[Browser:{self.site_id}] 截图保存: {filepath}")
        return str(filepath)

    async def get_snapshot(self):
        """获取页面可访问性快照（类似 Playwright MCP 的 browser_snapshot）"""
        # 获取页面文本内容和可交互元素
        snapshot = await self.page.evaluate("""() => {
            const body = document.body;
            const title = document.title;
            const url = window.location.href;
            const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
                text: a.textContent?.trim()?.substring(0, 100) || '',
                href: a.href?.substring(0, 200) || '',
                rel: a.rel || ''
            })).filter(l => l.text && l.href);
            const forms = Array.from(document.querySelectorAll('form')).map(f => ({
                action: f.action?.substring(0, 200) || '',
                method: f.method || 'get',
                inputs: Array.from(f.querySelectorAll('input, textarea, select')).map(i => ({
                    name: i.name || i.id || '',
                    type: i.type || i.tagName.toLowerCase(),
                    placeholder: i.placeholder || '',
                    required: i.required || false
                }))
            }));
            const buttons = Array.from(document.querySelectorAll('button, input[type=submit], a.button, a.btn')).map(b => ({
                text: b.textContent?.trim()?.substring(0, 100) || b.value || '',
                type: b.type || b.tagName.toLowerCase(),
                id: b.id || ''
            }));
            return { title, url, linkCount: links.length, formCount: forms.length, forms: forms.slice(0, 3), buttons: buttons.slice(0, 10), links: links.slice(0, 20) };
        }""")
        return snapshot

    async def press_sequentially(self, selector: str, text: str, delay: int = 80):
        """逐字符输入（触发键盘事件链，绕过 Antispam Bee）"""
        element = self.page.locator(selector)
        await element.click()
        await element.fill('')  # 清空
        await element.press_sequentially(text, delay=delay)
        print(f"[Browser:{self.site_id}] pressSequentially → {selector}: '{text[:50]}...'")

    async def fill_field(self, selector: str, value: str):
        """安全填表（先 focus 再 fill）"""
        element = self.page.locator(selector)
        await element.focus()
        await element.fill(value)

    async def click_element(self, selector: str):
        """点击元素"""
        element = self.page.locator(selector)
        await element.click()

    async def check_rel(self, target_domain: str) -> dict:
        """实测当前页面中目标链接的 rel 属性"""
        result = await self.page.evaluate("""(domain) => {
            const links = document.querySelectorAll('a[href*="' + domain + '"]');
            const results = [];
            links.forEach(a => {
                results.push({
                    href: a.href,
                    rel: a.rel || 'EMPTY',
                    text: a.textContent?.trim()?.substring(0, 100) || ''
                });
            });
            return results;
        }""", target_domain)

        for r in result:
            rel_status = '[DOFOLLOW]' if r['rel'] == 'EMPTY' else f'[{r["rel"]}]'
            print(f"[Browser:{self.site_id}] REL check: {rel_status} | {r['href'][:100]}")

        return result

    async def execute_in_page(self, js: str):
        """在页面中执行 JS"""
        return await self.page.evaluate(js)

    async def reverse_eng_apis(self) -> list:
        """前端逆向：提取所有 API endpoint"""
        apis = await self.page.evaluate("""() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            const patterns = [
                /fetch\\s*\\(\\s*['"]([^'"]+)['"]/g,
                /axios\\.post\\s*\\(\\s*['"]([^'"]+)['"]/g,
                /axios\\.get\\s*\\(\\s*['"]([^'"]+)['"]/g,
                /\\.post\\s*\\(\\s*['"]([^'"]+)['"]/g,
                /url\\s*:\\s*['"]([^'"]+)['"]/g,
                /api\\s*:\\s*['"]([^'"]+)['"]/g,
                /endpoint\\s*:\\s*['"]([^'"]+)['"]/g,
            ];
            const found = new Set();
            scripts.forEach(s => {
                patterns.forEach(p => {
                    const matches = (s.textContent || '').matchAll(p);
                    for (const m of matches) if (m[1]) found.add(m[1]);
                });
            });
            return Array.from(found);
        }""")
        print(f"[Browser:{self.site_id}] 逆向发现 {len(apis)} 个 API endpoint")
        for api in apis[:10]:
            print(f"  - {api}")
        return apis

    async def save_storage_state(self):
        """保存浏览器状态（cookie/session 等）"""
        profile_dir = self.browser_config.get('profile_dir', '')
        if profile_dir:
            storage_path = Path(profile_dir) / 'state.json'
            await self.context.storage_state(path=str(storage_path))
            print(f"[Browser:{self.site_id}] State saved -> {storage_path}")

    async def close(self):
        """关闭浏览器"""
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
        print(f"[Browser:{self.site_id}] 浏览器已关闭")


class CaptchaHandler:
    """验证码处理"""

    @staticmethod
    async def detect_captcha(page: Page) -> str:
        """检测当前页面的验证码类型"""
        detections = await page.evaluate("""() => {
            if (document.querySelector('.g-recaptcha, #recaptcha, .recaptcha-checkbox')) return 'reCAPTCHA_v2';
            if (document.querySelector('.grecaptcha-badge')) return 'reCAPTCHA_v3';
            if (document.querySelector('.h-captcha, #hcaptcha')) return 'hCaptcha';
            if (document.querySelector('#challenge-stage') || document.querySelector('#cf-challenge')) return 'CloudFlare_Challenge';
            if (document.querySelector('.ctp-checkbox-container')) return 'CleanTalk';
            // 数学问题
            const mathPatterns = document.body?.innerText?.match(/(\\d+)\\s*[+\\-*/]\\s*(\\d+)\\s*=\\s*\\?/);
            if (mathPatterns) return 'Math_Captcha';
            return 'Unknown';
        }""")
        return detections

    @staticmethod
    async def solve_math_captcha(page: Page) -> bool:
        """自动解决数学验证码"""
        math = await page.evaluate("""() => {
            const match = document.body.innerText.match(/(\\d+)\\s*[+\\-*/]\\s*(\\d+)\\s*=\\s*\\?/);
            if (!match) return null;
            const a = parseInt(match[1]), b = parseInt(match[2]);
            const op = match[0].match(/[+\\-*/]/)[0];
            let result;
            switch(op) {
                case '+': result = a + b; break;
                case '-': result = a - b; break;
                case '*': result = a * b; break;
                case '/': result = a / b; break;
            }
            return { a, b, op, result };
        }""")
        if math and math['result'] is not None:
            # 寻找答案输入框
            math_inputs = page.locator('input[type="number"], input[name*="captcha"], input[name*="math"], input[name*="answer"]')
            count = await math_inputs.count()
            if count > 0:
                await math_inputs.first.fill(str(math['result']))
                print(f"[Captcha] 数学验证码已解: {math['a']} {math['op']} {math['b']} = {math['result']}")
                return True
        return False


class CommentGenerator:
    """WP 评论内容生成器"""

    MALE_NAMES = ['James', 'Michael', 'Robert', 'David', 'William', 'Richard', 'Joseph', 'Thomas', 'Charles', 'Christopher',
                  'Daniel', 'Matthew', 'Anthony', 'Mark', 'Donald', 'Steven', 'Paul', 'Andrew', 'Joshua', 'Kenneth']
    FEMALE_NAMES = ['Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Elizabeth', 'Susan', 'Jessica', 'Sarah', 'Karen',
                    'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra', 'Ashley', 'Kimberly', 'Emily', 'Donna', 'Michelle']
    LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez']

    COMMENT_TEMPLATES = [
        "Great breakdown of this topic. I've been exploring this area for a while and your point about {topic_hint} really resonates. Looking forward to more posts like this.",
        "Thanks for sharing this! The {topic_hint} aspect is something I've been trying to understand better. Your explanation made it much clearer.",
        "Excellent write-up. I especially appreciated the insights on {topic_hint}. It's rare to find content that explains this so well.",
        "This is really helpful, thanks! I've been dealing with {topic_hint} recently and your perspective gave me some new ideas to explore.",
        "Solid analysis. The part about {topic_hint} was particularly insightful. Would love to see a follow-up on related topics.",
    ]

    @staticmethod
    def generate(author_name: str = None, topic_hint: str = 'this') -> dict:
        """生成评论内容"""
        import random
        if not author_name:
            first = random.choice(CommentGenerator.MALE_NAMES + CommentGenerator.FEMALE_NAMES)
            last = random.choice(CommentGenerator.LAST_NAMES)
            author_name = f"{first} {last}"

        template = random.choice(CommentGenerator.COMMENT_TEMPLATES)
        comment = template.format(topic_hint=topic_hint)

        return {
            'author': author_name,
            'comment': comment
        }