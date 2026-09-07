# ExternalLink Chrome 扩展

ExternalLink 是一个按外链站分组的多网站提交工作台。用户可一次勾选多个自家网站；扩展会自动跳过已有成功记录的“外链站 × Profile”组合，在同一外链站页签内依次处理剩余项目。

## 安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择本仓库的 `extension/` 文件夹。
5. 修改代码或恢复备份后，在扩展管理页点击“重新加载”。

## 云端数据中心

扩展不需要启动本机服务。Cloudflare Worker 代理 Neon 数据库、R2 私有媒体和 DeepSeek；数据库连接串、DeepSeek Key 和设备访问密钥只保存在 Cloudflare 加密 Secret 中，不会放入扩展包。

首次部署后，在 Settings → 外链库 →「云端数据中心」填入 Worker 地址和本设备密钥，先导出 JSON 备份，再点「首次迁移到云端」。迁移完成后回读一次核对数量。`table-library.json` 只作为首装兜底快照；迁移后的 `sheetTableData`、Profile、外链库、账本、时间线和备注均以云端工作区为准。

私有 Logo 和截图由 R2 保存。一次性上传 `/Users/syndred/Desktop/projects/media/` 中的六个 Profile 资产后，资料字段会改为 `cloud-media://…` 引用；填写表单时扩展通过 Worker 读取并以 `File + DataTransfer` 注入，不需要本机目录或本机 Agent。

## 使用

1. 在 Settings 的“网站资料”左侧选择或添加稳定 Profile；列表可拖动排序，右侧编辑资料。
2. 在 Side Panel 的“批量”勾选本轮要提交的网站。
3. 检查预计外链站数、待提交组合数和历史成功跳过数。
4. 点击“开始提交”。
5. 登录、验证码和无法重置表单的任务会出现在“待人工”，并释放并发位。
6. 只有云端 `judge` 看见成功页、成功文案等明确 success evidence，或人工点击“确认成功”后，才写入永久成功账本；成功不是由固定计时器判断。

“执行”区当前 Profile 单选只控制手动填表，不会替代“批量”区的多选。

## 数据

- `siteProfiles`：自家网站资料，使用稳定 Profile ID。
- `submissionRecords`：v2 成功账本，唯一键为 `destinationKey + profileId`。
- `submissionTimeline`：追加式动态时间线；同一外链站可按不同 Profile 分别记录提交、待审核、上线、拒绝、跟进和笔记，不覆盖历史事件。
- `sheetTableData`：外链库完整字段和 Profile Notes，供卡片展示与离线运行。
- `siteAnnotations`：外链站级分类；`paid/broken/skip/deleted` 排除全站，登录和验证码是临时闸门。
- `activeBatchRun`：仅用于恢复明确运行中或待人工的批次。
- Neon 工作区：日常唯一数据源。
- `Table.xlsx` / `table-library.json`：历史首装快照，不作为维护入口。

Settings 的“外链库”可分别按站点分类和运营进度筛选。点击左侧卡片后，右侧时间线可增删改提交、审核和跟进记录；云端连接完成后变更会自动保存。卡片首屏显示入口 URL、提交项目、提交时间、最近动态、Record 和 Detail，不再展开表格原始字段。网站资料页可查看和编辑 Sheet 中的全部 Profile 字段与 Notes。“导出 JSON / 导入 JSON”会同时备份成功账本、时间线和 Sheet 快照。

固定扩展图标后，右键选择“打开 ExternalLink 设置”即可直达设置页。侧边栏会随当前标签页、成功账本或时间线变化，展示当前外链站按 Profile 区分的最新 8 条提交、审核、上线、拒绝和跟进动态；完整记录仍在设置页外链库中查看。

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
node tests/cloud-sync-workflow.test.mjs
node tests/cloud-worker-core.test.mjs
node tests/table-import.test.mjs
node tests/publication-playbook.test.mjs
```

发布前仍需在真实 Chrome 中复现 B/C → D/E，并检查停放恢复、扩展重载和浏览器重启。
