# 投稿站点适配器

共享字段解析、字符约束、校验与回执识别继续使用 `extension/content.js`；执行器通过 `engine.mjs` 加载同一生产代码。输入值回读、菜单选项回读、截图与云端核验由执行器共享模块处理。

`navtools.mjs` 登记 NavTools 免费 Basic 手动内容流程：

- `matches` 只匹配已核实站点投稿路径。
- `prepare` 选择免费 Basic 与 Add Details Yourself，回读 radio 状态。
- `fill` 使用冻结的 JevPlay 资料，完整描述、FAQ、Free 定价和真实 AI Productivity Tools 分类均有回读；清除未经核实的 Discord/Product Hunt 链接。
- `gate` 读取实际提交按钮、验证码响应是否存在及当前目标的公开 iframe URL。未完成的 Turnstile 会停在原页，没有提交边界或点击。

当前补充文案已核实用于 JevPlay，其他产品会停止并要求适配自己的资料。匹配正确字段不代表站方已经收件。

复跑时使用原任务的逐站恢复入口，先检查云端去重和尝试历史。验证码完成、表单校验通过且无旧未知尝试后，才能继续提交。已经收件的任务不会自动重投。尚未实现这些站点完全无人值守运行；人工验证码、真实身份资料、已有账号登录和站方禁用按钮仍属于待办。
