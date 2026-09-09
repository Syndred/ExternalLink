# PROJECT_CONTEXT

> 最后更新：2026-09-09｜扩展 3.2.4｜路线：Neon 执行账本 + R2 证据 + 通用截图智能体
> **防串站**：批量任务按 `destination × Profile` 绑定品牌/URL/描述。自动填表只填侧栏当前选中的网站，且该网站必须在本页有待提交任务，否则不代填代点。全局评论模板不再覆盖产品文案。切站会重载评论框；提交前核对品牌和域名，对不上就停。
> **边填边扩库（可复用才存）**：填完后把空着的通用栏和未知产品栏（Discord、Founded year、Integration list 等）写入当前 Profile 的 `fields` 并同步 Neon。目录分类、How did you hear、同意条款、验证码、评论、当天日期不入库，已有字段不覆盖。
> **目录站无验证码可代点提交**（设置里默认开，批量页「仅填表」可关）。规则填完后 AI 只补一轮剩余栏；点提交后若仍报漏填，再补一轮。同一套扫描重复多遍补不出新东西。看到回执才写账本。有验证码的页签留下等人。登录 / OTP / 付费仍停。标准 WordPress 评论仍需另开开关才会代点。
> 历史 `Link Submit` 字段已作为首迁移快照保留；日常不再与 Google Sheet 同步。
> 完整进度见 [`进度.md`](进度.md) / [`docs/进度.md`](docs/进度.md)。
> 今晚中断详见 [`docs/外链提交报告-2026-08-26.md`](docs/外链提交报告-2026-08-26.md)。
> 2026-09-05 全自动差距评估见对话画布 `automation-gap`。
> 3.2.0 可信自动化实现和真实验收见 [`docs/外链可信自动化升级-2026-09-09.md`](docs/外链可信自动化升级-2026-09-09.md)。

## 当前已完成

- **3.2.0 可信自动化运行账本**：每轮 run、每次 attempt、每个 snapshot/plan/action/result/gate 均先写本地有界账本和持久 outbox，再幂等写入 Neon；截图证据以内容寻址写入不可覆盖的 R2 对象。侧栏可导出最近执行记录。
- **通用截图智能体**：每轮采集稳定 DOM、标注控件和新截图，DeepSeek 视觉模型基于当前页面、最近动作和结果决定下一小步；支持填写、选择、自定义组件点击、滚动、多步骤导航和普通免费外链提交，动作后重新观察，不再把视觉模型仅当失败兜底。验证码、OTP、缺失登录/OAuth、付费/订阅、明确法律确认和破坏性动作仍转人工；成功必须取得本次提交后的新回执、成功页、公开 URL 或账号记录，模型自述不能入账。
- **硬成功闸门**：提交前保存 evidence baseline；只有本次操作后新增的明确回执、2xx 响应或独立公开链接可写 `submissionRecords`。已点提交但无回执进入 `submitted_unconfirmed`，不显示成功。人工确认只允许扩展侧栏的 run + task + nonce 绑定操作。

