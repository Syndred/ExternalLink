# 无扩展重构恢复记录

> 2026-10-05 当前进度：标记清除、执行日志查看和内容引擎日志接入已补入，353项回归及六页界面验证通过。原批次仍暂停13/30，剩余9个后台动作待对应；完整迁移未完成。本次提交保存已验证源码和[最新迁移进度](迁移进度-2026-10-05.md)，人工控制开发模块尚未接入，不计为完成。

> 2026-10-01 当前结论：原插件完整迁移仍未验收通过。最新实现、351项回归、真实运行状态和剩余12个后台动作见 [最新迁移进度](迁移进度-2026-10-01.md)。下文为历史恢复记录，不能将此前的局部完成表述当作全功能迁移结论。

目标：完成 ExternalLink 无扩展重构与全链路验收。原始授权与停止标准来自本聊天的实施任务；未完成全部标准前不得标记目标完成。

## 2026-09-30 起点

- 已执行 `git pull --ff-only`，返回 Already up to date。HEAD / origin/main 均为 e2f339056e4564f49079a9de0319987252f3b2cc，左右差异 0 / 0。
- 当前 main，使用现有目录。原有未提交文档、实验及历史证据不纳入本次提交、不删除。
- 已建立持续目标，无预算。按已批准方案直接执行，无须重新设计或审批。
- 当前运行核心依赖 extension：shared.mjs、engine.mjs、workbench-sync.mjs、runtime.mjs 库文件以及工作台静态资源。旧代码在完整验收前保留回滚。
- 本机 SQLite 约 406 MB，存在 WAL；须用 SQLite 在线备份，不直接复制活动数据库。

## 执行顺序与验收门

1. 一致性备份、云端只读快照、完整产品/媒体/外链/账本/任务盘点及校验值。
2. 独立核心；无扩展 Chrome 的常规自动化 → 后台 AI 同页接管 → 真实回执闭环。
3. 四页面、完整资料与媒体迁移、外链库维护、站点×产品矩阵、多产品批次、统一助手工具。
4. Gmail 只读 OAuth、本机凭据、增量同步关联与长期续期实测。
5. 断网/后台与浏览器重启/空闲更新恢复测试；Windows 与实体 Mac 实测。
6. 冻结 30 个站点×产品组合覆盖全部实际产品、同站多产品、登录媒体。启动后不更换失败项。每项保存边界、实际内容、媒体版本、页面和邮件回执；未知先核验、不重投。
7. 全部闭环后才停止扩展依赖，提交推送并给出统一入口；测试与真实投稿分别报告。

## 当前未完成

所有全链路验收门仍未完成。本次已冻结并启动 30 组合验收，真实投稿回执仍为 0。历史成功和测试不能算作本次成果。实体 Mac、Gmail 授权与必需真实资料如缺失，保留明确未验收状态，继续其他可执行工作。

## 已保存证据与实现（2026-09-30）

