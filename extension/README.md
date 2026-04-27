# ExternalLink - 外链批量提交浏览器拓展

## 安装方式

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 开启右上角 **"开发者模式"**
3. 点击 **"加载已解压的拓展程序"**
4. 选择 `extension/` 文件夹
5. 完成！工具栏出现 🔗 图标

## 使用方式

### 1. 基础配置

点击工具栏图标 → **"⚙️ 配置"** 标签：

| 字段 | 说明 | 示例 |
|------|------|------|
| 邮箱 | 用于注册/评论 | `yourname+ext@gmail.com` |
| 用户名 | 随机人名（不要用品牌名） | `Alex Johnson` |
| 最大并发数 | 同时打开几个标签页 | `3` |
| 自动跳过验证码 | 遇到验证码直接跳下一个 | 不勾选（推荐手工解决） |

### 2. 提交面板

**目标域名**：你的网站 URL，如 `https://oldphotoliveai.com`

**品牌名称**：如 `OldPhotoLiveAI`

**锚文本**（可选）：如 `OldPhotoLiveAI - AI Photo Restoration Tool`

**外链列表**：每行一个 URL，可选 `|` 分隔指定平台类型：

```
https://example1.com/article/123
https://example2.com/profile-setting|profile
https://example3.com/submit-tool|directory
https://example4.com/blog/how-to-code|wp_comment
https://discuz-example.com/home.php?mod=spacecp&ac=profile&op=info|forum
```

### 3. 开始提交

点击 🚀 **开始提交** 按钮。

拓展会自动：
1. 打开目标页面
2. 检测平台类型（WP 评论 / phpBB 论坛 / SaaS 目录 / 文章评论 / 通用表单）
3. 逐字符填入表单字段（模拟真人打字，绕过 Antispam Bee）
4. 链接放在 URL 字段，不在正文（绕过 Akismet）
5. 检查 CleanTalk → 自动跳过
6. 检测验证码 → 黄色高亮标记，暂停等待

### 4. 处理验证码

遇到验证码时，页面上的验证码区域会**黄色高亮**。

你在浏览器中手动完成验证码后：
- 拓展会自动检测验证码消失，继续完成提交
- 或者回到 popup 点击继续

### 5. 查看结果

- **📊 日志** 标签：实时日志
- 统计面板：排队 / 完成 / 跳过 / 失败
- 提交后自动验证 `rel` 属性

## 支持的平台类型

| 类型 | 自动检测 | 说明 |
|------|---------|------|
| `wp_comment` | ✅ | WordPress 评论（#commentform, textarea#comment） |
| `profile` | ✅ | phpBB / Discuz 个人信息 URL 字段 |
| `forum` | ✅ | 通用论坛 Profile |
| `directory` | ✅ | SaaS 目录提交（submit tool/product） |
| `article` | ✅ | 文章/Blog 评论 |
| `submission` | ✅ | 通用提交表单 |
| `auto` | ✅ | 自动判断（默认） |

## 支持的验证码检测

| 验证码 | 检测 | 处理 |
|--------|------|------|
| reCAPTCHA v2 | `.g-recaptcha` | 暂停，手动解决 |
| reCAPTCHA v3 | `.grecaptcha-badge` | 暂停 |
| hCaptcha | `.h-captcha` | 暂停 |
| Cloudflare Turnstile | `.cf-turnstile` | 暂停 |
| 图片验证码 | `img[src*="captcha"]` | 暂停 |
| 数字验证码 | `input[name*="captcha"]` | 暂停 |
| OTP 验证码 | `input[name*="code"]` | 暂停 |

## 反垃圾系统绕过

| 系统 | 检测 | 绕过策略 | 成功率 |
|------|------|---------|--------|
| Akismet | #akismet_comment_nonce | Gmail + URL放Website字段 | 100% |
| Antispam Bee | #wpa2a_comment | 逐字符键盘事件 | 90% |
| CleanTalk | .apbct_special_field | 自动跳过 | 0%（不可绕过） |
| WPantispam | #was-stop-response | 纯文本评论 | 80% |
| Jetpack | iframe[src*="jetpack"] | 自动跳过 | 0%（跨域iframe） |

## 知识库

`skills/spam-detectors.json` - 反垃圾系统检测规则  
`skills/platform-rules.json` - 平台检测规则和表单字段映射

## 快捷键

无。完全通过 popup 面板操作。

## 文件结构

```
extension/
├── manifest.json          # Chrome 拓展配置
├── popup.html             # 弹窗界面
├── popup.js               # 弹窗逻辑 + 状态管理
├── background.js           # 后台队列调度 + 并发控制
├── content.js              # 内容脚本：表单检测 + 填充引擎
├── skills/
│   ├── spam-detectors.json  # 反垃圾系统知识库
│   └── platform-rules.json  # 平台规则知识库
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md