- **3.0.0 云端数据中心（状态与媒体首迁移均已完成）**：已创建 Neon `ExternalLink Admin` 生产分支、执行 4 张状态表与 2 个索引；Cloudflare Worker `externallink-cloud` 已部署到 `https://externallink-cloud.syndred.workers.dev`。2026-09-06 首次迁移因旧实现逐条请求 Neon，超过 Cloudflare 免费 Worker 单次 50 个子请求而中断；Version `3337d930-d83e-4cda-9fab-22349d50954e` 改为单个 Neon HTTP 事务后续传成功。云端回读为 17 类有值文档（接口支持 21 类）、2,905 条外链、29 条提交记录、136 条当前时间线事件；续传时新增了 105 条缺失的时间线修订。R2 `externallink-media` 已实传 30 个媒体并逐个下载校验通过。Worker 密钥仅保存在 Cloudflare Secret：数据库连接串、DeepSeek Key、设备访问密钥均未写入仓库或扩展包。
- **云端唯一真相源**：连接后，外链库完整字段、Profile、提交账本、时间线、备注、分类和运营状态会自动写入 Neon；Logo/截图以私有 R2 对象保存，并以 `cloud-media://` 引用供填表时读取。首次迁移仍保留 `table-library.json` 只作为离线首装/灾备快照，绝不再读 Google 或启动本机 Agent。
- **本地服务和 Google 同步已移除**：扩展源代码、manifest、Settings、Popup、Side Panel 都不再调用本地 Agent 或 Google OAuth；旧 Python Agent、Google 同步模块、启动脚本、依赖与相关测试已删除。`sheetTableData` 名称仅为兼容既有导入数据，实际是云端外链字段文档。
- **设置页横向资料视图**：网站资料桌面端使用左侧可拖动站点列表 + 右侧“基本信息 / 内容描述 / 锚文本规则”三栏资料区；全局配置使用横向三栏。宽度低于 1100px 时逐步收为两栏/单栏，低于 560px 时收为单栏。已修复网格选择器覆盖 `.panel { display: none; }` 导致三个标签页同时显示、顶部按钮看似失效的问题；网格只在对应 `.panel.active` 时启用。Logo/4 张截图直接读取云端 R2 预览；网站资料里的“原始表格字段（兼容保留）”默认折叠，完整 Field / Content / Notes 仍保留。外链库卡片不再展示表格原始字段快照。外链卡片与时间线改为紧凑横排，置顶/编辑/删除为无外框图标；记录文本自动换行；只有点击入口链接才会打开网页。「最近动态」显示最新一条内容。右侧可做与侧边栏相同的站点标记，再点一次可取消为未分类。设置页已去掉顶部说明和同类提示文案，只留标题、标签和表单。

### 3.0 前历史能力（仅用于解释首迁移来源）

- **2.9.3 快速动态与单列运营视图**：固定扩展图标右键菜单新增“打开 ExternalLink 设置”；侧边栏会按当前外链站展示最多 8 条最新动态（按 Profile 区分提交、审核、上线、拒绝、跟进、笔记与证据链接），标签页切换、账本/时间线变化均自动刷新。查询只请求当前 URL 对应条目，不把 2,905 条库数据传到侧边栏。外链库改为每行一张全宽卡片，让状态、时间、Record、Detail 与备注使用横向空间。
- **2.9.2 表格快照内置**：已把 2026-09-05 真实 Google Sheet 快照（6 个项目、2,905 个外链站、29 条核验提交记录）更新为扩展离线种子；扩展重载后自动采用比运行缓存更新的内置版本，不再要求首次点击“应用同步”。按钮改为“检查 Google 更新 / 更新本地缓存”，更新本地缓存不再顺带回写 Google，避免读写边界混淆。
- **2.9.1 离线查看与运营筛选修正**：打开 Settings 只读 `chrome.storage.local`，不再自动请求 `127.0.0.1:8790`；断开 Google 或 Agent 未运行时仍优先使用已应用的完整 Sheet 缓存。外链库新增“表格有提交动作（未核验）/已提交/待确认收录/待审核/待跟进/已收录/被拒绝/疑似丢链/未提交”进度筛选；卡片首屏常显入口 URL、提交项目、当前进度、提交时间、最近动态、Record 和 Detail。自动检查默认关闭，并明确标注只有该能力需要 Agent 常驻。
- **2.9.0 表格全字段与外链动态时间线**：`Link Submit` 每行全部原始列、Record、Detail、行号均进入卡片；每个 Profile 子表的全部 Field / Content / Notes 均保留并可编辑。每张外链卡片按 Profile 展示追加式时间线，可记录精确提交时间、待审核、上线、拒绝、需跟进、链接失效和笔记；旧成功账本与表格历史会幂等迁移。备份已包含时间线与 Sheet 快照，无需另建远程数据库。
- Chrome MV3：Side Panel 主 UI、Settings、Background 调度、Content 填表、Cloudflare Worker。
- **2.8.2 Settings 外链库**：只有外链库页左右分栏（列表 + 同步）；网站资料/全局配置仍是顶部菜单。卡片一行两条，质量分写清楚，只显示已提交记录。
- **2.8.0 补齐外链运营闭环**（代码、本机 Agent 与 Google Sheet 已验收；Chrome 运行缓存待重载后应用）：
  1. **机会质量分**：结合 DR/DA、流量、Spam、dofollow、indexable、相关性、域名年龄和复核时间生成 0–100 分；外链库可筛选/排序，队列可设置最低分闸门。
  2. **发布链接监控**：只复查成功账本里的 `Public URL / Evidence URL`，识别 live/missing/unreachable 和 rel；不撤销历史成功，只在“曾存活 → 异常”时提醒。
  3. **评论工作室**：一次生成 3 条候选，选择后可编辑，显示字段上限/剩余字数并可恢复上一版；“生成”和“填入评论”彻底分离。
  4. **媒体预检**：按当前 Profile 展示 Logo/截图的文件名、类型、大小和缩略图；填表后回显每个文件字段的实际上传结果。
  5. **Sheet 变化提醒**：定时只读预览并提醒，仍由人工确认“应用同步”；不会后台静默覆盖本地强证据。
