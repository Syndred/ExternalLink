# PROJECT_CONTEXT

- **2026-09-24 21:50 / AISO 跨 Profile 草稿保护**：3.7.33 已在 Ego 重载，OldPhotoLive AI 来源页正确显示 1 Profile、2 动态，公开页补登 `已上线` 后侧栏提示「云端动态已核对，当前记录是最新的」。切换 Graffiti 时发现 AISO 将 OldPhoto 草稿保留到新标签：插件因旧官网阻止覆盖是正确保护；人工改为 Graffiti 官网后，插件仅填空栏、未清旧名称和介绍。3.7.34 新增同一表单“官网已换、产品名仍是旧款”识别，清理旧草稿再填当前 Profile；回归通过，待重载实站确认。

- **2026-09-24 21:45 / AISO Tools 公开收录与插件修复**：OldPhotoLive AI 通过免费表单取得 `is live` 回执，公开页 `https://aisotools.com/tool/oldphotolive-ai` 能打开且链接指向产品官网（`nofollow`）。累计 **39 个真实产品×站点回执、15 站、12 站三产品齐全**。插件自动提示已保存回执，但 `/submit` 页没有归并 `/submit/success` 的记录；3.7.33 将 AISO 多路径归为同一站点，并修正 Pricing Details 误填长产品介绍。52/52 Node 回归通过；待 Ego 重载、精确 Profile/云端回读及另外两产品实站提交。今日新 `outlink` Key 的 DeepSeek 后台统计截至 21:45 为 1 次、127 Tokens、<¥0.01，可能延迟 5 分钟。已关闭约 60 个已用完/无关的提交页，仅保留 DeepSeek 后台、AISO 工作页和 5 个验证码页。

- **2026-09-24 21:40 / Taify 字段修复**：3.7.31 重载后插件在 Taify `/submit` 能开始填写，证明侧栏阻塞修复生效。实站发现该站 React 表单的 `<label>` 与输入框并列但未绑定 `for`：名称/邮箱漏填，单行标语误填功能清单，截图 URL 多行栏误填整段介绍。3.7.32 读取单控件容器内相邻可见标签，并对截图 URL 列表仅使用公开图片直链；定向测试通过，待重载复验。页面 DOM 含 `cf-turnstile-response`，最终提交需按验证码门槛停放，不能计成功。

- **2026-09-24 21:30 / 云端与运行态复验**：Ego 已重载 3.7.30，设置页显示冲突键仅 `activeBatchRun`（旧批次状态）；Forward Future 侧栏强制刷新后明确显示三 Profile、三动态且「云端动态已核对，当前记录是最新的」，因此该站三条已完成 Neon 回读。旧批次冲突仍保留本机备份。IndexOf.AI 免费提交需登录，未计数。Taify 有免费普通表单，但重载后侧栏一直“加载中”使检测/填表无反应；3.7.31 将当前页刷新中的站点标记加载改为非阻塞，待重载实站核验。仍是 38 个真实组合、14 站、12 站三产品齐全。

- **2026-09-24 21:20 / 最新进度**：Forward Future 官方免费表单的 Graffiti Name AI、OldPhotoLive AI、JevPlay 均收到 `Tool submitted. We'll review it shortly.` / `under review` 回执；插件自动生成三个准确 Profile 的待审核动态。累计 **38 个真实产品×站点回执、14 站、12 站三产品齐全**，距每款 30 站还差 18 个完整站点。3.7.30 修复 Key features / Use cases 重复长描述、付费生成被“免费浏览”误判为 Free、行业/职业无依据乱选，并在设置页显示具体冲突文档名；全量测试已过，需 Ego 重载实站复验。当前侧栏三条仅能证明本地自动记账，云端刷新仍显示待保存；设置页显示 1 类冲突与 4 类修订不同，重试上传被拒。已导出本机备份 `~/Downloads/externallink-backup-2026-09-24 (2).json`，不得称 Neon 已验收。AI Tool Claw 站方报错、Linkrena 提交跳登录，均未计数。

