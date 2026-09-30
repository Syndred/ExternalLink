# 无扩展重构逐项验收审计

2026-09-30补充纠正：本文件原表只覆盖当时的有限验收项，不能据此宣称原插件所有功能完成迁移。用户指出缺项后已补回新增网站、分类/分组/收藏/权重/质量分、动态总览、批量流程、产品提取和AI评论等入口；完整功能对照与剩余缺口见 `workbench-feature-parity-2026-09-30.md`。

审计日期：2026-09-30。依据原目标、原交接与当前文件、运行状态、真实回读及测试输出。此文件不改变验收范围，也不把未验证项判为完成。

| 原要求 | 当前可核验的证据 | 结论及限制 |
| --- | --- | --- |
| Gmail 旧记录兼容迁移 | `gmail-migration-real.json`：旧记录650，真实重启和详情SHA；`gmail-history-restart-real.json`：无缺失owner；`executor-gmail-sync.test.mjs`覆盖中断、账号切换及同ID隔离 | 已验证Windows旧记录迁移。早期证据关联数6存在alias重复，以最新唯一关联3为准，历史证据不改写 |
| Gmail 初始及增量同步 | 当前聊天 `assistant-current-chat-real.json`：694封、history、connected；测试覆盖先持久邮件再推进游标、初始分页重启 | 初始完成及无新增history轮次已验证；真实新增邮件仍无证据 |
| 长期Gmail续期 | 真实OAuth及refresh独立profile读回；Testing grant到期2026-10-07T07:44:34.750Z | 仅证明当日授权/刷新。跨到期续期、重授权及长期运行未验收；不修改时钟、不伪造新增邮件、不自行发布OAuth应用 |
| 产品新增、归档及恢复 | `app-media-real.json`：工作台创建隔离产品、独立云回读、归档恢复、原8产品不变 | 已验证；测试产品最终归档，无投稿 |
| 媒体版本管理 | 同证据：2个独立assetID、旧SHA、停用与恢复；实测截图及预览；测试覆盖immutable、未知上传响应、冲突云端选择 | 已验证版本追加/旧版本恢复/停用。缺失的旧Mac路径素材仍缺失，不以测试素材替换实际产品 |
| 冲突处理 | `conflict-real-before.json`与`conflict-real-after.json`：真实冲突、UI选择本机、远端历史保留；测试覆盖精确revision和选择云端 | 已验证真实本机选择及并发保护；云端选择有回归测试，未声称有额外真实操作 |
| 统一助手工具 | stdio真实调用、app-server发现14工具、当前聊天直接调用app_data/gmail_sync/task_detail | 已验证真实客户端路径；投稿工具没有调用，仍需用户重新允许投稿 |
| 断网与未知写响应恢复 | `executor-application-recovery.test.mjs`使用真正HTTP连接丢失及磁盘SQLite关闭重开；产品/媒体测试覆盖持久意图、原ID与独立回读 | 集成恢复通过。网络故障在隔离测试中注入，未声称已中断用户整机网络或真实投稿过程中断网 |
| Windows后台、浏览器与更新恢复 | `workbench-restart-2026-09-30.json`真实后台/工作台重启保留session；`gmail-history-restart-real.json`更新后数据；`browser-restart-real.json`真实Chrome重启原profile、原ID、9/20预算云读回 | Windows路径已验证；最新修正空闲加载，最终功能checkpoint pending=0、paused=true |
| 实体Mac | 当前执行环境Windows；可用控制工具未提供远端Mac连接，未发现实体Mac实测产物 | 未验证。需要可用的实体Mac执行环境；Windows和跨平台模拟不能代替 |
| 固定30暂停、原ID及未知边界 | 当前真实MCP读回paused=true、cursor13、count30、原scopeSHA；NEEED原ID与9calls/20actions保持；Store未知边界恢复回归 | 当前边界保持。未调用run_task、全局resume或替换失败项；原未知任务必须先核验 |
| 不提交/推送源码、最新云端代码 | 最近git pull --ff-only：Already up to date，HEAD...origin/main=0/0；保留未提交工作 | 本次没有commit/push。Worker部署与源码推送分别记录，不混淆 |

本次查看的全套输出为314通过、0失败、0跳过；四页浏览器回归明确标记synthetic_ui_regression。这些结果不能替代右列缺失的真实证据。

2026-09-30用户回复“先预留mac就好 然后告诉我怎么用 到时mac不行我再叫他修”。据此实体Mac验收由用户明确延后，保留平台入口和说明，不再把接入Mac作为当前交付前置条件，也不声明实机完成。使用方法见 `no-extension-usage.md`。Gmail真实新邮件及长期授权依然受外部邮件/时间条件限制；固定批次继续暂停，不为验收发送邮件或投稿。
