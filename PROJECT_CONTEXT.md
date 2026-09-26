# PROJECT_CONTEXT

## 2026-09-26 21:09 / 原生捕捉失败根因复核，定时已暂停

- 用户询问 Chrome/Ego 为何从可验收变为不可操作。本轮回看：20:40 曾成功打开 ExternalLink 侧栏并只读查询 Neon；20:53 Chrome 原生捕捉成功但 Ego 已间歇报错；20:59 起 Chrome/Ego 原生绑定返回 `SCStreamErrorDomain -3811`，而普通 Chrome 公共标签仍可操作、Finder 捕捉正常。应用清单显示 Chrome 与 Ego 都在运行。
- Apple 将 ScreenCaptureKit `-3811` 定义为 `internalError`（捕捉流无法启动，框架内部失败），不是权限拒绝码。最近 20 分钟 `SkyComputerUseService` 日志可见窗口枚举和全屏捕捉流配置，但没有对应 `-3811/-3812`、`contentRect does not contain sourceRect` 或权限拒绝日志。部分窗口坐标在屏幕左侧之外；日志隐藏窗口所有者，无法证明与 Chrome/Ego 失败相关。
- 结论边界：**已经定位到 Computer Use 原生捕捉/窗口绑定层间歇失效**，解释了为什么普通网页可读而扩展工具栏/侧栏不能操作；没有证据证明 Chrome/Ego 插件崩溃、macOS 权限被撤销，或窗口坐标就是根因。Neon Console 的 Cloudflare 验证是另一独立阻塞，导致本轮不能做账本回读。没有可靠句柄，未重启 Ego。
- 用户要求后，现有 `externallink` heartbeat 已由自动化工具设为 `PAUSED`；不再定时续办。恢复只可由用户明确要求。

## 2026-09-26 21:04 / Chrome 普通页预检已执行，原生绑定复测仍失败

- 本轮先同步远端并读取项目上下文、Jev 十站验收、中文交接与进度；分支干净，起始 HEAD `239a8a1` 与远端一致。上一轮已实际使用 CUA，本轮继续通过 `cua_repl` 操作 Chrome 普通网页。
- Chrome 公开标签 API 打开并完整读取 NoAdsGames 投稿规则和表单，候选页 `https://noadsgames.org/en/publish-game` 未填表、未点检查或提交。该站要求独立域名的公开 HTTPS 游戏直链且允许 iframe；表单还要求发布权利及规则确认，需能真实确认后才能提交。Jev iframe 条件尚未验证，NoAdsGames 仅为预检候选，不加入已固定队列、不计插件尝试。
- 原生捕捉对照：Finder `getApp` 正常；本轮 Chrome 及 Ego 绑定返回 ScreenCaptureKit `-3811`，随后再次绑定 Chrome 仍为 `-3811`。应用清单显示 Ego 和 Chrome 都在运行。没有可靠原生句柄，未重启 Ego、未操作工具栏/侧栏；当前不能据此检查实载版本。
- Neon Console 普通标签停留 Cloudflare 安全验证页，没有处理验证或读账本。已关闭 NoAdsGames 研究标签并通过 `getState()` 回读确认移除；保留 Neon 验证页与 Jev Code Breaker 续办页。公开标签清单未提供标签组状态，本轮未触碰或声称清理分组。
- 本轮无插件独立填表/提交、站方回执及 Neon 精确回读；新 Jev 样本仍 0/10，固定十站未完成。Alieradox 与 AI Tools Ratings Jev 既有回执继续禁止重投。细节见 `docs/Jev插件独立十站验收-2026-09-26.md`。

## 2026-09-26 20:59 / Chrome 网页验收可用，原生捕捉当前失效

- 本轮重新 fetch，工作树干净，HEAD `9468646` 与远端一致；已读项目上下文、Jev 十站验收与中文交接。上一轮确实使用了 CUA，并推送两笔验收交接文档提交。
- 按用户要求在 CUA Chrome（浏览器 ID `6`）打开并读取 `https://jevplay.com/games/code-breaker`，标题与 JevPlay 页面内容正常；此页保留为后续插件验收续办现场。公开 Chrome 标签 API 可正常使用。
- 这一轮原生捕捉复测中，Ego 与 Google Chrome 均报 ScreenCaptureKit `-3811`；Finder 原生捕捉成功。结合上一轮 Chrome 原生捕捉成功一次，可确认 Chromium 原生窗口捕捉是间歇故障，不是所有应用都失效。当前没有可靠原生句柄，因此无法读工具栏/侧栏，未重启 Ego，也未验证 Chrome/浏览器实载插件版本。
- 新查 20:55–20:58 系统日志看到全屏捕捉区域 `[0,0,1470,956]`，另有小区域 `x=-233`、宽 168、高 170；未见 `contentRect does not contain sourceRect`、直接的 `-3811` 根因或权限拒绝记录。几何位置值得下轮与窗口位置对照，但现阶段不能据此断定根因。
- CUA 当前标签清单显示 Ego 浏览器仅有原新标签；Chrome 里有 Jev Code Breaker 与原新标签。已将 Jev 页标记续办；没有创建标签分组。此前 Google/DuckDuckGo CAPTCHA 等页当前不在活跃标签清单中；因原生组状态捕捉失败，未声称已关闭任何保存分组。
- 本轮没有侧栏插件调用/真实填表尝试、站方提交或回执，也没有 Neon 实时读取；独立目标仍 0/10。继续只测 Jev，不重投 Alieradox、AI Tools Ratings；Chrome 普通网页预检可继续，插件闭环必须等待受支持的工具栏/侧栏访问并实时 Neon 查重。

## 2026-09-26 20:53 / CUA 对照 Chrome 与新增游戏目录预检