- **2026-09-24 21:06 / 最新进度**：Launchpedia 官方嵌入 Tally 对 JevPlay、OldPhotoLive AI、Graffiti Name AI 各显示最终 `Form submitted / Thanks for completing this form!`。JevPlay 在旧版人工补记；OldPhoto 与 Graffiti 在 Ego 已重载的 3.7.28 自动填表、自动记账，来源侧栏显示 3 个 Profile、3 条动态，刷新后无待云端保存提示。可选 Affiliate Link 保持空白。累计 **35 个真实产品×站点回执、13 站、11 站三产品齐全**；距 30 个完整站仍差 19 站。Tally 旧邮箱在切换 Profile 后可能保留，OldPhoto 提交前人工改为业务邮箱；3.7.29 已修自动填表时把不匹配的邮箱改为当前 Profile 的有效邮箱，待 Ego 重载复验。

- **2026-09-24 20:50 / 最新进度**：Startup Collections 的官方嵌入式 Google Form 已分别收到 JevPlay、OldPhotoLive AI、Graffiti Name AI 的 `您的回复已记录。` 回执；三份都选免费排队、拒绝 $10 加速。插件正确自动填入三组产品名称、官网、描述和联系人，但未识别嵌入表单的点击与回执；已按现场证据在同一来源站逐份人工登记，侧栏显示 3 个 Profile、3 条动态，刷新回读 `云端动态已核对，当前记录是最新的`。累计 **33 个真实产品×站点回执、12 站、10 站三产品齐全**；距离 30 个完整站点还差 20 站。3.7.27 扩展提交监听到来源绑定的嵌入式 Google Form，要求精确产品域名、带标签的网址栏和最终确认链接，代码回归通过，待重载并在下一家实站验证。验证码、登录、付费、法律确认继续停放。

- **2026-09-24 20:40 / 最新进度**：AI Tools Inc 的 JevPlay 收到官方 Typeform 最终 Thanks 回执，3.7.24 自动记账；该站三产品齐全。AI SuperHub 免费表单的 JevPlay、OldPhoto、Graffiti 均逐份跳转官方 `Submission Received!` 成功页，插件分别提示自动保存；来源站侧栏显示 3 个 Profile、5 条动态（Graffiti 因人工核验重复追加），点击刷新后回读 `云端动态已核对，当前记录是最新的`。累计 **30 个真实产品×站点回执、11 个站点、9 个站点三产品齐全**；目标是 30 个站点各三产品，仍差 21 个完整站。3.7.25 已在 Ego 重载，实站空表单能转为需人工处理；随后发现 `0/30 words` 被当成 30 字符上限，使短描述漏填。3.7.26 修正词数计数单位及打开的自定义选单误报可提交，52 组回归通过，待 Ego 重载实站复验。验证码/登录/付费/法律确认继续停放。

- **2026-09-24 20:15 / 最新进度**：AI Tools Inc 的 OldPhotoLive AI 也已取得官方 Typeform 最终 Thanks 回执；自动填名称和官网正确，姓氏错填、邮箱未填，提交前已修正。3.7.23 监听到最终提交但清空上下文后复核回执时遗漏来源站地址，导致未自动记账；按现场回执在 AI Tools Inc/OldPhoto 人工补记。3.7.24 将可信来源随最终回执检查传递，待 JevPlay 实站复验。当前 26 个真实产品×站点回执、10 站、7 站三产品齐全；OldPhoto 云端补记正在回读。

- **2026-09-24 20:10 / 最新进度**：AI Tools Inc 免费官方 Typeform 的 Graffiti Name AI 取得结束页 `Thanks! We'll be in touch over the next few days to proceed with your listing.` 回执，站点侧栏补记后从云端回读确认。累计 25 个真实产品×站点提交、10 个站点、7 个三产品完整站点。实站发现插件把未提交联系信息题的 `We will be in touch` 误判为回执，且旧批次任务覆盖可信 Typeform 来源；3.7.23 修复两者，并将 AI Tools Inc 首页来源归一到 `/submit`。定向回归已过，待重载后用 JevPlay、OldPhoto 复验。验证码/登录/付费/法律确认继续停放。

