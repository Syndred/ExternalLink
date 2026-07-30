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
- `siteAnnotations`：外链站级分类；`paid/broken/skip/deleted` 排除全站，登录和验证码是临时闸门。
- `activeBatchRun`：仅用于恢复明确运行中或待人工的批次。
- `Table.xlsx` / `table-library.json`：外链库和 Profile 初始种子，不是运行记录真相源。

Settings 的“外链库”可查看、删除、置顶和筛选站点，并查看各 Profile 的提交状态。“导出 JSON / 导入 JSON”用于扩展重装和备份恢复。

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
python3 tests/local-agent-unit.test.py
```

发布前仍需在真实 Chrome 中复现 B/C → D/E，并检查停放恢复、扩展重载和浏览器重启。