- SQLite 在线备份：`C:\Users\Administrator\.externallink-backups\no-extension-2026-09-30T05-12-20-552Z`；integrity_check=ok，751 任务，outbox=0，988 证据文件校验；SQLite SHA256 `037d373127e5638920ecdebcf68dae71d93ec9df2d36af249fc94babafac30e5`。包含本机原配对材料，只能留本机，禁止入 Git。
- 云端只读完整快照：`C:\Users\Administrator\.externallink-backups\audit-no-extension-2026-09-30T05-13-19-640Z`；快照 SHA256 `0bd9b96df3f70f34db6ca33fb94b4f1c725f2a5dc7eb512796bde3dfa7fce417`。实际产品 8 个：GraffitiName、JevPlay、OldPhotoLive、RainbowPetAI、RspAi、TextComparison、VideoToArticleAI、site-mu4wlxu0 (AISpeakLearn)。云表 projects 6 个全部包含于上述清单。云库 2905 表行 + 67 URL 行，按现行目标身份去重 2911；15 个本机批次。
- 独立 `core/` 抽取：shared / engine / workbench-sync / runtime 库入口不再加载 extension；表单引擎使用显式 host services，不注入 chrome.runtime/storage。旧工作台展示静态资源尚待四页面替换，不宣称已完全移除扩展依赖。
- `node executor/test/standalone-core.mjs`：无扩展测试 Chrome，5 字段填写，校验通过。**合成表单回归，不是真实投稿**。
- `node executor/test/agent-same-page.mjs`：真实 agent-browser 控制测试 Chrome 的原 target，2 动作/2 模型替身调用、无新页面、交回执行器。**模型替身回归，不是真实云端 AI 或真实投稿**。
- 后台 preparation takeover 已接入普通字段/下拉/多步失败；限制 20 动作/10 次模型、2 次无进展换策略；每次模型/动作边界写入原 SQLite 事件。提交未知禁止 preparation；最终提交由原执行器单独建立边界。云端新增同租约/版本/未提交校验。
- agent-browser 首次原宿主连接失败已查明：host.json 指向的 127.0.0.1:62569 无监听。测试 Chrome 实际连接成功，不更换接管框架。尚须恢复专用真实宿主，并验证不加载扩展。
- `node --test tests/*.test.mjs`：255/255 通过，无跳过。输出 `executor/test-output/no-extension-full.txt`（本机忽略目录）。Worker `deploy --dry-run` 构建通过。
- 下一步：部署接口并实测云端模型及控制权拒绝；补齐接管恢复缺口和媒体保存；冻结 30 组合，在同一真实应用路径完成首个真实闭环。随后继续四页面、完整迁移、多产品统一接口、Gmail、恢复更新与双平台实测。

## 决策

- Ruling: 沿用用户明确指定的现有 main 目录，不创建工作树；保护并记录所有已有改动。用户授权优先于技能的隔离默认建议。
- Ruling: 已批准完整实施规范为绑定规格。将技能执行账本放在本文件，避免丢失恢复状态；不重新讨论方案。

## 当前恢复点（2026-09-30，接管链路）

- 固定验收 ID `no-extension-30-2026-09-30`，SHA256 `4270c01854f887f053dec49bc28c00391d49d9851bf84680811e17eaca49a146`；覆盖 8 产品与 bai.tools、navtools.ai、once.tools、neeed.directory、toolscout.ai；固定 30 组合，开始后禁止换项。公开范围 `docs/evidence/no-extension-2026-09-30/frozen-30.json`；完整冻结资料/媒体版本只在本机 SQLite 与 acceptance-no-extension-30/frozen.json。
- NEEED × JevPlay 使用原任务 `80606c9e-b85d-4eaf-a71c-e08629869bd8`。真实云端模型已在专用 Chrome 原页接管：选择免费路径、继续基本 Google 登录、进入产品表单；累计 9 次模型调用 / 20 动作，达到动作上限。三次原任务准备结果分别保存 timeout、导航上下文变化、action_limit；均未点击最终提交、无提交边界、无回执。该预算必须保留，禁止重置或借旧模型补救分支绕过。
- 实际专用 Chrome 使用原 browser-profile-stable，`--disable-extensions`；host endpoint 已恢复，agent-browser 可连接同一 target。原 98 条待执行任务保持暂停，禁止通过全局 resume 混入固定验收。
- Worker 已部署版本 `204a1c65-92e3-402b-b372-9ac6fc131b05`，现有模型准备请求 55 秒服务超时 / 60 秒客户端边界，关闭该调用的 thinking 并限定响应 token。最新自定义下拉 popup 策略与剩余字段提示尚需再次部署。
- 本机媒体审计共 76 引用，44 验证缓存；30 项为旧 Mac 本地路径，2 个 VideoToArticleAI 截图返回 HTML，保留缺失事实。缓存素材使用冻结引用+SHA 校验，记录实际上传媒体来源/哈希。
- 最新完整测试 `node --test tests/*.test.mjs`：270/270 通过，无跳过；合成测试与真实投稿严格分开。普通填写先行、AI 只修剩余字段、动作预算耗尽后允许只读准备核验；每次准备保存实际字段、附件哈希、校验与质量问题。
- 下一步：部署最新准备策略、暂停空闲时重启后台（保留 Chrome），读取原任务正常填写后的结果。随后实现多产品固定批次与独立四页面，补齐 Gmail、本机恢复与双平台验收。全链路完成前不宣称已移除所有扩展展示依赖，不标记目标完成。