- 本轮 `git fetch origin` 后分支 `codex/jev-acceptance-handoff-0926` 与跟踪远端一致，HEAD `185ea3f`，工作区干净；已读取项目上下文、十站验收与中文交接。上一轮确实使用 CUA，普通 Ego 标签 API 可直接打开和读取页面。
- 捕捉对照结果：Chrome 原生 `getApp` 本轮成功，窗口为 Chrome“新标签页”；Ego 原生第一次报 ScreenCaptureKit `-3811`，随后一次成功并读到本任务 Google CAPTCHA 页，再次绑定又报 `-3811`。因此不是 Chrome 全局持续失控；Ego 原生捕捉间歇失败，但公开标签操作仍可用。没有可靠稳定的 Ego 窗口句柄，不执行、不声称重启。
- 只读系统日志（20:45–20:52）看到捕捉流初始化/启动与暂停，并出现一次 AVFoundation `-11800` / 底层状态 `-12902`；本轮日志没有明确的 `contentRect does not contain sourceRect` 或可对应到 CUA `-3811` 的具体原因，也没有权限拒绝证据。根因仍未定位；已验证的恢复手段只有重新绑定偶尔成功，以及继续通过公开标签接口工作。
- 通过 Ego CUA 公开标签预检 PLAXZY：免费投稿，但明确要求 Google 或邮箱账户登录，未登录或提交。预检 PLIX.GG：页面称免费、无 SDK，通过联系表单接收游戏 URL/标题/描述/缩略图，要求游戏可被 iframe 嵌入；Jev 的 iframe 兼容性及当前 Neon 精确去重未核实，不入固定队列。没有填表、发信或插件操作。
- 已关闭本轮创建的 Bing 搜索、PLAXZY、PLIX.GG 三个完成页；CUA 标签清单确认三页已消失。保留 Google/DuckDuckGo 人机验证、DeskLink 条款、AxoGamer/iDev 登录现场及用户原标签；`🔎 ExternalLink 云端回读` 分组因仍含人工门槛现场而保留。未动其他任务的 Chrome 空白页与关闭分组。
- 本轮插件真实尝试 0、站方提交/回执 0、Neon 实时回读 0；新 Jev 独立闭环仍 0/10，固定十站队列未冻结。Alieradox 与 AI Tools Ratings Jev 仍禁止重投。下一步在稳定绑定后才触及正确 Jev 站点侧栏；先实时精确去重，PLIX 需先验证 iframe，不用手工填表冒充插件成功。

## 2026-09-26 20:40 / Computer Use 实际操作、Neon 回读与捕捉故障复现

- 本轮重新 `git fetch origin`，工作区无改动，`HEAD` 与 `origin/main` 都是 `ac8c55a`。按用户要求直接用 CUA 操作 Ego：公开标签 API 成功打开 Neon 控制台并运行只读 SQL；原生窗口捕捉成功一次，点击 ExternalLink 工具栏后侧栏显示当前 Profile `JevPlay`、云端媒体 2 个文件。该读回证明插件侧栏这次确实可用，但没有查看实载版本，也没有点击“检测/填表/提交”。
- Neon 唯一生产项目 `dark-night-20420985`、生产分支 `br-quiet-scene-b4gw8ygn`、数据库 `neondb`。`default/submissionRecords` revision 123（`updated_at=2026-09-26T11:25:56.337494Z`）；只读查询 `key LIKE '%::JevPlay'` 返回 26 条 `status=success`。完整键清单和防重规则见 `docs/Jev插件独立十站验收-2026-09-26.md`。Alieradox Jev、AI Tools Ratings Jev 的站方回执没有出现在这 26 条中；遵守不重投要求，不能补造账本。
- 新打开的普通页面可持续用 CUA 读取。原生 `getAXState/getApp` 随后重复报 ScreenCaptureKit `-3812 (invalidParameter)`；Finder 对照捕捉成功。Ego 仍在运行，但错误时没有可靠原生控制句柄，未声称或执行重启。之前普通页与一次侧栏操作成功、之后原生捕捉失败，说明这是间歇的**原生捕捉通道**故障，不代表整台浏览器无法操作；此前把两条路径混为一谈是判断失误。
- 直接预检确认 Rando 需要可 iframe 加载的游戏直达 URL（兼容性未证）；DeskLink 提交会同意内容规则；AxoGamer/iDev 要注册；Paizix 与 TapCraftBox 只收邮件；AIToolsDirectory.com 会丢弃 AI 文案。Google、DuckDuckGo 都出现 CAPTCHA，人机挑战页已标记保留，没有解题。无站点开始插件填表，故本轮真实插件尝试 0、提交 0、独立闭环 0/10；固定队列尚未冻结。
- 已关闭 Rando、Jev 游戏详情、AIToolsDirectory.com、Paizix、TapCraftBox、404 与 Neon 查询页，并回读清单。保留两个人机挑战、DeskLink 条款、AxoGamer/iDev 登录现场及用户原新标签页。Neon 查询页所在的“🔎 ExternalLink 云端回读”标签分组关闭状态无法在后续 `-3812` 下复核；下次捕捉恢复时先确认并清理空分组。

## 2026-09-26 20:33 / CrazyGames 门槛预检

- CUA Ego 原生短暂绑定到新标签页，但地址栏已有输入中的 `b`，来源不明，未争用该窗口。独立公开标签核查 CrazyGames 官方 Basic Launch 可无 SDK；开发者投稿入口 `developer.crazygames.com/games` 现场为登录页，未获表单，未登录/投稿。研究页关闭，Ego 原页保留。详情见 Jev 十站验收文档。

## 2026-09-26 20:28 / 直接 CUA 浏览器标签路径验证

- 已按用户要求直接用 Computer Use 绑定 Ego 公开标签，进入并回读 SlowDen 表单；即使 Ego 原生控制仍间歇报 `-3811`，普通网页标签可操作。SlowDen 明确 iframe 展示游戏，Jev 的嵌入兼容性尚未验证；未填表/提交。
- Ego 一度由清单显示已退出，本任务未执行退出；随后通过 CUA `getApp` **重新打开**，取得新标签页。原生再次绑定失败，未操作插件工具栏/侧栏。五分钟任务已改为优先公开标签预检，触及插件 UI 才恢复原生；不能用网页手工动作冒充插件独立验收。所有本轮页签已关并回读，无新 Neon 或站方回执。

## 2026-09-26 20:23 / Ego 窗口对照与 Bounty Board 预检

- CUA Ego 原生绑定先 `-3811`，Finder 桌面可绑定，随后 Ego 可绑定但指向正在工作的另一任务 SEO 窗口；再次绑定仍 `-3811`。未重启 Ego、未操作其他任务。Apple 官方说明单窗口捕捉不参考 `sourceRect`，Sky 上轮矩形错误的具体配置尚未定位。
- Bounty Board Arcade 免费接收游戏，但先要 studio 账号，要求 16:9 封面、操作说明、至少 100 字简介，外链游戏必须可 iframe 嵌入；Jev 可嵌入性未证，未注册或提交，候选暂不入固定十站。研究页全部关闭并回读；无新插件尝试/Neon 回读。细节见 Jev 十站验收文档。

## 2026-09-26 20:19 / CUA 捕捉矩形故障实证

