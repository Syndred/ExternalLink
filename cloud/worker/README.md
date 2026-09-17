# ExternalLink 云端数据层

本目录是 Chrome 插件唯一云端数据源：Neon 存结构化状态、时间线修订与自动化 run/attempt/step，R2 存私有 Logo、截图和自动化证据附件，Worker 代理数据库、媒体和 DeepSeek。

文本辅助使用 `deepseek-v4-pro`。普通表单先由扩展的确定性扫描、填写、上传和提交流程处理；只有路由找不到、必填/校验失败、多步骤、自定义组件、富文本或上传预览需要复核时，才使用同一密钥调用 `deepseek-v4-flash-vision-exp`，读取标注截图、执行下一小步并用新截图继续。普通免费外链提交已获批次授权；验证码、登录/OAuth、付费、法律确认和破坏性动作转人工。多模态可以操作页面，但仍不能单凭模型自述授权成功入账。

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

日常编辑优先使用 `PATCH /v1/state/:key` 发送字段级变更。Worker 会在数据库当前最新版上原子合并并用修订号重试并发写入，避免另一台设备仅因持有旧的整份文档而覆盖新资料。迁移、恢复和不适合字段级合并的运行态文档仍使用带修订校验的 `PUT`；浏览器启动时会先自动回读云端状态。

部署不创建 Google OAuth，也不读取 Google Sheet。数据库连接串和 DeepSeek 密钥仅在 Worker 中使用。
