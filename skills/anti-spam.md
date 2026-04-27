# anti-spam.md - 反垃圾系统绕过对策

## 6 种反垃圾系统完整对策

### 1. Akismet（可绕过 ✅）
**关键发现**：Akismet 判断垃圾评论主要看**邮箱信誉**和 **IP 信誉**，而不是评论内容。

**绕过组合**：
- 干净 Gmail（从未用于 SEO 活动）—— 不要用品牌域名邮箱
- ISP 代理（住宅 IP，不是机房 IP）
- 正文不放任何 URL（链接只放 author URL 字段）
- 评论内容为纯文本真情实感
- 显示名用随机真实人名（不用品牌名/产品名）

**失败信号**：
- 评论提交后无声消失，评论区看不到"待审核"提示
- 用品牌域名邮箱注册过的站 → 邮箱被标记 → 之后所有评论都被吞

### 2. Antispam Bee（可绕过 ✅）
**识别特征**：德语圈流行插件，403 返回，可能有德文错误提示

**关键发现**：该插件监听 textarea 的 keydown 事件确认"真人在打字"
- ❌ JavaScript 设值（`element.value = '...'`）→ 不触发键盘事件 → 被判定为 bot
- ✅ Playwright pressSequentially → 逐字符输入 → 触发完整键盘事件链

**绕过 SOP**：
```javascript
// 不要用 fill()
await page.locator('textarea').pressSequentially(commentText, { delay: 100 });
```

### 3. WPantispam Protect（看配置 ⚠️）
**两种模式**：
- **严格模式**：需要回答中文/英文验证问题 → 纯文本评论 + 链接放 URL 字段
- **宽松模式**：直接过，无需特殊处理
- **识别**：表单底部有验证问题（如 "4 + 3 = ?"）

### 4. CleanTalk（无法绕过 ❌）
**识别特征**：403 硬拦，响应中有 "CleanTalk" 字样
**对策**：看到直接跳过该站，不要浪费时间

### 5. hCaptcha Enterprise（无法绕过 ❌）
**识别特征**：hCaptcha 图标，企业版
**对策**：评论内容被服务端清洗，直接跳过

### 6. Jetpack Highlander（无法绕过 ❌）
**识别特征**：评论框在跨域 iframe 中（*.wordpress.com 域）
**对策**：无法注入，直接跳过

## 10 种验证码处理方案

| 验证码类型 | 识别 | 处理 |
|-----------|------|------|
| reCAPTCHA v2（复选框） | "I'm not a robot" | Claude Code 填完所有字段后叫人点 |
| reCAPTCHA v3（隐身） | 无可见 UI | 行为分析 → 降低鼠标速度、增加延迟 |
| hCaptcha | 九宫格图片 | 大概率要人工 |
| CloudFlare Turnstile | "Verifying..." | 正常 Playwright 行为可过 |
| 数学问题 | "4 + 3 = ?" | Claude Code 计算填入 |
| WordPress 自定义问题 | 中文问题 | Claude Code 理解并回答 |
| OTP 邮件验证 | 邮箱收码 | 开新标签页查邮件 |
| SMS 验证 | 手机收码 | 人工介入 |
| 滑块验证 | 拖动滑块 | 大多无法自动化，人工介入 |
| FunCaptcha（Arkose Labs） | 方向旋转 | 人工介入 |

## 验证码协作 SOP（铁律 #10）
1. Claude Code 先填完**所有**表单字段
2. 滚动到验证码区域使其可见
3. 报告"所有字段填完，只剩验证码"
4. 人工通过验证码
5. Claude Code **立刻**点提交

**绝不**填一半就叫人来过验证码（浪费一次性验证码！）