- **2.7.0 对标 BacklinkHelper / AutoCommentAI 补齐四块能力**：
  1. **AI 评论生成**：`POST /comment`；读页面正文 → DeepSeek 写切题评论；拒绝套话开场；链接默认放 URL 字段；失败时用标题兜底，不再用 10 条硬编码英文模板。
  2. **本地图库上传注入**：`GET /media/list` + `/media/file` 读 `/Users/syndred/Desktop/projects/media/{Profile}/`；`File` + `DataTransfer` 赋给 `input[type=file]`，绕开系统文件选择器与 CORS。
  3. **提交前目标闸门**：域名黑名单（支持 `.suffix` / `*`）、RDAP 域名年龄缓存、`prescanPage` 的 dofollow 预估（优先看既有评论外链）；Settings「全局配置」可改阈值并一键预取队列年龄。
  4. **手动填充图标**：只在评论/目录提交表单页显示蓝色 `EL`；一点即用当前 Profile 填该字段。搜索框、登录框、普通网页不再挂图标。设置里可关「在评论/提交表单旁显示手动填充图标」。
- Neon 工作区是网站资料、外链库、人工分类、账本与时间线的唯一维护入口；`chrome.storage.local` 只是离线运行缓存，变更会自动写入云端。
- `Table.xlsx` / `table-library.json` 只保留为首次安装、首迁移与离线回滚种子，不再要求日常双处更新。
- Settings 提供云端 Worker 连接、云端回读与失败时的手动推送；首次迁移完成后按钮自动禁用，访问密钥只在 Cloudflare Secret 和当前 Chrome 本地扩展配置中保存。
- `submissionRecords` v2 以 `destinationKey + profileId` 唯一标识成功组合。
- 旧 `siteAnnotations[].submittedProjects` 与 Table 历史记录会幂等迁移。
- 当前 Table 同步结果：6 个 Profile（含 VideoToArticleAI）、59 条 canonical 外链；RainbowPetAI 历史成功 10 条；VideoToArticleAI 2026-08-24 已确认免费成功 7 条。
- 每次批量开始从 Profile、账本、分类和外链库重新构建队列，不读取旧 `tasks`。
- 外链站分组，组内按用户勾选顺序提交多个 Profile；已有成功组合自动跳过。
- 同一外链站只开一个页签；成功后重新进入该站入口处理下一 Profile。
- 登录、验证码、无法重置表单会停放并释放并发位；人工可继续或确认成功。
- `paid / broken / skip / deleted` 排除整个外链站；单项目失败不误伤兄弟任务。
- Side Panel 分为“执行 / 批量 / 待人工”；Settings 提供外链库和账本导入导出。
- **Side Panel 2.7 UI 改版**（对标 BacklinkHelper / AutoCommentAI / Backlink Service 取长补短）：
  - **页面洞察卡**：hostname、TDK、质量芯片（dofollow 倾向、评论表单、验证码、域名年龄 RDAP）。
  - **工作流工具栏**：检测 → 填表 → AI 评论 → 下一站；步骤指示器；去掉底部重复操作栏。
  - **评论工作室**：语气选择（务实/专业/轻松/热情）+ 重新生成；字数统计；空草稿时 AI 评论先自动生成再填入。
  - **折叠区块**：站点标记、检测详情；品牌头图 + 设置页同步图标。
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
- 2026-08-28 Google Sheet 实时回读为 6 个 Profile、2,905 条外链、29 条提交记录、0 冲突；36 个本地媒体路径单元格已改为 `/Users/syndred/Desktop/projects/media/{Profile}/...` 并回读确认。