## 第一个真实无扩展回执与页面迁移

- BAI × GraffitiName 原冻结组合，task `b2f98f42-967d-4d31-b1b9-b75a9ef44065`，统一 `/runTask` → 原执行器；2026-09-30T06:40:08.991Z 收到 `Submission Successful`，免费申请，状态 pending_moderation。产品名和官网实际填写正确；此表无媒体字段。D1 submissionRecords revision 3 精确 taskId 回读一致，cloudVerified=true，页面截图已亲自查看。公开证据 `bai-graffiti-result.json` 和 `bai-graffiti-cloud-readback.json`；只算已收件，不算上线或邮件回复。
- NEEED 的一次 `prepared=true` 经截图复核确认漏检自定义必填项。现已修正单控件容器 label、data-placeholder 下拉、隐藏文件必填和截图快照；真实重检识别 4 必填为空，保留 action_limit、9 calls / 20 actions 与未提交状态。错误准备结果不作验收证据，保留审计链；`neeed-custom-validation-recheck.json` 为纠正结果。
- 30 个组合全部已注册，固定分母和原 ID 不变；注册意图先落 SQLite，失联不创建替代任务。应用 `/runTask` 可继续冻结的任意产品原任务，单任务调度不混入历史 98 条 pending、不重置旧 AI 预算，未知提交仍拒绝执行。
- 默认网页迁移为 application.html/js/css 四页，不创建 chrome API 适配对象；旧临时工作台仅 `/legacy` 留作回滚。尚未完成所有功能和实体 Mac 验收，不宣称全重构完成。
- 外链库 import/edit/mark 代码已加入独立 core、D1 版本 CAS 与 SQLite 持久待同步；断网编辑、未知写响应回读不重写、并发冲突保留两边的测试通过。新 library 接口仍需部署与真实应用读回。
- Worker 最新已部署 `1e056a06-509a-4d9d-8c48-1709e2a1490a`，所有云端执行模块改用 core；其后新增的 library 接口尚未部署。后台与 workbench 的最新 UI/API 尚待暂停空闲重启。
- 最新完整测试 280/280，无跳过；无扩展四页 UI 合成浏览器测试通过（分页、矩阵详情、资料保存），不计为真实站回执。继续：上线本机四页并用真实 8 产品/2911 库验收，完善资料和媒体持久修改、固定批次执行、Gmail OAuth/增量关联、统一任务工具、恢复更新及实体 Mac。

## 2026-09-30 用户调整：先完成功能，暂停投稿