- 本轮实际使用 Computer Use，`native pipe is closed` 经 `cua_repl.js_reset()` 恢复清单，未重启 Ego。Ego/Chrome 原生控制继续间歇报 `-3811/-3812`；`SkyComputerUseService` 同时段三次记录 `SCStream validateStreamConfiguration: contentRect does not contain sourceRect`，指向捕捉配置矩形校验失败，具体源窗口未定位。Ego 曾绑到另一任务 SEO 空间，故没有操作本任务插件。
- 五分钟 `externallink` 任务已写入 REPL 重置、矩形错误排障与动作前后窗口/URL/空间回读，回读 ACTIVE。本任务研究页和误开空白页已用 CUA 关闭，清单只剩另一任务 SEO 与 Search Console。Jev 公开游戏页可打开，但 iframe 实测 `data:` 页被浏览器自动安全审核拒绝，未换入口绕过，Rando 可嵌入性仍待证。
- 源码 3.7.106、浏览器实载、站方回执与 Neon 云端分开计；本轮无新插件尝试/提交/云回读，固定十站仍未成立，新 Jev 独立闭环 0/10。详见 `docs/Jev插件独立十站验收-2026-09-26.md`。

## 2026-09-26 / 五分钟续办：Neon 控制台验证门槛

- `origin/main` 核对至 `4dfef6d`；上一轮 Computer Use 使用和清页记录已复核。本轮 Ego 原生绑定仍报 `-3811`，未取得退出重启句柄。
- Computer Use 打开的 Neon 官方控制台停在 Cloudflare 安全验证，没有解题或绕过，未得到数据库读回；页签已关闭。本轮只余用户原有 Chrome 设置页，本任务无未清页签/分组。Neon 精确去重、插件实载、固定十站与 6/10 仍未完成。

## 2026-09-26 / Computer Use 恢复诊断与游戏目录预检

- 已将现有 `externallink` 五分钟 heartbeat 更新为每轮检查 Computer Use 实际使用与中断原因、受支持的 Ego 普通故障恢复，以及本任务已完成页签/分组清理；ACTIVE、目标任务不变。
- 本轮公开网页均通过 Computer Use 操作；Ego 原生窗口绑定仍报 `-3811`，无法完成普通退出重开，扩展内部页既有安全拒绝未绕过。插件实载版本与实时 Neon 去重仍未证实。
- SlowDen 免费可投已完成浏览器游戏但需要权利确认和体验评分；Rando 免费但必须可嵌入的直接游戏 URL，待测；Valeri 游戏平台仅移动端，Jev 不适配；Find Next Play 需登录/reCAPTCHA；Indie Games Developer 要 Press Kit 和商店页，Jev 不适配。详情及来源在 `docs/Jev插件独立十站验收-2026-09-26.md`。
- 本轮全部新开候选页已关闭并回读，不动用户原有自动填充设置页；无新投稿和云端成功，6/10 未达标。

## 2026-09-26 19:54 / Ego 普通窗口恢复与已公开 Jev 去重

- Ego 原生窗口绑定和普通页面点击/导航已恢复。本轮新建独立空间（空间计数 1 → 2）后仅做公开页核验；未退出整个 Ego，未改动其他任务页。恢复普通窗口不等于解除此前扩展管理页/设置页的安全拒绝，未借原生界面访问被拒资源，插件实载路径/版本及最新 Neon 仍未验证。
- 直接打开 `https://techbasedirectory.com/product/jevplay`，页面标题 JevPlay，介绍四款日常游戏，`View Product Website` 指向 `https://jevplay.com/?utm_source=TechBaseDirectory`。可确认已有公开条目，应防重投；不是本轮新投稿，不计插件独立闭环。Neon 精确记录待回读。
- 本轮目录页及搜索页均已关闭；独立空间可供后续普通页面验收复用。未新增投稿，目标仍未达到 6/10。

## 2026-09-26 19:49 / 续验与本地审计空结果保护

- AIToolnet 现场仅见 $9.9 / $49.9 投稿档、最终按钮 `Submit Pay $9.9`，旧 START/Free 候选说明不再适用；ToolScout 免费但登录前要求同意条款。两站未投稿，本轮页签已关闭。
- Ego 原生绑定仍 `-3811`，没有完成重启、插件实载或最新 Neon 去重。独立闭环无新增，目标仍为固定十站至少 6/10。
- 本地 `audit-state.mjs` 原先对 Jev 缺失数据返回 `0/0 ok`，现明确输出 `source=local_seed_backup`、`liveCloudVerified=false`；没有成功证据返回 `reason=no_evidence`、CLI 退出码 2。既有有效本地对账仍可通过，但不能代表实时 Neon 审计。插件源码版本仍 3.7.106。

## 2026-09-26 19:44 / 新任务接手与候选门槛校正

- 已从 `06df6fe` 接手；现有五分钟 `externallink` heartbeat 已迁入任务 `01a0dd85-e567-7273-a836-7a179de56ddb` 并回读确认 ACTIVE，没有重复新建。
- Ego 原生绑定仍为 `-3811`，未取得退出重开句柄；插件加载路径/版本未实证，不能操作被拒绝的内部页来绕过。
- 公开预检确认 10015 需登录；Sites Plus 免费但协议必选且订阅默认勾选；AppRater `/add/` 已转首页表单，提交接受 Terms；AI Tools Directory `.com` 拒收 AI 文案，已有代码人工闸门，排除独立投稿候选。详细证据见 `docs/Jev插件独立十站验收-2026-09-26.md`。
- 本轮预检页已关闭，无新投稿或独立成功，最新云端去重与十站冻结待恢复。

## 2026-09-26 / Jev 单站范围与 3.7.106 精确选项优先

- 用户最新范围覆盖旧三产品计划：只投稿 JevPlay，OldPhotoLive 与 GraffitiName 暂停外部提交。既有三产品矩阵 8/30 仅保留为历史，不能混入新 Jev 样本。新十站先排除已有回执，固定队列后记录每一真实尝试、失败和人工辅助；独立填表、提交、站方回执及 Neon 精确回读至少 6/10 才达到超过 50%。本轮尚无新增真实提交，不能报告达标。
- 普通卡死恢复流程已写入现有 `externallink` 续办任务：保存目的站、Profile、是否已点提交和证据，关闭并重新打开 Ego；恢复后先核对回执和精确去重，再继续未提交步骤。已有其他自动化工作空间则使用独立空间；用完关闭本任务页签与分组。安全策略拒绝、登录、CAPTCHA 和条款门槛不靠重启绕过。不能关闭其他任务正在使用的 Chrome 窗口。
- 本轮通过原生接口启动 Ego，应用清单确认运行，但绑定窗口连续失败于 ScreenCaptureKit `-3811`，未取得可调用的窗口句柄，因此尚不能执行退出快捷键或操作插件；Chrome 原生窗口也同样失败。不得将启动应用写成已完成重启，更不得将源码测试计为实站成功。此前扩展管理页/设置页存在明确安全拒绝，不使用备用界面规避。
- 复查自定义下拉发现 `Free` 会先命中排列在前的 `Freemium` 包含匹配。3.7.106 复用项目既有 `findBestSelectOption` 的精确标签优先排序，覆盖首次展开和输入搜索后匹配；动态回归验证 Free 选项收到选择事件，Freemium 不被误选。54/54 测试、语法和 diff 检查通过，源码尚未实载复验。前版主流实现参考仍为 Bitwarden 字段归属、Automa 控件流程、Playwright 可访问名称与动作后验证、Radix pointerup 提交选择。

