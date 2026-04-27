# strategies.md - 扩展策略

## 一、包管理器外链策略（Parasite SEO）

### 原理
在 npm / PyPI / Packagist / Docker Hub 等包管理器发布包，description / README 中嵌入目标链接。这些平台 DR 极高（npm DR96, PyPI DR95），链接权重传递强。

### 21 个包管理器
| 包管理器 | URL | DR | 链接字段 | 难度 |
|---------|-----|-----|---------|------|
| npm | npmjs.com | 96 | README, homepage | 低 |
| PyPI | pypi.org | 95 | Project description, Homepage | 低 |
| Packagist | packagist.org | ~85 | README, Repository | 低 |
| Docker Hub | hub.docker.com | ~94 | Description, Repository | 低 |
| RubyGems | rubygems.org | ~88 | Homepage, Description | 低 |
| NuGet | nuget.org | ~85 | Project URL | 低 |
| Cargo | crates.io | ~80 | Homepage, Repository | 低 |
| Hex | hex.pm | ~75 | Homepage | 低 |
| Pub.dev | pub.dev | ~75 | Homepage | 低 |
| Maven Central | search.maven.org | 90+ | POM URL | 中 |

### 发布 SOP
1. 创建最小合法包（1 文件 + package.json）
2. 在 description 和 readme 中嵌入链接（格式自然）
3. 发布到包管理器
4. 验证链接可访问 + rel 属性

### 注意事项
- 不要发纯垃圾包（会被举报/spam）
- 包名别含目标品牌名（太明显）
- README 内容要有一点点实际价值（哪怕只是示例代码）

## 二、卫星站部署

### 策略
为每个主站部署 2-3 个轻量卫星站（小博客/静态站），互相链接形成支撑网。

### 卫星站类型
- **GitHub Pages**（yourname.github.io/repo）- DR96，免费 SSL
- **Netlify**（site.netlify.app）- 自动部署，免费
- **Vercel**（site.vercel.app）- 免费
- **CloudFlare Pages**（site.pages.dev）- 免费
- **Notion 公开页**（notion.site）- DR92
- **Google Sites**（sites.google.com）

### 卫星站用法
- 卫星站首页 → 主站链接（Dofollow）
- 卫星站内容互相链接
- 主站不做反向链接到卫星站

## 三、Dev.to 链接枢纽模式

### 原理
Dev.to 允许自定义 canonical URL。在 Dev.to 发文章，设置 canonical 指向自己主站 → 文章权重回流。

### 操作
1. 先在主站发布一篇文章
2. 在 Dev.to 发布同内容（调整标题）
3. Dev.to 编辑器底部设置 canonical_url 指向主站原文
4. 文章过审后，Dev.to 的权重会通过 canonical 回流主站

## 四、索引加速

### 提交后加速收录
```bash
# Ping Google（Blogspot/Blogger 用户可用）
# 或通过 Google Indexing API（需 GSC 认证）

# Bing IndexNow（无需认证）
curl -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json" \
  -d '{
    "host": "yoursite.com",
    "key": "your-key",
    "urlList": ["https://yoursite.com/new-page"],
    "keyLocation": "https://yoursite.com/indexnow-key.txt"
  }'

# 批量提交 sitemap 中的新 URL（Google / Bing Search Console）
```

### 社交信号加速
- Twitter/X 发推带链接
- Reddit 发帖带链接
- Pinterest Pin 带链接
- Tumblr 发帖

这些社交平台 DR 极高，虽然都是 nofollow，但能加速爬虫发现新页面。

## 五、竞品反查 SOP

### 正确做法
1. 从 Ahrefs 拿到竞品的**精确 URL**（具体到哪篇文章）
2. 打开该文章检查竞品评论是否**仍然存活**
3. 存活 → 在**同一篇文章**下发评论（已证明这篇无审核）
4. 不存活 → 站长正在清理，整站跳过

### 选文章 Heuristics
- 评论数 > 50 且有明显 SEO 评论存活 = 站长不管这篇
- 老文章（>1 年）评论区更安全 = 站长不再关注
- 最近有新评论的老文章 = 评论区仍活跃且无审核

### 错误做法（血泪教训）
- ❌ 从 Ahrefs 拿到竞品在 example.com 有外链 → 随便找一篇文章发评论
- ❌ 没检查竞品评论是否存活就直接发