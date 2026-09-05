# ExternalLink Chrome 扩展

ExternalLink 是一个按外链站分组的多网站提交工作台。用户可一次勾选多个自家网站；扩展会自动跳过已有成功记录的“外链站 × Profile”组合，在同一外链站页签内依次处理剩余项目。

## 安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本仓库的 `extension/` 文件夹。
5. 修改代码或恢复备份后，在扩展管理页点击“重新加载”。

## 本地 Agent

```bash
pip install -r requirements.txt
cp .env.example .env
python3 -m local_agent.server
```

在 `.env` 中设置 `DEEPSEEK_API_KEY`。密钥只保存在本地代理，不放入扩展包。

### Google Sheet 单一维护源

在仓库外保存 Google OAuth 客户端 JSON，并在 `.env` 配置：

```bash
GOOGLE_SHEET_ID=你的私有工作簿ID
GOOGLE_OAUTH_CLIENT_FILE=/仓库外/google-client.json
```

首次连接或需要拉取 Google Sheet 新改动时启动本机 Agent，到 Settings → 外链库依次点击“连接 Google”“预览同步”“应用同步”。应用后日常查看、筛选、记录时间线均直接使用 `chrome.storage.local`，不需要 Agent 常驻；断开 Google 也不会丢弃已应用缓存。只有再次拉取、回写成功账本、AI/媒体等本机能力才需要临时启动 Agent。扩展会把 `Link Submit` 的全部原始列、每个 Profile 的全部 `Field / Content / Notes` 保存到本地运行缓存。Google 暂时不可用时记录留在 outbox，可点击“回写待同步记录”重试。

Google token 优先保存在系统钥匙串；只有钥匙串不可用时才写入仓库外的用户私有文件。扩展自身不会获得 refresh token。

## 使用

1. 在 Settings 的“网站资料”添加或确认稳定 Profile。
2. 在 Side Panel 的“批量”勾选本轮要提交的网站。
3. 检查预计外链站数、待提交组合数和历史成功跳过数。
4. 点击“开始提交”。
5. 登录、验证码和无法重置表单的任务会出现在“待人工”，并释放并发位。
6. 只有 `/judge` 看见成功页、成功文案等明确 success evidence，或人工点击“确认成功”后，才写入永久成功账本；成功不是由固定计时器判断。

“执行”区当前 Profile 单选只控制手动填表，不会替代“批量”区的多选。

## 数据

- `siteProfiles`：自家网站资料，使用稳定 Profile ID。
- `submissionRecords`：v2 成功账本，唯一键为 `destinationKey + profileId`。
- `submissionTimeline`：追加式动态时间线；同一外链站可按不同 Profile 分别记录提交、待审核、上线、拒绝、跟进和笔记，不覆盖历史事件。
- `sheetTableData`：最近一次 Sheet 快照，包含 `Link Submit` 全部原始字段和 Profile Notes，供卡片展示与离线运行。
- `siteAnnotations`：外链站级分类；`paid/broken/skip/deleted` 排除全站，登录和验证码是临时闸门。
- `activeBatchRun`：仅用于恢复明确运行中或待人工的批次。
- 私有 Google Sheet：日常唯一人工维护源。
- `Table.xlsx` / `table-library.json`：首次安装和离线回滚种子，不再日常双处更新。

Settings 的“外链库”可分别按站点分类和运营进度筛选，包括表格有提交动作（未核验）、已提交、待确认收录、待审核、待跟进、已收录、被拒绝、疑似丢链和未提交。每张卡片首屏显示入口 URL、提交项目、提交时间、最近动态、Record、Detail 和备注，并可展开完整时间线继续追加审核和跟进记录；网站资料页可查看和编辑 Sheet 中的全部 Profile 字段与 Notes。“导出 JSON / 导入 JSON”会同时备份成功账本、时间线和 Sheet 快照。

## 支持的处理层

| 层级 | 用途 |
| --- | --- |
| 规则填表 | 标准目录、评论和资料表单 |
| DOM Agent | 寻找提交入口、字段映射、结果判断 |
| 人工停放 | 登录、验证码、无法重置表单 |
| 视觉 Agent | 暂未启用；待真实 Chrome 闭环验收后再开发 |

扩展不会破解验证码、绕过付费墙、OTP 或邮箱验证。

## 验证

从仓库根目录运行：

```bash
node tests/queue-workflow.test.mjs
node tests/scheduler-workflow.test.mjs
node tests/backup-workflow.test.mjs
node tests/ui-workflow.test.mjs
node tests/extension-content.test.mjs
node tests/local-agent.test.mjs
node tests/google-sync-workflow.test.mjs
node tests/table-import.test.mjs
node tests/publication-playbook.test.mjs
python3 tests/local-agent-unit.test.py
```

发布前仍需在真实 Chrome 中复现 B/C → D/E，并检查停放恢复、扩展重载和浏览器重启。