## 2026-09-26 / 3.7.105 Radix 定价与两条辅助投稿

- 用户报告已重载；Chrome 侧栏一度恢复控制，但未从扩展管理页目视确认实载版本。Alieradox 的 OldPhotoLive AI、Graffiti Name AI 分别由插件填写产品名、官网、分类、描述及正确联系邮箱；可见 Radix 定价仍错误保留默认 `Free`，提交前代理分别手动改为 `Freemium`、`Paid`，再由插件点击提交。站方两次明确显示 `Tool submitted successfully! Our team will review it shortly.`。
- 两条精确 Neon 账本经设置页待上传归零、云端回读、再导出本机快照核对：`alieradox.com/submit::OldPhotoLive`、`alieradox.com/submit::GraffitiName` 均为 `success / submitted`，证据为同一站方回执。Graffiti 投稿邮箱目视为本人 `syndredyoung@gmail.com`；OldPhoto 为 `support@oldphotoliveai.com`。JevPlay 早前已有站方回执但仍缺精确云账本，不重投。站方明确收到的矩阵组合至少 14 个；两条新记录均有人工价格校正，独立闭环仍 **8/30（26.7%）**。
- 参考 Radix Select 官方 `select.tsx` 的 `onPointerUp` 提交机制，在项目既有自定义下拉处理器中对 Radix 选项补鼠标 `pointerdown/pointerup` 和选后值验证；There Is An AI Tool 的真实必填字段再补受众缺省值及 Graffiti Profile 明确价格套餐的简写，不编造起价。源码升 3.7.105，54/54 回归、语法及 diff 检查通过；**尚未实载复验**。新站仅打开表单预检，未发送；Chrome 原生窗口随后再次报 ScreenCaptureKit -3812，公开预检页已关闭。已用 Alieradox 和设置页清理仍待工具恢复，不得将源码验收算成现场成功。

## 2026-09-26 / 3.7.104 Alieradox 实站回执漏识别

- 按用户要求用 Chrome 原生控制新开窗口，Alieradox OldPhoto 由已实载插件填对产品资料与邮箱，但可见定价仍为错误的 `Free`；未发送。切换 JevPlay 时插件主动拦截页面中其他 Profile URL，刷新清空后插件独立填入 JevPlay 六栏，定价 `Free` 正确，并点击最终提交。站方原页明确弹出 `Tool submitted successfully! Our team will review it shortly.`，表单清空；JevPlay 已送达站方待审。
- 插件未识别该站短暂 AJAX 通知，侧栏长期停在“无验证码，正在提交…”，新开同站页回读显示该 Profile 没有精确账本/时间线。关闭本轮已用窗口和核对页签以避免重复请求；可能有第二次请求在关闭前启动，站方后台是否接受第二份未知，**不得重投 JevPlay**。新十站独立闭环仍 8/30，站方明确收到的产品×站点至少 12 个。
- 3.7.104 在现有 `classifyVisibleEvidence` 增加 Alieradox 来源限定的准确成功提示识别，回归覆盖未提交前审核文案、异站归属和提示消失。Chrome 原生窗口目前可操作公开页，但此前浏览器安全策略明确拒绝扩展管理页并禁止备用界面绕过，不能据此自行进入管理页重载。最后确认实载仍 3.7.100。
- Chrome 标签搜索本轮显示仅一个原有空白标签打开；此前 PromptHive 草稿、旧 Alieradox 草稿和扩展管理页均在“最近关闭”，并非仍需保留的活动页。当前侧栏保留在空白标签，外链验收分组显示已关闭。
- 最终关闭本轮插件侧栏及已用页签；按用户本轮要求另开一个空白 Chrome 窗口并保留，外链验收分组仍为已关闭。

## 2026-09-26 18:40 / 用户要求自行重载的操作路径

- 用户再次明确：插件代码更新后的重载和验收应由代理自己动手，不能把例行操作反复转给用户；已用页签与分组须清理。先前成功路径是 Ego/Chrome 原生窗口中的扩展管理页，点击重新加载后目视核对版本和“已重新加载”，再回真实表单验证。3.7.90 与 3.7.100 曾按此路径自行重载。
- 本次原生窗口捕捉持续报 ScreenCaptureKit -3811；浏览器标签接口访问 `chrome://extensions/` 被安全策略明确拒绝，且提示不得通过备用浏览器界面、原始 CDP 或间接命令规避。可用工具清单中没有专用的 Chrome 扩展重载能力。当前不能据源码版本 3.7.103 声称浏览器已实载；最后确认实载为 3.7.100。待受支持的原生控制恢复后，代理应自行重载最新版本并回读，不再让用户重复做例行操作。

## 2026-09-26 / 3.7.103 新十站矩阵与浏览器控制交接

- 新十站验收的插件独立闭环 **8/30（26.7%）**：ToolPilot OldPhoto 1、ThatsMyAI 三款 3、AI Tools Directory.site Jev/OldPhoto 2、Credible AI Tools Jev/OldPhoto 2。站方另收到 3 个辅助或云账本未闭环的组合；不能混计，也不能重复提交。详见 `docs/插件自动投稿开源对照与十站验收-2026-09-26.md`。
- Graffiti 本人邮箱已在 Neon Profile 回读为 `syndredyoung@gmail.com`；Jev 同邮箱，OldPhoto 用 `support@oldphotoliveai.com`。OldPhoto PromptHive 六步草稿待两项提交者声明决定，未发送；Alieradox OldPhoto 草稿的定价仍显示错误的 Free，未发送。
- 3.7.100 实载修复无效后，3.7.101 改 Radix 可见 `role=combobox` 默认值协调，源码已推送；模拟控件回归与全量 54/54 通过，**未实载**。Chrome 原生窗口捕捉失败，浏览器安全策略拒绝扩展管理页，不绕过。Chrome 留 PromptHive 与 Alieradox 两个待处理页，另有一个先前打开的扩展管理页因浏览器策略无法关闭；预检页已关闭。恢复操作能力后自行重载最新 3.7.103、现场核准 Freemium、再发送；提交后需要站方回执与 Neon 精确回读。
- 3.7.102 依据 Ignlab → ListAI 切页时的错标现场，固定点击瞬间的来源 URL/标签/Profile，迟到的注解读取不得更新新页 UI；新增异步切页回归。此修复尚未实载。
- 3.7.103 依据 There Is An AI Tool 的真实免费表单补功能标签、目标受众、最少三条结构化功能与起价映射；Paid 起价无 Profile 明确数字时留空，防止编价。定向测试通过，尚未实载或提交该站。恢复控制时应重载最新 3.7.103。