- **2026-09-24 20:00 / 最新进度**：AI Marketing Directory 三产品均已取得官方 Tally `Form submitted / Page 2 of 2` 回执；3.7.22 修复此特定 Tally 成功状态识别，OldPhoto 与 Graffiti 实站自动记账，JevPlay 早一步提交并人工补记。当前累计 24 个真实产品×站点提交、9 个站点、7 个三产品完整站点；侧栏手动刷新后 Neon 回读确认此站 5 个 Profile、5 条动态最新（本轮三条）。Launching Next 有 `Quick Check` 人工验证题，已留页待用户完成，未计提交。Tally 自动填表仍漏产品名称/联系人，须继续修；下一步继续旧成功站点。

- **2026-09-24 19:50 / 当前交接**：Ego 已重载并实站验证扩展 3.7.20：AI Infinity 的 JevPlay 官方 Google Form 获审核回执，插件自动按来源目录/Profile 记账；同站 OldPhoto、Graffiti 已有人工核实记录，侧栏云端回读显示 3 个 Profile、3 条动态且为最新。当前累计 21 个真实产品×站点提交、8 个站点、6 个三产品完整站点；用户目标仍是至少 30 个站点各三产品。AI Infinity 的 Graffiti 提交暴露 Google Form `div[role=button]` 漏监听，3.7.20 已修并用 JevPlay 复验。3.7.21 另修自动证据链接取成功页，代码与定向测试通过，待 Ego 重载。下一个优先核对旧库曾成功的 AI Marketing Directory 等站。所有提交只算审核申请；验证码/登录/付费/法律确认须停放。

- **2026-09-24 / 外链提交恢复与验收**：用户新建并充值 DeepSeek `outlink` Key；已写入 Cloudflare Worker Secret，部署 `4d293a19-d070-4f0a-abbd-0119736000a7`，直接模型请求 HTTP 200。Ego 已启用扩展 3.7.16。Insidr、Human or Not、NextPedia 各完成三产品真实提交并云端回读，共 9 个组合，其中 7 次新版自动记账、JevPlay 两次旧版提交人工补记。Once Tools JevPlay、Startup Stash 三款、TipSeason 两款、AI Infinity OldPhoto、Phygital OldPhoto 与 Graffiti、TipSeason JevPlay 也取得站点回执；截至 19:33 共 19 个产品×站点组合、8 个不同站点、5 个三产品完整站点。Startup Stash JevPlay 与 TipSeason 两款自动写入本地账本，但 Startup Stash 自动目标键带 `/add-listing`，侧栏只展示域名键，造成一次人工重复补记；AI Infinity OldPhoto 的来源站归属待修。Phygital 同 URL 双标签复测发现 3.7.14 「填表」在当前标签误报空表单已填，并异步把 Graffiti 内容写进旧 OldPhoto 标签；两款真实回执已分别人工补记时间线，精确提交记录仍待核对。19:32 轻量核对显示云端修订号一致、待上传 0、冲突 0；新增记录仍需精确 Profile 回显验收。Viesearch Graffiti 仍需邮件确认，StartupBase Graffiti 仍是草稿，均不计成功。3.7.12 修复长短描述路由、时间线展示；`2f8ab90` 修复无可信回执误跳过，3.7.13–3.7.14 修复跨域回执监听但实站仍有错标签填表、漏填、目标键和显示问题。旧批次冲突及三产品各 30 站目标仍待处理。详见 `docs/外链提交验收与误填保护-2026-09-24.md`。

- **2026-09-23 / 3.7.3 云同步状态可见性**：设置页改用轻量修订号查询展示本机已保存数据与云端是否一致，分开显示待上传、冲突、需回读和本页未保存编辑；按钮和“更新 0 类”文案已澄清。45/45 测试通过；Ego 扩展重载后的实机显示因浏览器安全策略待验收。见 `docs/云同步状态可见性-2026-09-23.md`。

