# dead-sites.md - 失效站 & 失败模式归档

## 死站识别特征

**立即跳过的信号**：
- 连接超时 (>10s) 或 DNS 解析失败
- HTTP 5xx 错误（服务器挂了）
- 域名过期页面（Domain Parked / Expired）
- 数据库连接错误（Error establishing a database connection）
- 空白页面 / 无实际内容

## 付费墙趋势（2026）

| 站点类别 | 2025状态 | 2026状态 |
|---------|---------|---------|
| ProductHunt Launch | 免费 | 收费（$xx/月） |
| BetaList | 免费排队 | 付费优先 |
| SourceForge | 免费 | 限制功能 |
| Many SaaS directories | 免费 | 收费 / 限额 |

**免费窗口正在关闭**，优先提交仍免费的目录站。

## 死站列表（已确认失效）
```csv
# 格式：域名, 原因, 发现日期
# 在此追加确认失效的站点
```

## CloudFlare 硬封站

**识别特征**：
- "Checking your browser" 循环
- CF Challenge 页面（5 秒盾）
- CF Block 页面（Your IP has been banned）
- 返回 403 且有 `__cf_chl_` cookie

**对策**：
- CF Challenge → 有时候 Playwright 正常行为可过
- CF Block → 切 IP，切 ISP 代理
- CF Under Attack Mode → 大概率过不了，先标记后续再试

## 无 SEO 价值站

**排除标准**：
- 域名 < 6 个月（新站无权重）
- 首页被 noindex
- robots.txt 禁止所有爬虫
- 页面 canonical 指向其他域名
- zero traffic（Ahrefs / Semrush 数据为 0）

## 失败模式归档

| 失败模式 | 症状 | 根本原因 | 对策 |
|---------|------|---------|------|
| 邮箱被标记 | 评论无声消失 | Akismet 标记邮箱信誉 | 切干净 Gmail |
| IP 被标记 | 403 全站 | 同 IP 发太多被关联 | 切 ISP 代理 |
| 表单 JS 拦截 | 提交无反应 | JS set value 不触发事件 | pressSequentially |
| 嵌套 iframe 评论 | 无法操作评论框 | Jetpack Highlander 跨域 | 跳过 |
| 验证码浪费 | 过了验证码但提交失败 | 表单未填完 | 铁律#10 |
| 链接被自动加 nofollow | 提交成功但 rel 不对 | 平台默认加 rel | 查 dofollow-2026.md |
| 锚文本写错 | 链接内容对不上 | 切站未确认产品 | 铁律#8 |