## 2026-09-26 / 3.7.90 Graffiti 本人邮箱写回保护

- 用户明确要求涂鸦站投稿联系邮箱使用本人 `syndredyoung@gmail.com`。3.7.89 已将本地种子和填表运行配置换成该地址；3.7.90 在启动云端回读成功后，仅对云端 Graffiti Profile 中明确的旧 `support@graffitinameai.com` 做字段级更正，并交给原有 `siteProfiles` 自动 PATCH 同步。其他 Profile 与有效的自定义邮箱不改。
- 54/54 Node 测试和语法检查通过。16:11 在 Ego 扩展管理页自行重载并看到 3.7.90 与“已重新加载”；插件启动回读后自动上传 Graffiti 邮箱修正。16:12 轻量核对与手动云端回读显示工作区 `default` 版本一致、待上传 0 类、冲突 0 类；回读后 Graffiti Name AI 的联系邮箱、`Business mail`、`Feedback mail` 均为 `syndredyoung@gmail.com`，旧无 MX 邮箱已不在这三项。云端资料更正已验收，未新增投稿。用户既有 SEO 页签未动，本轮插件页签已关闭。

## 2026-09-26 / 3.7.77 同类实现对照与表单归属修正

- 参考 Bitwarden 的先确定表单/字段再操作、Automa 的显式表单控件定位及 Playwright 的可访问名称定位。项目现有 `getActiveFillScope()`、多步骤补填、提交前校验和回执基线可复用。本轮优先让投稿字段表单胜过同页较大的账户表单；最终按钮按活动表单归属筛选，支持 `button.form` 指向的外部按钮和通用 `role=button`，排除订阅、搜索、登录控件。必填错误和禁用提交检查也限制到活动表单；提交前重新识别按钮，避免 SPA 替换旧节点后盲点。参考：`https://contributing.bitwarden.com/architecture/deep-dives/autofill/collecting-page-details/`、`https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/form`、`https://playwright.dev/docs/locators`。
- 定向测试覆盖通用 `role=button` 与账户表单更大的竞争页面；全部 53 个 Node 测试文件通过，语法与 diff 检查通过。Chrome/Ego 原生窗口接管连续返回 ScreenCaptureKit `-10005/-3811`，内部扩展页不能由浏览器标签 API 接管，因此 3.7.77 **未完成自行重载或真实站点验收**。没有新增第三方提交或 Neon 记录；已使用的原有提交页签仍按上轮记录关闭，本轮新开的 Chrome 空白标签已由代理关闭。历史十站站方回执成立，但多数站插件闭环仍未证实。

## 2026-09-26 / AI Generation 三产品与 3.7.76 交接

- 14:13 Chrome 插件设置页实机重试上传后成功保存提交账本、提交时间线 2 类修改，再从云端回读 1 类新修订；14:13:59 显示 `default` 工作区版本一致、待上传 0、冲突 0。设置页重载后 AI Generation `/add/` 同一站点显示 Graffiti、JevPlay、OldPhoto 三个精确 Profile 均“已提交”，右侧分别显示 13:54、13:53、13:47 的三条动态与站方 Google 表单回执链接。可认定这三条账本和时间线已进入当前云端修订并在本机回显；无公开产品页，不计已收录。已关闭本轮 Chrome 的 25 个已用提交/候选页签，Ego 的 Come AI 核查分组也已关闭；用户原有的其他工作页签未动。多数站插件全流程标准仍未达成。
- Chrome 已由代理自行重载并回读 3.7.76。AI Generation 的 OldPhoto、JevPlay、Graffiti 三份官方 Google 表单均有 `Thanks for contributing to the directory!` 回执；OldPhoto 最终按钮为代理点击，Jev/Graffiti 为插件全程提交。三份同站动态在侧栏可见，Jev/Graffiti 有插件自动本地账本；不要再次提交。
- 3.7.75 修复嵌入 Google 表单提交控件双重标签识别和未找到按钮的错误反馈。3.7.76 识别 Linkrena 提交后跳 `/login?callbackUrl=%2Fsubmit`；Graffiti 在该站没有成功回执，Jev/OldPhoto 未试。站方登录即接受条款，不代登录。
- 此前设置页有 5 类本机修改待确认；本轮已清零并完成 AI Generation 三条记录的云端版本及本机界面核对。历史每款十站收到申请已达成，但“至少六站三产品由插件填写和最终提交”的标准仍未达成。详见 `docs/三产品十站插件实测-2026-09-25.md`。

## 2026-09-26 / YAATD 插件实站与免费候补故障

- 3.7.71 插件由代理自行在 Chrome 重载；OldPhoto 的 YAATD 9 栏与图片现场填齐，插件最终点击后站方创建 `oldphotoliveai-com` 待发布记录。免费候补约 56 天、nofollow，确认两次均返回 `Could not switch to the free waitlist`；不得计免费提交、公开外链或 Neon 已同步，也不得重投 OldPhoto。JevPlay/Graffiti 在该站未提交。
- 3.7.72 修正 YAATD 同页有付费精选和免费候补时的纯付费误判；代理已自行在 Chrome 重载，详情页回读 3.7.72 与“已重新加载”。结算页仍停在免费候补失败状态，侧栏已改为“需人工”，付费标记为关闭；不再重试该站免费请求。Verified Tools 免费档有 Cloudflare 安全质询，Best AI Brands 明确无免费提交且至少收费 $10，均未投递。历史三产品各十站已有站方回执，但插件六站全流程与精确 Neon 回读仍未达标。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.70 Tools.so 跨域必填题**：Tools.so `/submit` 内嵌 Tally `3EPN9B`。3.7.68 插件填 OldPhoto 官网和邮箱，但透明单选控件被可见性过滤；AI 补全因预算超时。3.7.70 仅对该站问卷允许可见标签对应的透明 radio，并仅对三款目标产品选“我是工具作者”；代理自行重载后实页确认 OldPhoto 已选中。站方将 `@tool_twitter_handle` 设为必填，而 Profile 标注 X/Twitter 未提供，故未提交、未计成功；已合并向用户确认三款真实 handle。详见 `docs/三产品十站插件实测-2026-09-25.md`。


