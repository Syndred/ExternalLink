# dofollow-2026.md - 2026 实测 Dofollow 平台清单

## 第一类：开发者博客平台 ✅

| 平台 | DR | OAuth | 创建方式 | 链接属性 | 成功率 |
|------|-----|-------|---------|---------|--------|
| velog.io | ~85 | GitHub/Google | Markdown 文章 | Dofollow ✅ | 高 |
| dev.to | ~92 | GitHub | Markdown 文章 | Dofollow ✅ | 高 |
| telegra.ph | 92 | 无需 | API 调用 | Dofollow ✅ | 100% |
| rentry.co | ~60 | 无需 | curl API | Dofollow ✅ | 100% |

**velog.io 关键操作**：
- GitHub OAuth 登录即注册
- Markdown 编辑器，直接写文章
- 文章内链接默认 Dofollow
- 即发即过，无审核

**telegra.ph API 示例**：
```python
import requests
r = requests.post('https://api.telegra.ph/createPage', json={
    'access_token': '...',
    'title': 'Article Title',
    'author_name': 'Display Name',
    'content': [{'tag': 'p', 'children': ['Content with <a href="https://yoursite.com">anchor</a>']}],
    'return_content': True
})
```

**rentry.co curl 示例**：
```bash
curl -d 'text=Content with [anchor](https://yoursite.com)' \
     -d 'edit_code=mycode' \
     https://rentry.co/api/new
```

## 第二类：SaaS 目录提交 ✅

**识别特征**：
- 有 "Submit product/tool/startup" 入口
- URL 是品牌短 slug（如 `site.com/tools/my-product`）
- 系统自动生成 listing 页
- "Visit website" 按钮默认 Dofollow

**提交成本**：最低只填 1 个 URL
**Dofollow 率**：接近 100%
**2026 趋势**：大量转向付费（ProductHunt 启动页收费、BetaList 排队制）

## 第三类：论坛 Profile Website 字段 ✅

| 论坛系统 | 字段名 | Dofollow | 成功率 | 注意 |
|---------|--------|---------|--------|------|
| phpBB | pf_phpbb_website | ✅ | 100% | op=info 页面 |
| Boardhost | Link URL | ✅ | 100% | 无需注册 |
| Discuz | Site（个人资料） | ✅ | 95% | op=info 页面 |
| MyBB | Profile Website | ✅ | 90% | 类似 phpBB |

## 已确认降级的平台 ❌（2026）

| 平台 | 曾 Dofollow | 现状 | 降级原因 |
|------|-----------|------|---------|
| paragraph.com | 2025 ✅ | 2026 ❌ | rel="ugc nofollow" |
| hackmd.io | 2025 ✅ | 2026 ❌ | rel="ugc nofollow" |
| justpaste.it | 2025 ✅ | 2026 ❌ | nofollow 全部 |
| codepen.io | 2025 ✅ | 2026 ❌ | nofollow 全部 |
| medium.com | 部分 | Nofollow 全部 | 平台策略 |
| hashnode.com | 部分 | Nofollow 全部 | 平台策略 |

**降级规律**：Paste/Note 类平台集体降级，响应 Google 政策给 UGC 内容加 `rel="ugc nofollow"`

## rel 属性验证 JS
提交后每次实测：
```javascript
document.querySelectorAll('a[href*="你的域名"]')
  .forEach(a => console.log(a.rel || 'EMPTY'));
// EMPTY = Dofollow ✅
// 含 nofollow = 非 Dofollow ❌
// 含 ugc = UGC 标记，但可能有 Google 权重传递