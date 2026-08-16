# PROJECT_CONTEXT

> 最后更新：2026-08-16｜扩展 2.5.0｜路线：混合 C
> 完整进度见 [`进度.md`](进度.md) / [`docs/进度.md`](docs/进度.md)。

## 当前已完成

- Chrome MV3：Side Panel 主 UI、Settings、Background 调度、Content 填表、local_agent。
- Table.xlsx 只作为外链库和 Profile 初始种子；运行记录以 `chrome.storage.local` 为准。
- `submissionRecords` v2 以 `destinationKey + profileId` 唯一标识成功组合。
- 旧 `siteAnnotations[].submittedProjects` 与 Table 历史记录会幂等迁移。
- 当前 Table 同步结果：5 个 Profile、59 条 canonical 外链、7 个已提交行展开为 12 个历史成功组合。
- 每次批量开始从 Profile、账本、分类和外链库重新构建队列，不读取旧 `tasks`。
- 外链站分组，组内按用户勾选顺序提交多个 Profile；已有成功组合自动跳过。
- 同一外链站只开一个页签；成功后重新进入该站入口处理下一 Profile。
- 登录、验证码、无法重置表单会停放并释放并发位；人工可继续或确认成功。
- `paid / broken / skip / deleted` 排除整个外链站；单项目失败不误伤兄弟任务。
- Side Panel 分为“执行 / 批量 / 待人工”；Settings 提供外链库和账本导入导出。
- RainbowPetAI、RspAi、OldPhotoLive 已同步完整资料、Logo 和 Screenshot 1–4；本地 Logo 随备份恢复。
- Screenshot 1–4 使用统一媒体列表并按文件字段顺序映射；动态名称、域名、备注和日志均安全文本渲染。
- UI 基础规则见 [`DESIGN.md`](DESIGN.md)。
- TheJOAI 兼容性修复已覆盖富文本描述、受限主图上传、发布日期和必选分类；站点最终提交仍保持人工确认边界。
- 2026-08-02 RainbowPetAI 已确认完成 8 个免费提交：TheJOAI、Launching Next、StartupBase、AITools.inc、Uneed、FutureTools、SideProjectors、PitchWall；FutureTools 按用户人工确认入账。
- 新增 `data/submission-handoff-2026-08-02.json` 增量账本和专用外链提交交接表，后续 AI 可先查历史成功、免费队列和人工闸门再继续。
- 新增可全局安装的 `external-link-operator` Skill，固化 Luna 分工、自动媒体发现、登录/CAPTCHA/付费闸门、成功证据和多数据源对账流程。
- 2026-08-06 已创建公开 GitHub 资源库 `Syndred/pet-memorial-resources`，README 提供宠物离世支持资源、纪念清单、隐私建议并链接 RainbowPetAI；公开页已核验。
- Hacker News、Indie Hackers 与 Product Hunt 已完成首条真实社区评论；普通社区互动单独记录，不计入外链成功账本。
- Product Hunt 已在 `@syndred` 下公开上线 RainbowPetAI；2026-08-10 实机回读产品页显示 `Launched this week`、公开图库、网站链接、Maker 首评和 `Launched in 2026`，已按 `producthunt.com/products/rainbowpetai::RainbowPetAI` 写入成功账本。
- 2026-08-07 养号：`HN` 评 AI agent 审批帖（`item?id=49207465`）但 **[flagged]**，旧评亦 flagged；`PH` 评 Firecrawl MCP（无自链、未点赞）；`IH` 发帖权限仍锁，评论因站点 **502** 跳过；详情见 `data/community-participation-log.json`。
- 2026-08-11 巡检：HN 最近 24 小时已有一条用户侧评论，旧两评仍 `[flagged]`，当天不再互动；Indie Hackers 正式发帖编辑器已解锁，但普通评论入口仍异常指向 `/sign-up`；Product Hunt 已在 oqoqo 讨论页发布一条关于远端状态 readback oracle 的真实评论，未点赞、未带自链。
- 2026-08-12 巡检：HN 旧两评仍 `[flagged]`，继续暂停；Indie Hackers 无法完整核验唯一相关候选，Product Hunt 最相关候选与前一日主题相邻且回复去重不完整，因此三站均未新增评论或点赞。
- 2026-08-13 巡检：HN 旧两评仍 `[flagged]`，继续暂停；Indie Hackers 正式发帖编辑器可用但普通评论入口仍异常；Product Hunt 已在 Unsloth Desktop 发布一条关于 8GB GPU 内存估算、上下文长度和量化回退的真实评论，未点赞、未带自链。
- 2026-08-14 巡检：HN 旧两评仍 `[flagged]`，继续暂停；Indie Hackers 相关候选的互动入口仍指向 `/sign-up`；Product Hunt 因前一日刚互动且无强非重复角度，当天未评论、未点赞，并恢复了昨日页面附带的非必要自动关注。
- 2026-08-16 巡检：HN 旧两评仍 `[flagged]`，继续暂停；Indie Hackers 的 Pickle 候选已有 17 条相近讨论且互动入口仍指向 `/sign-up`；Product Hunt 触发 Cloudflare 安全验证并立即停止，三站均未互动。8 月 15 日无执行证据，未补写日志。