- **2026-09-26 / 3.7.68 免费语义与站方失败**：AI Tool Claw 免费提交页的 `No credit card`、`no credit card required` 被付款检测误判，已在 3.7.67 修复并自行重载现场确认 OldPhoto 六栏由插件正确填写；最终插件提交后站方只显示 `Something went wrong`，无回执。3.7.68 为该站可见错误增加快速失败识别，定向测试已通过，代理已自行重载并回读 3.7.68；失败快速识别未二次提交实测。不能把该站计作成功，不重试另外两款。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.65 主页面与嵌入表单并行识别**：代理自行逐版重载至 3.7.65，扩展详情页回读版本及“已重新加载”。ToolDirectory.AI 的 Stripe iframe 曾抢答检测，3.7.60 错报无表单；3.7.61 指向主 frame 后识别 25 字段与 $9.99/月门槛，但独立自动填表入口在水合期误填 `Syndred`。3.7.62 起自动填表前复核付款并提前识别必付文案，实页名称/网址保持空白。3.7.64 选择有表单的 frame，保留嵌入式提交能力：本地 iframe 验收页显示 3 字段且由插件正确填写；ToolDirectory 实页复测仍为 25 字段、明确付款拦截且无误填。3.7.65 在检测不可用时停止后台自动填表，已自行重载。Come AI 免费表单由插件填写 OldPhoto 五栏并最终点击，但站方再次 HTTP 500，无回执、不计成功、不重试。完整 53/53 测试通过。历史站方回执已超过三产品各十站，但六站插件全流程加 Neon 精确回读仍未验收。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.59 Come AI 分类修正与站方故障**：3.7.58 已由插件将 Graffiti Name AI 提交到 AI Tools Ratings，站方 `?submit=sent` 有完整收到消息回执，但侧栏仍称本地动态等待云端保存，Neon 未回读；同站三产品均有回执，不得重投。Come AI Graffiti 五栏由插件填写，可选分类误用关键词，代理修正后插件点击提交，站方 API 再返 HTTP 500，无回执；OldPhoto 未试。3.7.59 映射该站现有图像类目，Jev 无匹配分类则留空，53/53 测试通过。代理自行在 Chrome 扩展管理页重载并回读 3.7.59，OldPhoto 新标签插件填写五栏，分类现为 `Image Generation & Editing`，未提交。扩展设置页的浏览器直读被安全策略拒绝，勿绕过。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.58 截图 URL 语义保护**：Graffiti Name AI 在 AI Tools Ratings 由 3.7.57 插件填完，但将作品示例图误填为可选产品界面 `Screenshot URL`，未提交。3.7.58 仅让路径明确表示界面截图的公开图片进入 URL 栏，否则留空；53/53 测试文件通过。须自行重载并重填后继续 Graffiti 实机提交与精确云账本验收。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.57 跨页回执硬闸门修复**：OldPhotoLive AI 在 3.7.56 已由插件向 AI Tools Ratings 提交，站方 `?submit=sent` 显示完整收到消息回执；插件后台补读新页时因证据列表为空被成功硬闸门拒绝入账。已修导航断联回退和零长度信号兜底，回归与全量 53 个测试文件通过。JevPlay、OldPhoto 均已送达站方但账本/Neon 尚待补记，不再重复提交；自行重载 3.7.57，用 Graffiti 实测自动记账。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.56 AI Tools Ratings 回执规则**：自行重载 3.7.55 后，JevPlay 插件提交跳到 `?submit=sent`，站方显示完整 `Thanks — we received your message and will get back to you soon.`。插件旧规则漏识别，故没有自动账本/Neon；不可重复投稿。已为该站补精确回执规则和测试，须自行重载 3.7.56 后用另两产品核对自动记账；JevPlay 依据已见回执补记并云端回读。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.55 目录误判资料页**：AI Tools Ratings JevPlay 在 3.7.54 已填 13 字段，点击“提交本页”时出现“无验证码，正在提交…”，15 秒后回到可提交但站方无变化、无回执。源码定位 `input[name=website]` 与页脚 `AI Image Editing` 让资料页检测先命中；3.7.55 收紧资料页语境、移除裸字段兜底，目录页/真实资料页回归及 53 个测试文件通过。须自行重载 3.7.55 后在保留的表单现场提交并核对账本/Neon。AI SuperHub 与 Launchpedia 三产品已有历史回执，跳过避免重复。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.54 AI Tools Ratings 预填**：新站 JevPlay 插件预填暴露一句话简介、截图 URL、投稿理由三处语义错误；已修代码与回归，自行重载回读 3.7.54 后现场复验正确。侧栏“提交本页”已点击，但未见成功回执或导航；后续定位为资料页误判，见上条。Ignlab 因人机题停放，These AI Tools 为邮件入口。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.53 Come AI 现场提交**：JevPlay 五个字段由插件完整填写，点击“提交本页”后站方 API 返回 HTTP 500，无成功回执/Neon 记录。已加本次请求的 HTTP 错误识别和回归；随后自行在 Chrome 扩展管理页重载并核实 3.7.53。事后发现 Come AI 提交时该 Chrome 实例仍实载 3.7.50，不能归功于 3.7.52。Chrome 原生捕捉失败时可用系统辅助功能操作插件。见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.52 Come AI 预检**：Come AI 免费投稿表单已在 Chrome 现场核对，5 个字段、无可见 CAPTCHA/声明；前端成功态显示完整审核回执。新增站点专用 `pending_moderation` 识别并通过测试，源码已推送。插件窗口控制中断，尚未重载 3.7.52，也未提交 JevPlay、OldPhotoLive AI 或 Graffiti Name AI；不要把预检当成功。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-26 / 3.7.51 AI Valley 实站故障**：Chrome 3.7.50 已显示“提交本页”，AI Valley JevPlay 六项主要资料由插件正确填写。插件最终点击后站方 Contact Form 7 返回 `failed` / `There was an error trying to send your message`，无成功回执或 Neon 新记录。旧版错误地将该站标为 `需登录` 并打开 Devpost 下一站，尽管页面没有登录栏。3.7.51 源码识别发送失败并阻止单页失败自动跳站、隔离人工提交监听；待重载、清除误标并在其他免费站实测。见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-25 / 3.7.50 侧栏整站提交入口**：会话启动抓取并快进 `origin/main` 至 `70ccac9`。Ego 3.7.48 SmartBizTools 实测暴露目标受众、Pros、Founder 误填和编辑声明代勾；3.7.49 重载后前述字段与声明已现场纠正。Chrome 3.7.49 在 AI Valley 由插件填好 JevPlay 表单，但未点击 Submit、无回执。3.7.50 源码新增明确“提交本页”入口，复用后台预检和账本流程，补修短/完整描述路由；53/53 回归通过。窗口控制中断使 3.7.50 尚未实机重载，Neon 无新增回读，十站目标仍未完成。见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-25 / 3.7.48 十站续验**：AI Tool Finder 已补 JevPlay / Graffiti Name AI 并取得两个 `Received for editorial review` UUID；AllToolsDirectory 已补 JevPlay / Graffiti Name AI，站方官方 `/api/submit-tool` 返回 `Tool submitted successfully`。源码将 JevPlay 补回内置 Profile，四条回执写入本地种子账本，并新增 AllToolsDirectory API 兜底。AINave JevPlay 已填完、上传图片并选 Free / Artificial Intelligence / Games，但最终提交弹登录；Offo JevPlay 已生成草稿但需登录发布。SmartBizTools 与 SoMuch 因必选确认框停放，FutureTools 因 CAPTCHA 停放，FoundrList 因登录停放。3.7.48 测试通过但尚未在 Chrome 扩展内部页重载或 Neon 回读。详见 `docs/三产品十站插件实测-2026-09-25.md`。

