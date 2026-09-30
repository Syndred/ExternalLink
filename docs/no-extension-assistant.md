# 无扩展统一助手入口

工作台：`http://127.0.0.1:19389/`，使用原本机启动入口打开。主服务、工作台、MCP 共享原 SQLite、产品范围和执行器，没有独立投稿队列。

本机 MCP 入口为 `executor/src/assistant-mcp.mjs`，使用 Node 24.21 或更新版本启动。支持 stdio JSON-RPC、initialize、ping、tools/list、tools/call。凭据从原本机配对记录在内存读取，不通过命令行传入，不打印，不创建额外凭据。已通过 `codex mcp add` 新增本机 `externallink-local`，原配置备份在 `C:/Users/Administrator/.externallink-backups/codex-mcp-2026-09-30/config-before.toml`，其他配置保留。

```json
{
  "mcpServers": {
    "externallink-local": {
      "command": "node",
      "args": ["C:/Users/Administrator/Desktop/project/ExternalLink/executor/src/assistant-mcp.mjs"]
    }
  }
}
```

14 个工具覆盖完整应用读取、指定产品预览与编辑、外链维护和产品新增/归档、媒体上传、版本冲突处理、原任务详情/准备/运行/核验、暂停、同步、Gmail 状态和只读同步。所有工具只转发原本机接口。运行原任务必须带原 taskId 和 acceptanceId；没有全局 resume 工具，也没有 Google 客户端导入、授权或凭据输出工具。

当前用户要求先完成功能，投稿暂停。不得调用 externallink_run_task，直到用户重新明确允许投稿。unknown 边界不允许重新准备或执行；邮件关联不代表站方审核或公开上线。

真实 stdio 工具调用验证见 `docs/evidence/no-extension-2026-09-30/assistant-mcp-real.json`。真实 Codex app-server 的 MCP 启动、握手及 14 工具发现见 `assistant-client-real.json`。后续连接已在当前聊天载入工具目录，并直接调用应用读取、Gmail 只读同步和原任务详情，全部成功；脱敏证据为 `assistant-current-chat-real.json`。固定批次仍暂停 13/30，原 NEEED 预算保持 9 calls / 20 actions；没有调用投稿工具。本次 Gmail history 没有新增邮件，不能作为新增邮件增量验收。

配置语法依据 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)，本机 `codex mcp add --help` 和 app-server 导出的协议 schema 已实查。