- **2026-09-23 / AISpeakLearn 与 JevPlay 资料和 PH 排期**：云端及 Ego 插件现回读 8 个 Profile，两站均有独立资料。JevPlay PH 排期 9 月 23 日、AISpeakLearn PH 排期 9 月 24 日，均为北京时间 15:01；提交账本分别记录 `submitted`，正式上线待核验。AISpeakLearn 的 4 张英文截图与 PNG Logo 已进入 R2。详见 `docs/两站资料与PH提交-2026-09-23.md`。

- **2026-09-21 / 3.7.2 多设备强制云端回读**：修复复制浏览器 Profile 后只有 `pending`、没有 `conflict` 时无法采用云端的问题。设置页“从云端回读”现在会先导出 JSON 备份并二次确认，再以 Neon 完整覆盖本机旧缓存、删除云端缺失键并清空 pending/conflict/patch；并发编辑保护仍保留。44/44 回归通过，详见 `docs/多设备强制云端回读-2026-09-21.md`。

- **2026-09-21 / Neon 新项目迁移完成**：用户确认本机 Ego Profile 为最新真相源。已创建新 Neon `ExternalLink` 项目 `dark-night-20420985`，建表并轮换 Worker `DATABASE_URL`；生产健康检查恢复 200。迁移后回读 20 类文档、7 个 Profile、2,975 条外链、30 条提交记录、77 组/222 条时间线。43 个 R2 媒体逐个下载校验 SHA-256/大小一致，媒体缺失引用为 0。备份与台式机连接流程见 `docs/Neon新项目迁移-2026-09-21.md`。

- **2026-09-21 / 3.7.1 Neon 流量优化**：旧 Neon 项目当月网络传输达到 5.62 GB 并触发 402。根因是启动、侧边栏动态刷新和 Submify 核验重复读取完整快照。Worker 已增加轻量修订/单文档接口；插件改为首次全量、后续按修订增量回读，侧边栏冷却调为 60 秒，配额错误改为 60 分钟退避。该旧项目阻塞已由上方“Neon 新项目迁移”解决。详见 `docs/Neon流量优化-2026-09-21.md`。

- **2026-09-17 / 3.7.0 Ego 实机同步验收**：Ego 已加载当前未打包扩展 `3.7.0`。设置页真实点击「同步 Submify 最新库」成功，绿色提示回读来源 100 条、新增 0 条、云端 2,975 条、`sheetTableData` 修订 12；本机核对 100/100 条 Submify 来源记录均存在。Submify 官网 3,314 是网页展示口径，当前插件公开接口实际只开放 100 条，不能宣称同步了 3,314 条。详见 `docs/外链库与Submify同步-2026-09-17.md`。

- **2026-09-17 / 3.5.2 ego 多浏览器同步修复**：ego 导入 Chrome Profile 会同时复制 ExternalLink 的 Worker、`default` 工作区配置与当时修订，因此两个浏览器会对同一云端数据产生正常的乐观锁冲突。已将 AISpeakLearn 与完善后的 VideoToArticleAI 定向合并入云端，回读 `siteProfiles` 修订 39、7 个 Profile。修复手动保存全文档重放和冲突回读被其他待保存键卡住的问题；源码回归完成，ego 内扩展重载后生效。详见 `docs/Profile资料完善-2026-09-17.md`。

- **2026-09-17 / 3.5.1 外链库数量与分类提交**：确认云端仍为 2,975 行，旧界面三千多是额外合并打包目录造成；外链库改为云端主数据 + 3 条独有自定义补充，并分开展示行数与目标数。侧栏选择分类后可直接为当前 Profile 启动该分类批次，继续执行成功去重和付费/登录/验证码等闸门。42/42 回归通过；Chrome 3.5.1 重载与按钮实点待现场确认。详见 `docs/外链库数量与分类提交-2026-09-17.md`。