- **2026-09-25 / 本轮十站完成**：OldPhotoLive AI 又在 Insidr AI、FoundrList、Forward Future 取得站方回执，本轮合计 10 个不同新站：SmartBizTools、AINave、Offo 已公开，FoundrList 免费排期约 2026-10-19，上述其余 6 站待审核。申请主要经 Ego 手工完成；未把排期、审核或浏览器回执冒充已发布、插件自动提交或 Neon 同步。完成页签已关闭。Firsto 仅审查免费入口，未登录提交。3.7.43 免费路径组也补入这三站，源码待实机重载与云端回读。详见 `docs/外链续办与自动关页-2026-09-25.md`。

- **2026-09-25 / 3.7.43 免费路径与媒体修正**：AINave、SoMuch、Offo、Insidr AI、FoundrList、Forward Future 的已核实免费路径加入分组；OldPhoto 内置失效截图 URL 改为逐一确认可访问的官方 CDN 图片，品牌图改为官方 512px 图。源码未在 Ego 重载，Neon 未回读。详见 `docs/外链续办与自动关页-2026-09-25.md`。

- **2026-09-25 / 3.7.42 外链续办与回执纠错**：本轮 OldPhotoLive AI 新增 FutureTools、SmartBizTools、AI Tool Finder、AllToolsDirectory、AINave、SoMuch、Offo 七站回执；SmartBizTools、AINave、Offo 已有公开页，另四站待审核，距再交十站还差三站。SoMuch 邮箱确认已完成；AIWebsiteDirectory 待官网徽章，不计完成。Startup Collections、Startup Stash、AI SuperHub、Launchpedia 的 OldPhoto 被误重复提交，9 月 24 日已有同产品回执；新版将这四站主页/投稿路径统一去重。插件侧栏只在队列自建标签的精确账本保存后自动关页，并拦截后置徽章/邮箱确认伪成功。ToolsCourt 站方报错无回执，Zearches 与 NeuroToolsHub 已填表待条款授权。源码未重载到 Ego，Neon 未回读，未运行测试。详见 `docs/外链续办与自动关页-2026-09-25.md`。

- **2026-09-25 / 3.7.39 外链库双分组**：新增“高质量优先”“免费可提交”动态候选组，站点可手动入组/移出，选择写入 `siteAnnotations.library.groups` 并沿用 Neon 同步；设置页和侧栏可筛选，侧栏可按组建批次，原提交安全闸门不变。最近五站主要经 Ego 人工提交和插件人工记账，不能宣称大部分表单由插件自动提交。Ego 原空间有暂停旧批次，已另建验收空间；浏览器 URL 安全策略拒绝打开扩展管理页，禁止绕行，因此新版尚未完成浏览器重载和云端分组回读。见 `docs/外链库分组与插件能力-2026-09-25.md`。

- **2026-09-25 / 当前实站续办完成**：The Next AI、ListAi、Launching Next、Free AI Tools Directory、BestOfAI 五个来源站各自取得 JevPlay、OldPhotoLive AI、Graffiti Name AI 的站方免费申请或既有待审核证据，按 Profile 登记 `待审核` 并刷新确认各来源云端动态最新。ListAi OldPhoto 是站方已有 `pending review`，未重复提交；Launching Next 三款免费排队编号为 153624–153626；BestOfAI 登录后三款 `Awaiting Approval / Not Sponsored`；付费推广均未购买。Viesearch JevPlay/OldPhoto 邮件确认后选择 BASIC 免费等待队列并获 `Plan Selected!`，故该站不标 `付费`；Graffiti 缺当前 Gmail 确认邮件。TAIFY 验证失败，仅记笔记不计成功。`aitoolsdirectory.com` 标 `跳过`，Aitoolnet 标 `付费`，BestOfAI 标 `需登录`，对应页面重载后仍保留。9 月 24 日的 13 个三产品完整站点仍为历史基线，按基线加本轮五站可超过 15 站目标；缺少全量 Neon 账本，不宣称当前精确总数。详见 `docs/外链提交验收与误填保护-2026-09-25.md`。

- **2026-09-25 / Viesearch 邮件与云端回读复核**：远端检查无新提交（本地 `f751eaa` 与 `origin/main` 一致）。当前可复核的侧栏云端回读只显示 Viesearch 旧的 VideoToArticleAI 记录（2026-08-26），没有本轮三款 Profile 的成功记录；站点标记仅显示「可提交」，没有「需人工」。AITools Inc、TipSeason、Startup Stash 三站单站云端动态均显示三款 Profile 已提交，属于已有站点复核。9 月 24 日记录的 42 组合 / 15 个有回执站点 / 13 个三款齐全站点仍只是历史快照，本轮未取得完整 Neon 账本，不能沿用为当前数量。Gmail 全文件夹搜索到一封 9 月 24 日 Viesearch 会话，含 JevPlay、OldPhotoLive AI 两封确认邮件；未找到 Graffiti Name AI 的 Viesearch 邮件，确认链接未点击，Gmail 搜索页已留给用户。扩展没有专用邮箱连接；浏览器安全策略拒绝设置页直达，不绕行访问或提取本机密钥。AIGCLIST 与四个验证码页均保留。详见 `docs/外链提交验收与误填保护-2026-09-25.md`。

- **2026-09-24 22:35 / 目标改为 15 个三产品完整站点**：当前仍为 42 个有真实回执的产品×站点组合、15 个至少完成一款的站点、**13 个三款齐全的站点**；用户最新目标为 15 个完整站，还差 2 个。3.7.38 已在 Ego 重载并看到侧栏新增「需人工」站点标记；52/52 回归通过。Viesearch 三款各选免费等待队列后，站方均提示须邮件确认，插件正确拒绝把它们记为成功，站点本地显示可提交与需人工，新增人工标记尚未完成云端回读。Sites Plus 的提交规则勾选需用户处理。AIGC List 首页使 Ego 控制接口超时，当前无法安全关闭该页；四个验证码页继续留给用户，未强退浏览器。候选站点门槛与同步验收见 `docs/外链提交验收与误填保护-2026-09-24.md`。

