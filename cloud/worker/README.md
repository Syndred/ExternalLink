# ExternalLink 云端数据层

本目录是 Chrome 插件唯一云端数据源：Neon 存结构化状态与时间线修订，R2 存私有 Logo/截图，Worker 代理数据库、媒体和 DeepSeek。

## 首次部署

1. 在 Neon 创建一个空项目/生产分支，在 SQL Editor 执行 `schema.sql`。
2. 登录 Cloudflare 后，在本目录执行 `npm install`，创建 R2 bucket：`npx wrangler r2 bucket create externallink-media`。
3. 设置 Worker 秘密（不要写入仓库）：

   ```bash
   npx wrangler secret put DATABASE_URL
   npx wrangler secret put APP_ACCESS_TOKEN
   npx wrangler secret put DEEPSEEK_API_KEY
   ```

   `APP_ACCESS_TOKEN` 使用至少 32 字节随机值；它只保存到你的本机扩展设置，绝不提交。

4. `npm run deploy` 后，将 Worker URL 和 token 填到扩展「云端数据中心」。
5. 在扩展先导出 JSON 备份，再点击「迁移本机数据到云端」。迁移完成后运行「从云端回读」核对数量，最后运行 `tools/migrate-media-to-r2.mjs` 上传媒体。

迁移会把全部状态文档和时间线放进同一个 Neon HTTP 事务，避免按记录消耗 Worker 子请求。若网络中断后重试，云端已有文档与本机相同则只补齐缺项；发现云端有不同内容时会返回冲突并拒绝覆盖。

部署不创建 Google OAuth，也不读取 Google Sheet。数据库连接串和 DeepSeek 密钥仅在 Worker 中使用。