- **2026-09-17 / 3.5.0 Submify 对标外链库**：侧栏新增「外链」页，支持十类外链、费用、语言、DR、流量、Profile 状态和站点标记筛选；Settings 复用同一分类。对比 Submify 当前公开 100 条后，向 Neon 去重补入缺失 70 条，云端回读总数 2,975；29 条社区/投稿类设为 `skip`、2 条收费站设为 `paid`。42/42 回归通过；Chrome 3.5.0 重载与侧栏真实云端回读待用户现场验收。详见 `docs/Submify外链库分类与补库-2026-09-17.md`。

- **2026-09-11 / 多设备云端合并恢复**：生产default已恢复30条提交账本，合并196条历史后扩展派生为214条时间线；6产品媒体引用恢复，30张R2图片正常。本机回读一致且无冲突，VideoToArticleAI四张截图实机加载正常。PC待以云端回读，详见 `docs/多设备云端合并恢复-2026-09-11.md`。

- **2026-09-11 / 3.4.7 外链库界面联动**：补齐设置页存储监听，使侧栏修改后自动更新外链列表与动态；合并刷新并保护未保存编辑。源码回归与实机验收边界见 `docs/外链库界面联动-2026-09-11.md`。

- **2026-09-10 / 3.4.6 全项目审计**：修复批次暂停/继续持久化与调度异常恢复、云同步并发/中断/冲突、Profile 队列切换、资料草稿保护、登记动态与评论识别/回执。40/40 回归通过；扩展内部页面工具访问受阻，不能报告全部功能已实机通过。逐项证据及待验收范围见 `docs/全项目审计与验收-2026-09-10.md`。

- **2026-09-10 / 3.4.5 动态云端回读**：修复侧栏只读旧缓存、云端补录不显示。先展示本机动态，再后台回读提交账本/时间线；保护本地待保存内容、并发改动、已前进版本和切换工作区，不覆盖当前 Profile。动态「刷新」可立即检查云端。云端 RspAi DevPages 记录仍在（3/5），旧本机为 2/4；源码 34/34 测试通过，Chrome 重载后显示待验收。顺带修正 GitHub URL 不再误填产品官网。详见 `docs/DevPages填表与动态修复-2026-09-10.md`。

- **2026-09-10 / 3.4.4 DevPages 填表与外链动态修复**：检测后立即按字段填写，AI 只补剩余字段；侧栏普通检测/填表只填写并留在当前页。新增「登记动态」入口，手动点击提交后核验新回执并按固定 Profile 入账；非评论页隐藏评论工作室。补充超时、重复点击、切站/切项目保护。31/31 自动测试通过；RspAi DevPages 已按用户确认补录云端并回读。3.4.4 实站验收受浏览器连接/安全策略阻塞，尚未提交 Comparison Text。详见 `docs/DevPages填表与动态修复-2026-09-10.md`。

- **2026-09-10 / 3.4.3 站点标记多选**：侧栏与外链库支持多选、单独取消、多个标签展示及按任一标记筛选；兼容旧标记，后台串行切换避免双页面覆盖，自动观察不覆盖人工选择。队列与机会评分检查全部标记。源码及 27 组 Node 回归通过；本轮已在 Chrome 管理页回读 3.4.3，多选实际点选仍待验收。Google 辅助登录可实现，本次仅核查方案。见 `docs/站点多选与谷歌登录-2026-09-10.md`。