- **2026-09-24 22:05 / 历史真实回执站点自动标记**：3.7.37 在精确 `destinationKey::profileId` 成功记录写入后，以及云端增量回读后，只对有 agent/manual 回执证据、尚无站点状态的目标补 `可提交`；旧表格占位不算，验证码/登录/付费/跳过等人工标记不覆盖。52/52 回归通过，待 Ego 重载核对旧站标记和 Neon 回读。

- **2026-09-24 22:00 / 运行态云同步修复**：已确认正常同步按修订号读取变更文档，提交账本/动态等对象使用字段级 PATCH；持续冲突的是旧浏览器批次 `activeBatchRun`，其标签页和队列游标只属于本机。3.7.36 将该运行态从 Neon 镜像文档列表移出，保留本机恢复；扩展重载时旧待上传/冲突队列会过滤该键，不强制覆盖本机备份。52/52 源码回归通过，待 Ego 重载并在设置页轻量核对冲突清零。

- **2026-09-24 21:59 / 3.7.36 实机回读**：Ego 管理页回读已启用 3.7.36；设置页「轻量核对版本」显示工作区 default、本机与云端版本一致、待上传 0 类、冲突 0 类。旧 `activeBatchRun` 冲突已从有效云文档队列清除，且未强制覆盖本机数据。


- **2026-09-24 21:55 / AISO 三产品公开收录**：Graffiti Name AI 与 JevPlay 均在 AISO 免费档获得 `is live` 回执，公开页分别为 `https://aisotools.com/tool/graffiti-name-ai`、`https://aisotools.com/tool/jevplay`，详情页直接链接各自官网，均 `nofollow`。AISO 三款自动提交动态在来源页显示 3 Profile、4 动态，强制回读为「云端动态已核对，当前记录是最新的」。累计 **41 个产品×站点真实回执、15 个站点、13 站三产品齐全**，距三款各 30 站还差 17 个完整站点。Graffiti Profile 的邮箱域名无 MX，站方拒绝后改用同一项目已验证有 MX 的 OldPhoto 业务邮箱才成功。JevPlay 分类选 Education & Research，描述仍准确说明免费 AI 决策游戏。3.7.35 新增 AISO 成功页精确上线识别，并修成功记录升级为已上线后迁移动态重复；回归通过，待重载复验。

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

## 2026-09-25 自动提交交接（3.7.44 源码）

- AI Tools Directory 投稿页及其 `aitool.paperform.co` 嵌入表单拒收 AI 生成或复制文案。插件在该站自动填表/提交入口一律停放；浏览器页签保留了产品名、URL、Freemium、标签、Syndred、不购买广告，原创描述/差异说明/邮箱未填，也未提交。
- 普通免费目录在站方回执后须核对本地精确成功记录、Neon 对应记录与时间线才自动关页/推进。云端未回读时保留页签、防重复点击，后续同步完成有界续跑；法律条款同意停放人工。
- OldPhotoLive 首装备用 Profile 已清理过期订阅/价格文案；上轮停在备用种子，Neon 正本更新见下方续办。3.7.44 未获浏览器重载/实站验收，不把源码能力写成已上线能力。详见 `docs/整站自动提交与原创投稿交接-2026-09-25.md`。
- 续办实绩：Neon `siteProfiles.OldPhotoLive.fields` 中 13 个旧种子字段已按修订 88 → 89 更新，GET 回读全数一致；其他 7 个 Profile 未变。Ego 本地缓存仍为 88，pending/conflict 均为 0，需浏览器回读才能目视生效。用户要求复测后已补 Worker 依赖与回归覆盖，Desktop 主项目完整回归 52/52 通过；Ego 画面捕捉失败且扩展内部页接管被浏览器拒绝，实站加载 3.7.44 尚未完成。

## 2026-09-26 插件十站三产品实测续办（当前）

- 用户追问投稿邮箱后核查：JevPlay `syndredyoung@gmail.com` 的 Gmail 收件箱当前可访问；OldPhotoLive `support@oldphotoliveai.com` 有 Cloudflare MX，Gmail 搜索到发往该地址的近期邮件；Graffiti 原 `support@graffitinameai.com` **无 MX**，不能可靠收件。3.7.89 将本地种子与运行时旧值回退到已验证 Gmail，云端 Profile 正本尚未改写或回读，3.7.89 尚未实载。邮箱核验 Gmail 页签已关闭。
- 新增候选 `aitoolsdirectory.site/submit.html` 经 Ego 页面预检，免费、类别覆盖三产品、需有效邮箱并声明会发确认信，尚未投稿；`freeaitools.fyi/submit` 404 剔除。两个预检页均已关闭。Ego 原生窗口仍报 ScreenCaptureKit 捕捉失败，插件详情页不能由浏览器标签 API 接管。
- 本轮从 `c31e948` 开始，代码迭代至 **3.7.89**，已推送的基线见 Git；Ego 已自主逐版重载并现场核对至 3.7.87，用户后续表示已重载但原生窗口捕捉故障使版本无法回读；3.7.89 尚未实载。54/54 Node 测试通过。
- 参考 Bitwarden、Automa、Playwright、Browser Use、BrowserGym 的字段语义、可操作性、逐步验证和独立回执机制，沿项目原有 DOM/AI/Neon 流程修分类、定价、R2 媒体、折叠付费表单、Select2、成功后自动入库与 Credible AI 瞬时回执。
- 本轮站方明确收件 6 个组合：ToolPilot 2、ThatsMyAI 3、Credible AI 1。**插件独立闭环且云端精确回读 4/30**：ToolPilot OldPhoto 与 ThatsMyAI 三款。ToolPilot Graffiti 有辅助回执和云端记录；Credible AI Graffiti 插件独立提交且站方显示回执，但插件漏记，Neon 精确记录待安全补录和回读，禁止重投。AppStackBuilder 无回执，不计成功。
- 本轮已用 AppStackBuilder、ToolPilot、ThatsMyAI、PromptHive、Credible AI、ProductReveal、B2B 预检页已关闭；仅扩展详情页因 Ego 原生捕捉故障且浏览器安全策略拒绝内部页接管，待恢复后关闭。原有 SEO 空间不动。用户目标 10 站×三产品、至少 16/30（超过 50%）尚未达成。详见 `docs/插件自动投稿开源对照与十站验收-2026-09-26.md`。
## 2026-09-25 / 3.7.45 台式机云端优先启动保护

- 旧版扩展重启时可能自动重放本地待上传队列；`siteProfiles` 支持无整份修订号的逐字段 PATCH，旧队列甚至可能改写已更新的 OldPhoto 字段，不能依赖 409 冲突保护。3.7.45 启动先回读云端，待上传/冲突期间暂停自动上传，待明确回读覆盖或手动成功上传后放行。台式机必须先完整退出旧浏览器，再拉代码、重载新版、回读云端；Ego 实机尚未验收。详见 `docs/整站自动提交与原创投稿交接-2026-09-25.md`。