## 关键存储

| Key                  | 用途                                            |
| -------------------- | ----------------------------------------------- |
| `siteProfiles`       | 稳定 Profile ID 的自家网站资料                  |
| `activeSiteId`       | 当前手动填表网站                                |
| `selectedSiteIds`    | 最近一次批量多选                                |
| `submissionRecords`  | v2 永久成功账本                                 |
| `submissionTimeline` | 外链站 × Profile 的追加式提交、审核与跟进动态  |
| `sheetTableData`     | 全字段迁移库与原始行数据（变量名兼容历史）      |
| `siteAnnotations`    | 外链站级分类与临时闸门                          |
| `activeBatchRun`     | 仅恢复 running / waiting_manual / paused 的批次 |
| `urlList`            | 自定义外链，新增/置顶项排在最前                 |
| `domainBlacklist`    | 域名黑名单（`.suffix` 含子域）                  |
| `targetFilters`      | 年龄阈值、AI 评论/图标开关等                    |
| `domainMetricsCache` | RDAP 年龄查询缓存                               |
| `linkMonitorResults` | 已发布外链的最近复查结果                       |
| `cloudSyncConfig`    | Worker 地址、工作区和设备访问密钥               |
| `cloudSyncMetadata`  | 云端文档版本、最近回读/写入时间                 |

## 关键文件

```text
extension/lib/queue.js       # 成功账本、迁移、分组队列、黑名单/年龄/质量闸门
extension/lib/opportunity-score.js # 0–100 外链机会质量评分
extension/lib/scheduler.js   # 同站续跑、并发位、稳定游标
extension/lib/backup.js      # 账本、时间线与 Sheet 快照备份校验与合并
extension/lib/submission-timeline.js # 追加式时间线、迁移、当前状态派生
cloud/worker/                # Worker、Neon schema、R2 媒体接口
extension/lib/cloud-sync.js  # 云端工作区数据合同、版本与媒体引用
extension/background.js      # 调度、评论草稿、云端媒体、域名指标、prescan/评论预览代理
extension/content.js         # 填表、AI 评论、DataTransfer 上传、手动图标、prescan
extension/sidepanel.*        # 执行工作台（洞察卡 + 工具栏 + 评论工作室）/ 批量 / 待人工
extension/settings.*         # Profile / 外链库 / 备份 / 闸门与助手配置
tools/migrate-media-to-r2.mjs # 首迁移上传本机媒体到私有 R2
tools/import_table_xlsx.py   # 首迁移时按工作表解析 Profile、媒体、外链和历史记录
DESIGN.md                    # UI 基础规则
tests/*workflow.test.mjs     # 队列、调度、备份和 UI 行为测试
tests/local-agent-unit.test.py
```

## 验证状态

- 已通过云同步/Worker 核心/UI/媒体 Node 测试、扩展脚本语法检查和 `git diff --check`；云端 Worker 已真实部署、健康检查已通过。
- Settings 真实渲染无横向溢出，按钮行间距 12px；侧栏 500px 窄屏两列工具栏与评论头部换行已截图验收，同一规则覆盖常见 390–500px 侧栏。
- 首迁移和自动云端回读已完成：17 类有值文档、7 个当前 Profile（含 1 个用户新增 Profile）、6 个表格项目、2,905 个外链站、29 条核验提交记录、76 组/136 条当前时间线。6 个有整理媒体的 Profile 已上传 30 个 R2 对象（6 Logo、24 截图）；30/30 可下载，SHA-256、大小、Profile 引用和迁移字段引用全部一致。
- 2026-08-26 晚间批量开页已导致 Chrome 卡死；后续必须一页一关。