> 最后更新：2026-09-24｜扩展 3.7.20（Ego 实站回读；3.7.21 待重载）｜DeepSeek 新 Key 已接入 Worker｜路线：Neon 执行账本 + R2 证据 + 本地字段优先、AI 补全
> **防串站**：批量任务按 `destination × Profile` 绑定品牌/URL/描述。自动填表只填侧栏当前选中的网站，且该网站必须在本页有待提交任务，否则不代填代点。全局评论模板不再覆盖产品文案。切站会重载评论框；提交前核对品牌和域名，对不上就停。
> **边填边扩库（可复用才存）**：填完后把空着的通用栏和未知产品栏（Discord、Founded year、Integration list 等）写入当前 Profile 的 `fields` 并同步 Neon。目录分类、How did you hear、同意条款、验证码、评论、当天日期不入库，已有字段不覆盖。
> **目录站无验证码可代点提交**（设置里默认开，批量页「仅填表」可关）。普通表单先走确定性字段填写和上传；缺失或校验失败时再由云端 /plan 理解剩余字段和选项。侧栏检测/填表保持仅填写；批量提交遵循批次配置。只有路由找不到、必填/校验仍失败、多步骤/自定义控件/富文本/上传预览需要观察时，才升级截图智能体逐步接管。看到新回执才写账本。有验证码的页签留下等人。登录 / OTP / 付费仍停。标准 WordPress 评论仍需另开开关才会代点。
> 历史 `Link Submit` 字段已作为首迁移快照保留；日常不再与 Google Sheet 同步。
> 完整进度见 [`进度.md`](进度.md) / [`docs/进度.md`](docs/进度.md)。
> 今晚中断详见 [`docs/外链提交报告-2026-08-26.md`](docs/外链提交报告-2026-08-26.md)。
> 2026-09-05 全自动差距评估见对话画布 `automation-gap`。
> 3.2.0 可信自动化实现和真实验收见 [`docs/外链可信自动化升级-2026-09-09.md`](docs/外链可信自动化升级-2026-09-09.md)。

## 同步功能验收要求

涉及提交记录、动态或外链库同步的改动，必须验证真实写入 → 云端回读 → 本机界面显示，并在重开侧栏或切换站点后核对同一 destinationKey + Profile。单测通过、点击刷新或云端写入成功均不单独代表整个链路验收完成。离线、未保存修改和冲突必须保留数据并给出可见状态；浏览器访问受阻时明确列为待验收，不报告已经跑通。

## 当前已完成

- **3.4.2 表单语义与跨项目站点经验**：Paid/Free/Freemium 产品定价字段不再直接判成提交收费。当时普通填表先由模型读取当前表单（3.4.4 已修正为本地字段优先，模型补剩余项），按当前 Profile 规划；模型不确定时保留人工复核，不永久写成 paid/broken。C 站手动标记跨 Profile 保留，自动观察单独记录；共享字段关系和最多 12 个阶段的表单结构存于 siteAnnotations，复用时用 B 的资料并核对当前字段。旧 Profile 学习只提取语义，绝不复制 A 的 value。动态回归通过；Chrome 当前加载仍只确认过 3.4.1，新版重载和真实 A/B 同站验收待完成。见 `docs/表单语义与站点经验-2026-09-10.md`。

- **3.4.1 人工页面现场保护**：用户明确要求集中处理已填好的验证码页面。撤回 3.4.0 超额关闭人工页签的策略；容量默认 20、可设 1–100，满额只等待，不清理已有页面。跨批次继续保留未解决人工页签和待办。不要把待办落盘当成表单现场保存；Chrome 崩溃或站点会话过期后的表单恢复未作保证。验收证据见 `docs/无人值守验收-2026-09-10.md`。

- **3.4.0 无人值守稳定性加固**：新增可选无人值守入口、运行时间与组合数上限、模型调用预算、人工页签上限、持久超时巡检与本轮分类报告。中断中的任务需核验后再继续，不直接重置为待提交；修复已结束批次回看以及停止状态控制按钮误显示。验收状态及使用边界见 `docs/无人值守验收-2026-09-10.md`；用户重载后已在 Chrome 扩展管理页回读 3.4.1 且已启用；实机批次行为仍未验收。

- **3.3.13–3.3.19 通用多步骤与回执修复**：提交后会等待并重新读取同 URL 新文档回执；用可见表单签名识别异步渲染的下一步，不再因页面尚未加载完而立即转人工；多步骤框架把类别、行业、主题、项目类型挂在首个 URL 表单外时，仍会纳入确定性填写。Hype Star 已实站自动完成五步提交并得到 `submitted for review` 回执；3.3.17–3.3.18 优先当前阶段最终按钮并排除推广链接，3.3.19 合并同一次自动化产生的重复回执记录。

