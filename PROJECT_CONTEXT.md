# PROJECT_CONTEXT

> 最后更新：2026-08-27 11:55｜扩展 2.7.0｜路线：混合 C
> 完整进度见 [`进度.md`](进度.md) / [`docs/进度.md`](docs/进度.md)。
> 今晚中断详见 [`docs/外链提交报告-2026-08-26.md`](docs/外链提交报告-2026-08-26.md)。

## 当前已完成

- Chrome MV3：Side Panel 主 UI、Settings、Background 调度、Content 填表、local_agent。
- **2.7.0 对标 BacklinkHelper / AutoCommentAI 补齐四块能力**（已落地，需在 Chrome 重载扩展并重启本机 Agent）：
  1. **AI 评论生成**：`POST /comment`；读页面正文 → DeepSeek 写切题评论；拒绝套话开场；链接默认放 URL 字段；失败时用标题兜底，不再用 10 条硬编码英文模板。
  2. **本地图库上传注入**：`GET /media/list` + `/media/file` 读 `/Users/syndred/Desktop/projects/media/{Profile}/`；`File` + `DataTransfer` 赋给 `input[type=file]`，绕开系统文件选择器与 CORS。
  3. **提交前目标闸门**：域名黑名单（支持 `.suffix` / `*`）、RDAP 域名年龄缓存、`prescanPage` 的 dofollow 预估（优先看既有评论外链）；Settings「全局配置」可改阈值并一键预取队列年龄。
  4. **手动填充图标**：疑似提交/评论页在输入框旁显示 `EL`；一点即用当前 Profile 填该字段（含评论与本地上传）。
- 私有 Google Sheet 是网站资料、外链库和人工分类的唯一维护入口；`chrome.storage.local` 是运行缓存与本地成功账本，成功后通过 outbox 自动回写 Sheet。
- `Table.xlsx` / `table-library.json` 只保留为首次安装与离线回滚种子，不再要求日常双处更新。
- Settings 已提供 Google 连接、只读预览、应用同步、待同步账本回写和断开入口；OAuth refresh token 仅由本机 Agent 的系统钥匙串或仓库外 0600 文件保存。
- `submissionRecords` v2 以 `destinationKey + profileId` 唯一标识成功组合。
- 旧 `siteAnnotations[].submittedProjects` 与 Table 历史记录会幂等迁移。
- 当前 Table 同步结果：6 个 Profile（含 VideoToArticleAI）、59 条 canonical 外链；RainbowPetAI 历史成功 10 条；VideoToArticleAI 2026-08-24 已确认免费成功 7 条。
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
- 2026-08-07～08-20 养号巡检见历史记录与 `data/community-participation-log.json`。
- 2026-08-24 新增 Profile `VideoToArticleAI`（`https://videotoarticleai.com`）。当天免费成功 7 条。日报：`docs/外链提交报告-2026-08-24.md`。
- 2026-08-25 全量聚合免费外链候选写入 Sheet；外链库 Settings 视觉优化；社区/论坛候选标记 `needs_manual`。
- 2026-08-26 Google OAuth + Sheet 同步落地（2,902 destinations）；Popup 工作台改版；媒体统一在仓库外 `media/`；晚间约 81 页签卡死 Chrome——之后同一时间只开 1 个提交页。

## 关键存储

| Key                  | 用途                                            |
| -------------------- | ----------------------------------------------- |
| `siteProfiles`       | 稳定 Profile ID 的自家网站资料                  |
| `activeSiteId`       | 当前手动填表网站                                |
| `selectedSiteIds`    | 最近一次批量多选                                |
| `submissionRecords`  | v2 永久成功账本                                 |
| `siteAnnotations`    | 外链站级分类与临时闸门                          |
| `activeBatchRun`     | 仅恢复 running / waiting_manual / paused 的批次 |
| `urlList`            | 自定义外链，新增/置顶项排在最前                 |
| `domainBlacklist`    | 域名黑名单（`.suffix` 含子域）                  |
| `targetFilters`      | 年龄阈值、AI 评论/图标开关等                    |
| `domainMetricsCache` | RDAP 年龄查询缓存                               |

## 关键文件

```text
extension/lib/queue.js       # 成功账本、迁移、分组队列、黑名单/年龄闸门
extension/lib/scheduler.js   # 同站续跑、并发位、稳定游标
extension/lib/backup.js      # 账本备份校验与合并
extension/lib/sheet-sync.js  # Sheet 预览、证据优先合并与回写 outbox
extension/background.js      # 调度、评论草稿、本地媒体、域名指标代理
extension/content.js         # 填表、AI 评论、DataTransfer 上传、手动图标、prescan
extension/sidepanel.*        # 执行 / 批量 / 待人工
extension/settings.*         # Profile / 外链库 / 备份 / 闸门与助手配置
local_agent/server.py        # /plan /comment /media/* /domain/metrics /google/*
tools/import_table_xlsx.py   # 按工作表解析 Profile、媒体、外链和历史记录
DESIGN.md                    # UI 基础规则
tests/*workflow.test.mjs     # 队列、调度、备份和 UI 行为测试
tests/local-agent-unit.test.py
```

## 验证状态

- 已通过 Node 队列、调度、备份、UI 和扩展静态/行为测试（含 2.7.0 闸门/评论/媒体断言）。
- 已通过 Python 41 个 local_agent 单元测试（含评论校验、媒体路径穿越、RDAP 分数秒日期）。
- 本机 Agent 实机：`/media/list` 读到 6 个 Profile；`/media/file` 可出 dataUrl；路径穿越返回 400；`uneed.best` RDAP 年龄 76 个月；`/comment` 对 CDN 延迟文生成两篇切题无套话草稿。
- Computer Use 曾确认 2.5.0/2.6.0；**2.7.0 需用户在 chrome://extensions 重新加载后验收手动图标与本地上传。**
- 2026-08-26 晚间批量开页已导致 Chrome 卡死；后续必须一页一关。

## 后续边界

- **2.7.0 已内置 AI 评论**，社区/论坛候选可小流量试投，但仍人工确认成功。
- `Link Submit` 仍是 Google 表格对象 `表格_1`（深绿表头）。不要再改成普通筛选。`SubmitProject` 下拉：**VideoToArticleAI / RainbowPet / OldPhotoLive / RSPAI / GraffitiName / TextComparison**。
- 不破解验证码、不绕过付费墙；仅明确成功证据或人工确认打勾。
- 提交时同一时间只保留 1 个工作页签；验证码最多留 1–2 个。
- 目标：Video **30/30**；RainbowPet **12/30**（下拉用 **RainbowPet**）；OldPhotoLive **6/30**。电话 `+8615766379321`。
- 打开过的行都要写 **Time**；验证码/付费写 `Note` 后继续，不要停等。
- 本地图库：`/Users/syndred/Desktop/projects/media/{Profile}/`。必填上传走 Agent `/media/file` + DataTransfer；iframe 内上传仍进不去。可用 `EXTERNALLINK_MEDIA_ROOT` 改根目录。
- **使用前**：重启 `python3 local_agent/server.py`，chrome://extensions 重载 **2.7.0**；Settings → 全局配置可「检查本地图库」「预取当前队列域名年龄」。
