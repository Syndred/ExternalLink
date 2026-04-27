# platforms.md - 活跃平台操作速查

## 按类型分类

### 一、Profile 类（个人资料页放链接）

| 平台 | 注册方式 | 链接字段 | 验证码 | 已知坑点 |
|------|---------|---------|--------|---------|
| phpBB 论坛 | 常规注册 | pf_phpbb_website | reCAPTCHA v2 | Profile 页 URL 是 `?op=info` 不是 `?op=base` |
| Boardhost 免费论坛 | 无需注册 | Link URL 字段 | 无 | 秒发，链接字段可能叫 "Website URL" |
| Discuz 论坛 | 常规注册 | Site 字段 | Discuz 图形验证码 | `home.php?mod=spacecp&ac=profile&op=info` |
| GitHub | GitHub OAuth | Profile → Website | 无 | URL 放 bio 里不生成链接，必须放 website 字段 |
| V2EX | 手机号 | 个人网站 | 手机验证 | 需绑定手机号 |
| Hacker News | 邮箱注册 | about 字段 | 无 | about 里 URL 自动加 nofollow |
| Reddit | 邮箱/OAuth | Profile → Custom Feed / About | 无 | Profile URL 大部分 nofollow |

### 二、文章/博客类

| 平台 | 注册方式 | OAuth | 链接属性 | 注意事项 |
|------|---------|-------|---------|---------|
| velog.io | GitHub/Google OAuth | ✅ | Dofollow | Markdown 文章即发即过，韩国最大开发者博客 |
| dev.to | GitHub OAuth | ✅ | Dofollow | 文章内链接，标题不能太标题党 |
| telegra.ph | API 创建 | ❌ | Dofollow | DR92，API 秒建，无需注册 |
| rentry.co | curl API | ❌ | Dofollow | Markdown，秒做 |
| medium.com | Google/邮箱 | ✅ | Nofollow（2026） | 高 DR（94）品牌信号价值 |
| hashnode.com | GitHub OAuth | ✅ | Nofollow（2026） | 开发者博客 |
| hackmd.io | GitHub/Google | ✅ | Nofollow（2026） | 已降级 |
| paragraph.com | 邮箱 | ❌ | Nofollow（2026） | 已降级 |
| justpaste.it | 无需注册 | ❌ | Nofollow（2026） | 已降级 |
| codepen.io | GitHub/邮箱 | ✅ | Nofollow（2026） | 已降级 |

### 三、论坛类

| 平台 | 注册难度 | 链接位置 | Dofollow | 备注 |
|------|---------|---------|---------|------|
| phpBB | 中 | Profile Website | ✅ | 100% 成功率 |
| Boardhost | 无 | Link URL | ✅ | 无需注册秒发 |
| Discuz | 中 | 个人资料 Site | ✅ | op=info 页面 |
| MyBB | 中 | Profile Website | ✅ | 类似 phpBB |
| XenForo | 低 | Profile URL | ❌（多数） | 主流论坛已加 nofollow |
| vBulletin | 中 | Profile Homepage | ❌（多数） | 老版本可能 Dofollow |

### 四、SaaS 目录站

| 特征 | 识别方法 |
|------|---------|
| "Submit product/tool" 入口 | URL 通常是品牌短 slug |
| 系统自动生成 listing 页 | "Visit website" 按钮默认 Dofollow |
| 获取成本极低（只填 1 个 URL） | Dofollow 率接近 100% |
| 2026 趋势 | 大量转向付费，免费窗口正在关闭 |

### 五、Guest Post 平台

| 平台 | 要求 | 难度 | Dofollow |
|------|------|------|---------|
| 各类 Blogger Outreach | 800-1500 字原创 | 高 | 协商 |
| 小博客 Contact 页面 | 自荐 | 中 | 看站长 |
| HARO / Qwoted | 媒体采访 | 高 | 看媒体 |

### 六、WP 评论

- 目标：评论区活跃（评论数 > 50）且站长不清理的老文章
- 链接放 author URL 字段，正文不放 URL
- 详细 SOP 见 wp-comments.md

### 七、短链/书签类（辅助收录）

| 平台 | 用途 |
|------|------|
| bit.ly | 短链 |
| tinyurl.com | 短链 |
| diigo.com | 书签 |
| pearltrees.com | 书签 |

### 八、日本 CGI（如果做日本市场）

| 平台 | 类型 |
|------|------|
| @wiki | Wiki |
| fc2.com | Blog |
| livedoor Blog | Blog |
| Seesaa Wiki | Wiki |