- 用户明确要求“先完成重构功能 先不提交”，已通过真实工作台暂停，后台 readback paused=true / busy=false / pendingEvents=0。固定范围仍为 30，当前游标 13，已有 6 个 BAI 原组合收件；不继续真实投稿、不替换失败。acceptanceBatch 已落盘 paused，原因记录用户要求。后台重启保持暂停，历史队列未释放。
- 四页已在真实应用读到 8 产品、2911 外链、30 原验收任务；Worker 最新版本 c27ac0d1-6b16-4cfc-b3f4-f1c0b296b872。library import/edit/mark 已部署，SQLite 先写持久待同步，CAS、独立回读、并发冲突保留。本机 profile 编辑也已改为该持久流程，最新代码尚待重启用于真实编辑验证。
- Google Cloud 专用项目 externallink-gmail-readonly 已创建；用户授权确认 Google 条款和创建，OAuth 桌面客户端已下载并自动导入本机系统凭据库，无须用户复制密钥。Gmail API 已启用，唯一 scope 为 gmail.readonly，仅添加本人测试账户。凭据未写入仓库。
- 真实 Windows Gmail 授权 07:44:33Z 成功，07:45:15Z 真实刷新令牌并在 07:45:16Z 用新 access token 读取同一邮箱验证成功。本机 keyring 凭据跨进程恢复已验证；SQLite state/outbox 扫描未发现 access/refresh token。公开脱敏元数据 gmail-oauth-refresh-real.json 和截图 gmail-connected-real.png / gmail-workbench-real.png。
- 首轮一次性导入读到 171 封后 HTTP 403 停止，未推进增量游标；改为每轮 25 封、持久 pageToken，重启续接，所有新消息落盘后才推进 historyId，404 重建游标。07:49 实测 connected / 265 封真实邮件 / 3 条站点+产品关联 / 初始导入仍未完成。关联不自动认定审核或上线。邮件内容仅保存在本机。
- Gmail 已集成本机 authenticated API 与工作台连接弹窗、每分钟同步、只读 scope 校验、PKCE、一次性本机回调、续期和撤销授权状态。Google 测试应用仍处于 Testing，长期权限有效性及实体 Mac 尚未验收，不能称全链路完成。
- 自定义下拉正常填写已修复 prose placeholder 误判；先复现失败后无扩展合成 Chrome fixture 通过，不增加任何真实回执。最新完整测试 292/292（之后新增产品持久修改测试还需重跑全套）。独立四页浏览器回归通过。
- 当前以功能完成为先：完善媒体上传/版本/停用引用、产品增删、外链库冲突处理、统一工具入口、断网重启/更新验证。真实投稿等用户允许后继续；目标保持 active，尚未提交/推送源代码。已再次 fetch，HEAD 与 origin/main 0/0，同 e2f3390；最终完成前仍须拉取最新远端。

## 新会话已完成的功能与真实验证（2026-09-30）