- **3.3.12 Product Hunt 真实闭环**：OldPhotoLive AI 已由通用多步骤状态机填写主资料、Topics、Maker、定价、Logo、4 张 Gallery 和首评，并在用户确认后真实创建草稿。成功页 `https://www.producthunt.com/products/oldphotolive-ai?launch=oldphotolive-ai` 回读到草稿提示、站点链接、4 张图库、Launch Team、标签和首评；侧栏从成功页恢复 `OldPhotoLive AI 已提交` 时间线和证据链接。该结果是“已创建草稿，尚未排期发布”，不是公开 Launch。
- **异构实站门槛验收**：FutureTools 提交页在修复订阅弹窗抢占后由 1 个字段恢复为 11 个字段，并正确识别 Cloudflare Turnstile；AIPURE 真实页确认一次性付费 `$69.90`，按付费跳过；GeekWire 真实表单受西北地区总部条件和 reCAPTCHA 限制，按不适用跳过；Devpost 未登录，按登录门停放。以上均未伪记成功。
- **成功记录幂等**：同一 Profile、公开 URL、证据和发布状态的重复成功回读不再追加重复账本/时间线事件。3.3.12 之前现场诊断产生的两条相同 Product Hunt 动态仍是同一草稿回执，不代表提交两次。

- **3.2.0 可信自动化运行账本**：每轮 run、每次 attempt、每个 snapshot/plan/action/result/gate 均先写本地有界账本和持久 outbox，再幂等写入 Neon；截图证据以内容寻址写入不可覆盖的 R2 对象。侧栏可导出最近执行记录。
- **截图智能体（异常升级）**：普通表单不调用模型，先由原有确定性扫描、填写、DataTransfer 媒体注入和提交完成。仅在找不到提交入口、填写后仍有必填/校验项、复杂多步骤、自定义组件、富文本或媒体上传预览需要核验时，DeepSeek 视觉模型才读取稳定 DOM、标注截图和最近动作，逐步观察—操作—复核。验证码、OTP、缺失登录/OAuth、付费/订阅、明确法律确认和破坏性动作仍转人工；成功必须取得本次提交后的新回执、成功页、公开 URL 或账号记录，模型自述不能入账。
- **硬成功闸门**：提交前保存 evidence baseline；只有本次操作后新增的明确回执、2xx 响应或独立公开链接可写 `submissionRecords`。已点提交但无回执进入 `submitted_unconfirmed`，不显示成功。批次人工确认使用 run + task + nonce 绑定；单站补录通过侧栏「登记外链动态」绑定 destinationKey + Profile，并标明人工来源。

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
- **使用前**：确认 Chrome 已加载当前 Manifest 版本；2026-09-10 已实机回读 **3.3.12**。云端连接、状态首迁移和媒体首迁移已完成。检查队列质量闸门、「目录站无验证码可代点提交」（默认开）和标准评论代点开关（默认关）。切站后看侧栏当前网站名称/URL 是否对得上，再让自动提交继续。

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
- 本轮没有点击任何第三方最终提交，也没有把填表或人工停放写成成功回执；此处历史版本曾在新批次清理插件追踪的人工页签，该策略已由 3.4.1 撤回，未解决人工页面应跨批次保留。

## 2026-09-17 云端优先同步（3.6.0）

- Profile、提交账本、时间线、站点标记、筛选和监控等高频文档改为字段级 PATCH；Worker 在 Neon 最新文档上原子合并并重试修订竞争。
- 扩展启动自动回读；手动回读成功后保留「外链库」页面并显示 8 秒成功提示，手动保存也显示保存数量。
- Worker 生产版本 `62d0d4c6-e760-4f0d-864d-b052396d1d0f` 已上线；线上无损 PATCH 验证为 HTTP 200，内容未变化，仍有 7 个 Profile。
- 全量 Node 回归 42/42 通过。Ego 仍需人工在扩展管理页重新加载并确认版本 `3.6.0`，内部扩展页不能由自动化代点。
- 当前页签、验证码、OTP、登录态和运行中批次继续留在设备现场；同字段同时编辑按云端接收顺序生效。详见 `docs/云端优先同步-2026-09-17.md`。
