# Product Hunt 专用自动化与真实验收（2026-09-09）

## 目标

把 Product Hunt 当作复杂站点压力测试：从「页面稳定后无条件待人工」改为可恢复的多步骤自动化，并把页面稳定、控件核验、上传预览和动作后回执约束复用于普通目录链路。仅登录、验证码、OTP、付费/法律确认和最终对外动作停下确认。

## 真实页面勘验

账号：`@syndred`；目标产品：`OldPhotoLive AI`；官网：`https://oldphotoliveai.com`。

已在真实 Product Hunt 草稿逐步验证：

- Main info：名称、49/60 tagline、官网、描述、`Photo editing / Artificial Intelligence` Topics、Maker 首评均可填写。
- Images and media：512×512 Logo 上传成功；4 张 1440×900 Gallery 图片上传成功并出现 4 个预览项。
- Makers：当前账号 `Syndred @syndred` 可设为 Maker，Solo Maker 可确认。
- Shoutouts：可选，可安全跳过，不伪造第三方背书。
- Extras：根据资料中的 Freemium 选择 `Paid (with a free trial or plan)`；Promo 和融资信息不猜测。
- Connect with Investors：可选且涉及未提供的经营信息，安全跳过。
- Launch checklist：Required 显示 `100% Complete`；最终动作精确为 `Create draft`，另一个 `Schedule launch for later` 不自动选择。

## 实现边界

- Product Hunt 使用专用阶段检测和白名单控件，不走普通目录提交按钮猜测。
- 每阶段记录 `stage / stageAttempt / expectedNext / lastTransitionAt`，MV3 Service Worker 或批次恢复后继续当前页面。
- 自动执行中的 Product Hunt 页签在「停止」时按普通自动页签关闭；只有已进入人工门或最终确认的页签保留。
- Checklist 默认只返回 `ready_to_create`。侧栏必须显示「确认创建 Product Hunt 草稿」，只有用户点击该明确按钮才授权点击 `Create draft`。
- 不点击 `Schedule launch for later`、Promote、Boost、Pay；不绕过登录、验证码、OTP 或法律确认。
- 点击后仍需取得本次新回执或产品草稿 URL，才写入 `submitted` 账本；旧产品页、旧评论和单纯按钮点击均不算成功。

## 当前验收状态

真实草稿已到 Launch checklist 且必填 100%。复审已修复慢 SPA `waiting` 被误判人工、最终回执判断顺序、隐藏 Maker/Pricing/法律控件、验证码恢复、重复媒体输入、预览复用和选择结果校验；全量 21 个测试通过。

普通目录实测新增 Saaspo / RainbowPetAI 成功回执：`Thank you! Your submission has been received!`。本次也因此发现通用回执正则漏掉 `has been received` 句式，已修复并补回归测试。该次动作发生在修复前，所以页面成功但扩展显示 `submitted_unconfirmed`，不能倒填成可信成功记录。

仍需在 Chrome 重载最新源码后，让扩展从 `/posts/new` 重跑 Product Hunt，并在最终 `Create draft` 前确认；DevPages 等第二种表单结构也需完成动作后回执入账。取得这些浏览器证据前，不宣称“所有站点都能自动提交”。
