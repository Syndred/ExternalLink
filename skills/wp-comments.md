# wp-comments.md - WordPress 评论提交手册

## WP 评论表单标准结构
```html
<form id="commentform">
  <input name="author">      <!-- 显示名，用随机真实人名 -->
  <input name="email">       <!-- 干净 Gmail，不用品牌域名邮箱 -->
  <input name="url">         <!-- ← 链接放这里！正文不放 URL -->
  <textarea name="comment">  <!-- 纯文本评论，不放任何 URL -->
  <input name="submit">
</form>
```

## 提交 SOP
1. **确认目标文章**：评论数 > 50、有 SEO 评论存活、老文章（>1年）
2. **检查竞品**：竞品评论是否仍存活？存活 → 同篇文章下发
3. **填写表单**：
   - author：随机真实外国人名（不用品牌名）
   - email：干净 Gmail（不用 team@yourdomain.com）
   - url：放你的目标链接
   - comment：纯文本，无 URL，与文章主题相关的真情实感评论
4. **Use Playwright pressSequentially**：逐字符输入，触发键盘事件链
5. **提交**：点 submit → 等页面刷新
6. **检查提交结果**：
   - 出现"评论待审核" = 成功
   - 出现 403 = 被反垃圾系统拦截（查 anti-spam.md）
   - 评论消失（无声吞掉）= Akismet 已标记此邮箱/IP

## 反垃圾系统快速识别
| 反垃圾系统 | 识别特征 | 处理 |
|-----------|---------|------|
| Akismet | 评论无声消失/进 spam 队列 | 切干净 Gmail + ISP 代理 |
| Antispam Bee | 德文提示、403 返回 | pressSequentially 原生输入 |
| WPantispam | 中文/英文验证问题 | 看 anti-spam.md |
| CleanTalk | 403 + "CleanTalk" 字样 | 直接跳过 |
| hCaptcha Enterprise | hCaptcha 图标 | 跳过 |
| Jetpack | 跨域 iframe 评论框 | 跳过 |

## 常见表单冲突处理
- **评论框在 iframe 中**：尝试直接访问 iframe src
- **JS 动态加载评论框**：等待页面完全加载后再 snapshot
- **AJAX 提交无刷新**：检查 Network XHR 响应
- **嵌套评论**：不要在嵌套层发，在主评论区发

## 高成功率评论模式
```
"Great breakdown of [文章核心话题]. I've been exploring this area
for [时间], and your point about [文章某个观点] really resonates.
Looking forward to more posts like this."
```
关键：不提你的站、不提产品、不放链接在正文。文章相关 + 正面评论。