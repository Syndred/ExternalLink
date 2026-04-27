# SKILL.md - 外链提交系统入口

## 10步核心流程

1. 读铁律（iron-rules.md）- 每次任务前必读
2. 确认当前站点品牌信息 / 锚文本
3. 从 DB 拉候选站（按 traffic DESC 排序）
4. 查阅目标平台操作经验（platforms.md）
5. Playwright 打开目标站 → 截图确认页面结构
6. 按经验操作：注册 / 填表 / 发评论 / 创建 Profile
7. 提交后实测 rel 属性（dofollow vs nofollow）
8. 写回数据库
9. Ping 搜索引擎通知新页面
10. 经验追加到对应 Skill 文件

## 候选筛选 SQL
```sql
SELECT * FROM candidate_sites
WHERE is_spam = 0
  AND traffic >= 100
  AND domain NOT IN (SELECT DISTINCT domain FROM submitted_links WHERE site_id = ?)
ORDER BY traffic DESC
LIMIT 20;
```

## 写回 DB 的 SQL
```sql
INSERT INTO submitted_links (domain, url, platform_type, rel, traffic, site_id, submitted_at)
VALUES (?, ?, ?, ?, ?, ?, datetime('now'));
```

## 策略优先级
1. SaaS 目录提交（获取成本最低、Dofollow 率最高）
2. 开发者博客文章（velog.io, dev.to, telegra.ph, rentry.co）
3. 论坛 Profile Website 字段（phpBB, Boardhost, Discuz）
4. WordPress 评论（目标页评论区活跃且无审核）
5. 短链 / 书签（低优先，辅助收录）

## 成功判定标准
- [ ] 链接出现在目标页面 DOM 中
- [ ] 实测 rel 属性（EMPTY = Dofollow, 含 nofollow = 非 Dofollow）
- [ ] 链接可点击跳转
- [ ] 已写入 submitted_links 表
- [ ] 已记录到对应 Skill 文件（新发现/新经验）

## Skill 文件索引
| 文件 | 职责 | 何时查阅 |
|------|------|---------|
| iron-rules.md | 10条铁律 | 每次任务前必读 |
| platforms.md | 平台操作速查 | 遇到已知平台时 |
| wp-comments.md | WP评论提交 | 提交评论时 |
| anti-spam.md | 反垃圾绕过 | 遇到验证码/403时 |
| dofollow-2026.md | Dofollow地图 | 需要Dofollow时 |
| dead-sites.md | 失效站归档 | 遇到404/付费墙时 |
| reverse-eng.md | 前端逆向SOP | 前端操作失败时 |
| strategies.md | 包管理器/卫星站 | 扩展策略时 |
| accounts.md | 账号邮箱架构 | 需要注册时 |