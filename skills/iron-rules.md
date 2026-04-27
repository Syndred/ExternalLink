# iron-rules.md - 10 条铁律

**违反任何一条即失败，每次任务前必读！**

## 铁律清单

### 1. 禁止设限
需要写 800 字 guest post？写。需要注册 + 验证 + 填 20 字段？全填。
**唯一合法跳过理由**：真付费墙 / 站已死 / CloudFlare 硬封。

### 2. 前端不行先逆向
按钮无反应、Modal 不弹 → **第一反应是找后端 API**，不是标"跳过"。
参考 reverse-eng.md 的 SOP。

### 3. 候选筛选查 spam + traffic
DR（Domain Rating）**是假指标**，traffic 才是真的。
SQL 层必须硬过滤：`WHERE is_spam = 0 AND traffic >= 100`

### 4. 去重按域名不按模板 ID
同一域名可能有多条模板记录，去重必须按 domain 字段。

### 5. 查邮件必须开新标签页
绝不 navigate 离开有表单的页面！开新标签页查邮件/Gmail。

### 6. rel 属性每次实测
DB 历史标记不可信。提交后必须 JS 验证当前页的 rel 属性：
```js
document.querySelectorAll('a[href*="你的域名"]').forEach(a => console.log(a.rel || 'EMPTY'))
```
EMPTY = Dofollow，含 nofollow = 非 Dofollow

### 7. 先读知识库再查 DB
API snippet、隐藏字段名、rel 纠正等信息都在 Skill 文件里。
查 DB 之前先确认目标平台在知识库中的经验。

### 8. 切站必须确认产品
曾经 18 个外链锚文本全写错（A 站的内容写成了 B 站）。
每次切站后第一步：确认当前站点的品牌名、URL、锚文本白名单。

### 9. catch-all 邮箱失败立刻切 Gmail plus-addressing
很多站静默拒绝自定义域名邮箱。
Gmail plus-addressing 格式：`yourname+siteid@gmail.com`

### 10. 验证码协作：必须先填完所有字段
填完所有字段 → 滚动到验证码区域 → 确认"所有字段填完，只剩验证码" → 再叫人。
**绝不**填一半就叫人过验证码。

## 3 站锚文本白名单
| 站 ID | 品牌名 | 域名 | 默认锚文本 |
|-------|--------|------|-----------|
| site-a | OldPhotoLiveAI | oldphotoliveai.com | OldPhotoLiveAI - AI Photo Restoration Tool |
| site-b | GraffitiNameAI | graffitinameai.com | GraffitiNameAI - AI Graffiti Name Generator |
| site-c | Comparison-Text | comparison-text.site | Comparison-Text - Free Online Text Comparison Tool |
