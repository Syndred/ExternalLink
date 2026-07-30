# PROJECT_CONTEXT

> 最后更新：2026-07-30｜扩展 2.5.0｜路线：混合 C
> 完整进度见 [`进度.md`](进度.md) / [`docs/进度.md`](docs/进度.md)。

## 当前已完成

- Chrome MV3：Side Panel 主 UI、Settings、Background 调度、Content 填表、local_agent。
- Table.xlsx 只作为外链库和 Profile 初始种子；运行记录以 `chrome.storage.local` 为准。
- `submissionRecords` v2 以 `destinationKey + profileId` 唯一标识成功组合。
- 旧 `siteAnnotations[].submittedProjects` 与 Table 历史记录会幂等迁移。
- 当前 Table 同步结果：5 个 Profile、57 条外链、5 个已提交行展开为 9 个成功组合。
- 每次批量开始从 Profile、账本、分类和外链库重新构建队列，不读取旧 `tasks`。
- 外链站分组，组内按用户勾选顺序提交多个 Profile；已有成功组合自动跳过。
- 同一外链站只开一个页签；成功后重新进入该站入口处理下一 Profile。
- 登录、验证码、无法重置表单会停放并释放并发位；人工可继续或确认成功。
- `paid / broken / skip / deleted` 排除整个外链站；单项目失败不误伤兄弟任务。
- Side Panel 分为“执行 / 批量 / 待人工”；Settings 提供外链库和账本导入导出。
- RainbowPetAI、RspAi、OldPhotoLive 已同步完整资料、Logo 和 Screenshot 1–4；本地 Logo 随备份恢复。
- Screenshot 1–4 使用统一媒体列表并按文件字段顺序映射；动态名称、域名、备注和日志均安全文本渲染。
- UI 基础规则见 [`DESIGN.md`](DESIGN.md)。

## 关键存储

| Key | 用途 |
| --- | --- |
| `siteProfiles` | 稳定 Profile ID 的自家网站资料 |
| `activeSiteId` | 当前手动填表网站 |
| `selectedSiteIds` | 最近一次批量多选 |
| `submissionRecords` | v2 永久成功账本 |
| `siteAnnotations` | 外链站级分类与临时闸门 |
| `activeBatchRun` | 仅恢复 running / waiting_manual / paused 的批次 |
| `urlList` | 自定义外链，新增/置顶项排在最前 |

## 关键文件

```text
extension/lib/queue.js       # 成功账本、迁移、分组队列
extension/lib/scheduler.js   # 同站续跑、并发位、稳定游标
extension/lib/backup.js      # 账本备份校验与合并
extension/background.js      # 调度和恢复
extension/sidepanel.*        # 执行 / 批量 / 待人工
extension/settings.*         # Profile / 外链库 / 备份 / 配置
tools/import_table_xlsx.py   # 按工作表解析 Profile、媒体、外链和历史记录
DESIGN.md                    # UI 基础规则
tests/*workflow.test.mjs     # 队列、调度、备份和 UI 行为测试
```

## 验证状态

- 已通过 Node 队列、调度、备份、UI 和扩展静态/行为测试。
- 已通过 Python 15 个 local_agent 单元测试。
- Computer Use 已确认 Chrome 中安装并启用 ExternalLink 2.5.0，三工作区正常，旧 Profile 去重后仅保留稳定 ID 对应资料，最近批量勾选保持不变。
- Google Sheet、仓库 Table 和 Chrome 扩展已同步；扩展重新加载后 9 个成功组合、3 个主要网站的 Logo / 截图和外链库状态均正常。
- 为避免启动 227 个真实外链项，本轮未点击“开始提交”；仍需用隔离测试目标严格复现 B/C → D/E，并验证停放恢复与浏览器重启。

## 后续边界

- P2 视觉 Agent 与博客评论仿写继续暂停，直到上述真实 Chrome 验收通过。
- Table 不做提交状态双向回写；账本 JSON 是扩展重装/备份通道。
- 不破解验证码、不绕过付费墙；仅明确成功证据或人工确认写入永久成功。