## 2026-09-05 2.8.1 半自动补齐

- 账本新增 `publicationStatus`：已提交 / 待审核 / 已上线。`status: success` 仍用于跳过，不把点提交或人工确认直接当成已上线。
- Settings 增加「标准 WordPress 评论预检通过后可代点提交」，默认关闭；有验证码仍停。
- 10 个熟站 playbook（TheJOAI、Launching Next 等）：侧栏打开页面即显示「熟站」芯片和说明；外链库 meta 带熟站名。
- 链接监控发现 live 时只升级为已上线，不降级、不撤销成功。
- 标注截图视觉兜底已在 3.2.0 接入；博客仿写仍暂停。不追验证码代打。

## 2026-09-08 边填边扩库 + 无验证码提交

- 未知栏会起稳定字段名写入当前 Profile 的 `fields`（Discord / Founded year / Integration list 等），并随 `siteProfiles` 同步 Neon。本站一次性选项（目录分类、How did you hear、同意条款、验证码、评论）不入库。
- 目录站默认无验证码代点提交；有验证码则页签留下、释放并发、开下一站。点完必须看到回执才写账本。设置「目录站无验证码可代点提交」默认开；批量「仅填表」仍可关掉。
- 标准 WordPress 评论代点开关默认仍关。登录 / OTP / 付费 / 自定义控件失败仍停，不硬提交。
- 实现：`inferReusableProfileKey` / `learnProfileFieldsFromFill`、`submitFilledForm` / `tryAutoSubmitFilledForm`。

## 2026-09-08 批量崩溃修复（3.1.5）

- 根因：2,905 个外链展开为最多 17,250 个任务时，每个任务都复制约 7.6KB Profile 配置；全选时队列序列化可达 234MB，并继续整批写入 `chrome.storage.local`、回传侧栏和一次性创建 DOM，导致扩展进程崩溃。
- 修复：每个 Profile 配置只构建/保存一份；恢复快照改为 Profile + destination + task tuple，当前全量 17,250 任务复测约 1.21MiB；侧栏每次只接收/渲染 180 条滚动窗口（约 107KiB），但统计仍使用真实总数。
- 调度：`processQueue` 增加单实例锁；修复建页失败时 running 任务不落失败、最后页签关闭后批次不结束两处状态机问题。
- 日志：后台持久化最近 400 条结构化批量日志，包含 runId、时间、阶段、任务序号、域名、Profile、状态和异常栈；侧栏关闭重开不丢，并可一键复制。
- Chrome 3.1.3 实机冒烟确认批次可启动且不会崩溃，同时抓到并修复三项运行态问题：内容日志重复、停止后日志标题仍写运行中、后台自动开侧栏违反 Chrome 用户手势限制。3.1.4 重载后确认日志去重、持久化恢复和无新增自动开栏警告；另补旧日志从 `activeBatchRun.status` 回读终态，形成 3.1.5。
- 验证：全部扩展/Worker 脚本语法检查、17 个 Node 测试文件及 `git diff --check` 通过；真实 Chrome 重载与安全小批量验收见 `docs/外链插件批量崩溃修复-2026-09-08.md`。

## 后续边界