- 新会话持续目标已建立，保持 active，无预算。再次 `git pull --ff-only` 返回 Already up to date，HEAD...origin/main 0/0，仍 e2f3390。未提交/推送源码，无 worktree，无子代理，历史改动全部保留。
- Gmail 旧记录兼容迁移已运行：迁移前 650 个旧键无 emailAddress，迁移先持久化原邮箱身份、可中断重入；其他账号同 ID 邮件隔离；无原邮箱的记录隔离不展示。刷新和定时同步串行，换账号清除旧游标。详情 API 真实 SHA 读回一致。关联加实际 attemptBoundary 时间约束，未知时间为 candidate，不算收到回复。
- **关联计数纠正**：早先新会话报告的 6 条邮件关联包括旧 alias 与新 scoped 记录重复，真实唯一消息为 **3 封**。本机已保留旧记录，但读取只取当前账号 canonical 记录并去重；canonical unmatched/candidate 优先于旧历史匹配。固定批次的 **6 个 BAI 收件**是独立真实投稿回执，不受此邮件计数纠正影响。
- Gmail 90 天初始导入已完成，694 封；真实 history 增量同步（本次无新邮件）、令牌刷新、后台重启读回均成功。Testing 授权元数据到期为 2026-10-07T07:44:34.750Z，不能称永久或长期验收完成。邮件正文未输出公共证据，凭据仅系统 vault。
- 产品新增、归档/恢复、媒体上传/不可覆盖版本/停用/恢复、同步冲突选择已实现本机持久意图 + 原 D1 CAS + 独立回读 + 页面入口。图片验证 PNG/JPEG/WEBP 签名、6 MB 和 SHA；上传未知先 exact asset ID/产品/kind/MIME/SHA 读回，历史媒体只能追加不能改写或删除。停用阻止字段 fallback 与新任务冻结引用；完整 fields + media 清单按封面/Logo/截图去重。
- 真实工作台创建隔离产品 `product-6c200c9d-f7d0-4fbe-8aa2-46dc2e213cc3`（官网为 .invalid），上传两媒体版本，停用、恢复第一个版本、归档/恢复全部独立云端确认；最终为 archived=true，保留供恢复审计。原 8 个产品和固定 30 冻结数据哈希一致。它不属于固定验收分母，没有投稿任务。
- 真实并发冲突在该隔离产品产生；两份 Note 保留，通过 UI 选择本机编辑后 confirmed，原云端版本保留于 resolution；云端版本变化需重新比较。选择保留云端的媒体冲突会保留已上传 asset 并结束引用待同步，不无限重试。
- 云媒体图片预览 blob CSP 问题已复现并修复，两个真实素材 img.complete/naturalWidth 验证加载。新产品详情提供完整常用字段编辑；页面没有使用 chrome.runtime/storage。
- 多产品统一本机 stdio MCP 实现 14 工具，原 taskId + acceptanceId 原执行器，没有全局 resume，无凭据导入/输出工具。真实 stdio 到后台读取通过；新增本机 Codex `externallink-local` 配置，备份原 config，真实 Codex app-server 启动握手和 tools discovery=14 通过。当前聊天工具目录未热添加，尚未声称当前聊天直接调用注册工具。
- 断网测试使用真实 HTTP 连接断开、磁盘 SQLite 关闭重开；意图 ID、paused、固定游标、unknown attemptBoundary、AI 预算保持；云写入后响应丢失则独立回读，无重复写。
- Windows 真后台/工作台在暂停空闲时多次重启及载入更新；配对和会话保持。专用 Chrome 已真实重启，仍 browser-profile-stable / disable-extensions；NEEED 原任务恢复为新 target，原 ID 和 9 calls / 20 actions 未改变，prepared=false/action_limit，submitted=false，云端预算独立回读一致；旧 BAI 收件保留。没有清空登录目录。
- 最新完整测试 `node --test tests/*.test.mjs`：**314/314，无失败、无跳过**。输出 `executor/test-output/no-extension-full.txt`。`node executor/test/application-ui.mjs` 四页无扩展浏览器回归重新通过；此前一次 headless 启动暂时退出，重试通过。真实与合成证据分开。
- 媒体待同步已加入暂停后台 tick 的重试条件；只有媒体意图时也能同步，测试证明不调用投稿 work、不放开固定批次 paused。最后修正已在暂停空闲后台加载。
- Worker 最新版本 **83f7bd81-5dd3-4d73-948e-6ec69601ece6**，应用 https://externallink-cloud.syndred.workers.dev；D1/R2/模型原配置保留。本机后台已加载最新 Gmail 去重；云端库/产品/媒体接口已部署。
- 真实证据：`gmail-migration-real.json`、`gmail-history-restart-real.json`（其中早期 associatedCount=6 是去重前记录，以上纠正为准）、`app-media-real.json`、`conflict-real-before.json`、`conflict-real-after.json`、`assistant-mcp-real.json`、`assistant-client-real.json`、`browser-restart-real.json`、`media-management-real.png`，均位于 `docs/evidence/no-extension-2026-09-30/`。

### 尚未完成与必须保持的边界

- 固定 30 验收 paused，cursor=13，6 个 BAI 收件；不自动启动/恢复投稿、不替换失败项、不重置预算。原 98 pending 和未知边界保留。
- 实体 Mac 没有设备证据，旧 Mac 媒体缺失项仍缺失；不能用 Windows 或平台单测冒充 Mac 验收。
- Gmail 长期运行、下一次真实新邮件增量、Testing 到期后重授权尚未跨时间实测；本次 history 无新增邮件，不能冒充新邮件验收。
- 客户端配置及真实 discovery 已确认；当前聊天尚未直接调用新工具，后续新连接需要实查。Google 应用不自行发布。
- 原工作台 legacy 与原扩展回滚保留。用户允许继续投稿并完成全部验收后，才讨论最终移除及源码提交/推送。持续目标不得标 complete。