## 关键存储

| Key | 用途 |
| --- | --- |
| `siteProfiles` | 稳定 Profile ID 的自家网站资料 |
| `activeSiteId` | 当前手动填表网站 |
| `selectedSiteIds` | 最近一次批量多选 |
| `submissionRecords` | v2 永久成功账本 |
| `siteAnnotations` | 外链站级分类与临时闸门 |
| `activeBatchRun` | 仅恢复 running / waiting_manual / paused 的批次 |
| `urlList` | 自定义外链，新增/置顶项排在最前 |

## 关键文件

```text
extension/lib/queue.js       # 成功账本、迁移、分组队列
extension/lib/scheduler.js   # 同站续跑、并发位、稳定游标
extension/lib/backup.js      # 账本备份校验与合并
extension/background.js      # 调度和恢复
extension/sidepanel.*        # 执行 / 批量 / 待人工
extension/settings.*         # Profile / 外链库 / 备份 / 配置
tools/import_table_xlsx.py   # 按工作表解析 Profile、媒体、外链和历史记录
DESIGN.md                    # UI 基础规则
tests/*workflow.test.mjs     # 队列、调度、备份和 UI 行为测试
```

## 验证状态

- 已通过 Node 队列、调度、备份、UI 和扩展静态/行为测试。
- 已通过 Python 15 个 local_agent 单元测试。
- Computer Use 已确认 Chrome 中安装并启用 ExternalLink 2.5.0，三工作区正常，旧 Profile 去重后仅保留稳定 ID 对应资料，最近批量勾选保持不变。
- 仓库 Table、插件种子、增量账本和交接表沿用同一 canonical 记录规则。RainbowPetAI 增量账本现有 10 条明确成功记录，SideProjectors 根入口别名已归并到 `/submit`；Product Hunt 已写入本地账本，但 Google Sheet 因当前没有连接的表格会话而待同步。
- TheJOAI 已在真实文件上传、描述、日期和分类复核后完成提交，账户显示 `Submitted for Review`。
- Launching Next、StartupBase、AITools.inc、Uneed 已看到明确成功/排队证据；FutureTools 由用户人工确认完成。
- FiveTaco 因无可靠回执继续保持未确认；ToolDirectory.ai 的 $9.99 页面已标记付费，Webwiki / Submission Web Directory / Alternative.me / SaaSAITools 进入待人工。
- 为避免启动 227 个真实外链项，本轮未点击“开始提交”；仍需用隔离测试目标严格复现 B/C → D/E，并验证停放恢复与浏览器重启。

## 后续边界

- P2 视觉 Agent 与博客评论仿写继续暂停，直到上述真实 Chrome 验收通过。
- Table 不做提交状态双向回写；账本 JSON 是扩展重装/备份通道。
- 不破解验证码、不绕过付费墙；仅明确成功证据或人工确认写入永久成功。