- **2.8.0 已内置三候选 AI 评论**，社区/论坛候选可小流量试投，但仍人工确认成功。
- 首迁移完成前，保留历史 `Link Submit` 快照与 JSON 备份作为只读灾备；完成后以 Neon 工作区为准。`Submit` 历史勾选不当成功，永久跳过仍只认 `submissionRecords` 证据。
- 不破解验证码、不绕过付费墙；仅明确成功证据或人工确认打勾。
- 提交时同一时间只保留 1 个工作页签；验证码最多留 1–2 个。
- 目标：Video **30/30**；RainbowPet **12/30**（下拉用 **RainbowPet**）；OldPhotoLive **6/30**。电话 `+8615766379321`。
- 新提交、审核、收录、拒绝和跟进都写入时间线；设备间以文档版本冲突保护，冲突时先从云端回读。
- 媒体首迁移后由 R2 私有保存；表单上传走 Worker 读取 + `File` / `DataTransfer`，不用启动本地服务。
- **使用前**：重载扩展 **3.2.0**；云端连接、状态首迁移和媒体首迁移已完成。检查队列质量闸门、「目录站无验证码可代点提交」（默认开）和标准评论代点开关（默认关）。切站后看侧栏当前网站名称/URL 是否对得上，再让自动提交继续。

## 2026-09-08 批量控制与 Product Hunt 修复交接

- 扩展版本升级到 **3.1.6**。
- 批量状态现明确区分 `running` / `paused` / `stopped` / `waiting_manual`；暂停只冻结调度和当前自动动作，保留队列、页签与已填写内容，继续后恢复。
- 停止通过 `closeAutomatedTabs()` 选择普通自动页；`needs_login`、`needs_captcha`、`needs_otp`、`needs_manual` 和 `custom_launch` 页签均保留，`parkedTaskIds` 不再清空，停止后关闭页签事件也不会重新启动队列。
- 就绪判断要求标签页 `complete`、内容脚本可探测且内容信号连续稳定两轮；标题壳/loading 不算 ready，超时人工原因会包含 tab 状态、稳定轮次和探测错误。
- Product Hunt playbook 为 `custom_launch`，稳定就绪后以「Product Hunt 多步骤发布需人工完成」和 `needs_manual` 停放，禁止普通目录无验证码代点提交，也不会误写成“需登录”。
- 二轮 review 又补齐停止终态拦截、串行化 `activeBatchRun` 写入、导航后的统一稳定就绪、loading + 可交互假阳性、OTP 队列闸门，以及无页签人工确认后的停放清理。
- RED：新增行为测试首次运行在缺少暂停控件时失败；GREEN：`node tests/batch-controls.test.mjs`、`node tests/ui-workflow.test.mjs` 与 `node --test tests/*.mjs` 通过。
- Chrome 实机边界：仍需用户重载扩展后在隔离/授权目标确认暂停/继续动作、停止后人工页签保留及 Product Hunt 不自动点击发布；未把静态测试或本地模拟当作第三方成功回执。

## 2026-09-09 Product Hunt 真实页面二次修正（3.1.7）

- Chrome 仅填表小批量 `run-mttd4yo2` 复现两个剩余问题：标签仍显示「请稍候…」时就转 `needs_manual`；根路径与 `/posts/new` 各开一个 Product Hunt 页签。
- 就绪信号现同时检查浏览器标题和正文，「请稍候 / Just a moment / Loading」标题壳即使有临时控件也不算 ready。
- Product Hunt 作为主机级唯一目的地，根路径、`/posts/new` 和既有成功记录按 `producthunt.com + Profile` 合并，一轮只会打开一个页签。
- 后续真实小批量又发现 Neil Patel 根路径与 `/submit` 是同一站点的两个入口，已同样按主机合并；暂停/继续日志改由后台单一写入，停止请求与最终停止不再出现同文案重复日志。
- 主机级合并兼容旧路径级成功记录、人工标记、软删除和 Service Worker 重启后的人工页签恢复；saved URL 也不会覆盖表格中的 Profile 限制。
- Chrome 3.1.7 仅填表补测覆盖 AnswerThePublic、SideProjectors、The Joai、AI Pure、TopAI 等真实页面：暂停后队列不前进，继续后恢复；停止只关闭普通自动页，保留已停放的人工页签。手动回到 Product Hunt 队列项观察超过 30 秒，标签仍为「请稍候…」时侧栏保持「正在打开」，未立即转人工。
- 本轮没有点击任何第三方最终提交，也没有把填表或人工停放写成成功回执；新的真实批次会清理上轮由插件追踪的人工页签，但不会动用户原本打开的 Product Hunt 产品页。