## 当前聊天 MCP 调用实测（2026-09-30 后续连接）

- 当前工具目录已载入 externallink-local；直接调用 app_data(refresh=true)、gmail_sync、task_detail 三工具全部成功，补齐了此前只有 discovery/独立 stdio 的证据缺口。证据 `docs/evidence/no-extension-2026-09-30/assistant-current-chat-real.json`，不包含邮件正文或凭据。
- 真实云端刷新后 paused=true / busy=false，pendingEdits=0 / pendingMedia=0 / pendingEvents=0；固定 30 的 scopeSha256 和 cursor13 不变。NEEED 原 ID、无 attemptBoundary、AI9/20/action_limit 均保持；没有调用 run_task 或 prepare_task。
- Gmail 最新 history 同步 connected，694 封、3 封唯一关联、lastImportedCount=0；下一封新邮件与长期授权仍未验收。实体 Mac 仍无设备证据。持续目标 active，不宣称全部完成。
- 本轮再次 git pull --ff-only 返回 Already up to date，HEAD...origin/main=0/0；没有提交或推送源码。此前“当前聊天尚未调用工具”的记录是历史状态，以本节实测为准。

## 用户延后Mac验收及使用交付（2026-09-30）

- 用户明确答复“先预留mac就好 然后告诉我怎么用 到时mac不行我再叫他修”。实体Mac不再作为当前使用交付的前置条件；原启动入口和平台分支保留，仍标未实机验收，不继续索取Mac连接。
- 新使用说明 `docs/no-extension-usage.md` 说明Windows双击入口、四页功能、暂停批次、Gmail只读/Testing到期及Mac首次/日常命令。为避免让Mac拉取尚未推送的旧版本，提供本次当前源码预览包 `C:/Users/Administrator/.externallink-backups/ExternalLink-mac-preview-2026-09-30.zip`；包不含node_modules、系统凭据、SQLite、邮件或浏览器profile。120条目，514871字节；SHA与manifest见 `mac-preview-package.json`。
- 逐项审计文件 `docs/no-extension-completion-audit-2026-09-30.md` 明确真实、合成和未验证边界。长期Gmail及下一封真实新邮件仍未跨时间验收；不因此伪造邮件或放开投稿。

## 剩余外部验收受阻（2026-09-30T09:41:33Z）

- Mac按用户要求延后；Windows功能和使用交付已完成。连续三个目标轮次复核同一剩余条件：Gmail connected、694封、没有新邮件，授权到期仍在2026-10-07。后台进程正常，无待同步故障；重复测试/即时刷新不能证明跨时间长期授权。
- 持续目标标记 blocked，原因仅为真实新邮件和长期授权实测依赖外部状态/时间推进；不是功能完成、投稿恢复或进程停止。Gmail后台原定一分钟只读同步继续运行，固定30仍暂停13/30，未投稿/commit/push。
- 条件具备后继续原验收；不得伪造邮件或时间、替换原固定组合或复位未知边界。不新增自动提醒或发送邮件。

## 用户授权提交源码（2026-09-30）

- 用户要求“ok先提交 然后我验收 具体怎么用现在”，已提交并推送main：274bdb2。只包含本轮core/Worker/执行器/四页/测试/使用说明；旧实验、历史证据与无关文档保持本地未提交，不删除。
- 提交前隔离暂存代码测试：314/314。首次标准Windows CRLF检出发现两项旧文本fixture失败，已正规化两测试读取文本的换行；默认Windows检出再测314/314。暂存空白检查通过，凭据扫描未命中。
- 推送后git pull --ff-only Already up to date、HEAD...origin/main=0/0，提交已远端同步。工作台已请求打开；真实appData仍paused/busy=false、cursor13/count30、pendingEdits/pendingMedia/pendingEvents=0，没有恢复投稿。
- 原“未提交推送”限制被本次源码提交授权替代；投稿暂停及未知原边界仍有效。Gmail长期授权受阻状态不变，Mac依用户要求预留。
