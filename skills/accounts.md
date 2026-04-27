# accounts.md - 账号 & 邮箱 & 多实例架构

## 3 站账号映射

| 站 | 品牌名 | 主域名 | Gmail+别名 | GitHub 账号 | Google 账号 |
|----|--------|--------|-----------|------------|------------|
| site-a | OldPhotoLiveAI | oldphotoliveai.com | (待配置) | (待配置) | (待配置) |
| site-b | GraffitiNameAI | graffitinameai.com | (待配置) | (待配置) | (待配置) |
| site-c | Comparison-Text | comparison-text.site | (待配置) | (待配置) | (待配置) |

## 邮箱策略

### 1. Gmail Plus-Addressing（主力）
格式：`username+tag@gmail.com`

优势：
- 一个 Gmail 无限别名
- 每个站/每个平台独立标识
- 品牌域名邮箱（team@yourdomain.com）被标记后还有救
- 不易被反垃圾系统关联

规则：
- 每个站对应一个独立的 tag
- 高价值平台可以再加更细的 tag：`username+sitea-phpbb@gmail.com`
- 新开平台先用干净 tag 测试

### 2. catch-all 域名邮箱（备选）
格式：`anything@yourdomain.com`

问题：
- 很多站静默拒绝自定义域名邮箱
- 域名信誉可能被连带污染
- **失败后立刻切回 Gmail plus-addressing**（铁律 #9）

### 3. 临时邮箱（特殊情况）
- Guerrilla Mail / Temp Mail
- 用于仅注册不看邮件的平台
- 注意：有些平台拒绝临时邮箱域名

## Google / GitHub OAuth 管理

### OAuth 令牌池
| 账号 | 平台 | 用途 | 状态 |
|------|------|------|------|
| github-a | GitHub | velog.io, dev.to 登录 | - |
| github-b | GitHub | velog.io, dev.to 登录 | - |
| google-a | Google | velog.io, medium 登录 | - |
| google-b | Google | velog.io, medium 登录 | - |

### OAuth 操作 SOP
1. 需要 OAuth 登录时，确认当前站对应的 GitHub/Google 账号
2. Playwright 点击 "Sign in with GitHub/Google"
3. 如果浏览器已有 session，直接过
4. 如果没有 session，输入账号密码（或人工介入）
5. 授权后等待回调 → 确认登录成功

## 多实例 Playwright MCP 并发架构

### 核心规则：每站独立

```
Project root/
├── config/
│   ├── site-a.json     # site-a 的浏览器 profile + 代理 + Playwright 配置
│   ├── site-b.json
│   ├── site-c.json
│   └── site-d.json
├── profiles/
│   ├── site-a/         # Chrome user data 目录（cookie/session 隔离）
│   ├── site-b/
│   ├── site-c/
│   └── site-d/
└── db/
    └── linkforge.db    # 共享数据库（4 站共用，通过 site_id 区分）
```

### 启动方式（多终端并行）

```bash
# 终端 1: site-a
cd /path/to/project && python src/cli.py --site site-a --task submit

# 终端 2: site-b
cd /path/to/project && python src/cli.py --site site-b --task submit

# 终端 3: site-c
cd /path/to/project && python src/cli.py --site site-c --task submit

# 终端 4: site-d
cd /path/to/project && python src/cli.py --site site-d --task submit
```

### 隔离保证
- **Chrome Profile**：每站独立目录，cookie/session/localStorage 完全隔离
- **ISP 代理**：每站分配独立代理端口（`config/site-*.json`）
- **数据库**：共享 SQLite，通过 `site_id` 区分，写入时带事务锁
- **Playwright 进程**：每站独立 context，不共享 browser 实例