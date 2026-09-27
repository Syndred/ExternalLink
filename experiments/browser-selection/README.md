# 独立浏览器连接选型试验

用途：用无凭据的新 profile 检查 agent-browser 与 Playwright 的普通网页控制、合成表单与上传、正常关闭重启、已有会话状态在浏览器被强制结束后的显式重新加载。

这里只是诊断程序，不是生产提交器，不连接 Ego，不加载 ExternalLink 扩展，不连接 Neon。浏览器崩溃测试只结束命令行中匹配本次独立 profile 的一个浏览器主进程。服务器回执是合成数据，不能作为真实目录投稿。

## 复现

需要 Node 24+ 和 macOS/Linux 的 `ps`。依赖固定在 package-lock.json；浏览器安装后记录实际版本，不能假定未来 `agent-browser install` 下载的版本仍与本次一致。

```sh
cd experiments/browser-selection
npm ci
npx agent-browser install
npx playwright install chromium
npm run fixture
```

另一个终端先用 `npx agent-browser --config ./agent-browser.json doctor --offline --quick --json` 查看专用 Chrome for Testing 的实际安装路径，再运行：

```sh
TRIAL_AGENT_CHROME='/实际安装的 Chrome for Testing 可执行文件路径' npm run trial
```

不要填日常浏览器的 profile，也不要添加自动接管或扩展启动参数。每次 trial 使用新的 profile 和短 namespace，输出到 `evidence/<runId>/`。测试结束按 Ctrl+C 关闭 fixture。

非零退出代表至少一项失败；原始失败保留在 JSON 报告和步骤日志，禁止把后续恢复覆盖成全程通过。fixture 是内存服务加 JSONL 记录，重启 fixture 会重新计数；不提供数据库队列或防重投语义。

## 2026-09-27 结论

选择 Playwright＋其配套 Chromium 作为批量执行器的浏览器层。两轮各 9 次合成提交、3 次正常重启、1 次强制结束后显式重启、1 次 profile 隔离及 HTTPS 访问均通过。

agent-browser 能完成相同网页任务，但复测中关闭后重开出现一次 `Failed to connect: No such file or directory`，下一次普通调用恢复；该故障的根因未定位。首轮另有 namespace/session 组合过长超过 macOS socket 长度的问题，第二轮采用短名称后隔离测试通过。两类问题分别记录，不能归因于网页安全拒绝。

完整结果和证据见 [实测报告](../../docs/浏览器连接实测与选型-2026-09-27.md)。

## 总控接管诊断

`handoff.mjs`、`agent-handoff.mjs`、`controller-loss.mjs` 是本次现场演练的原始脚本，分别测试 Playwright 定位失败接管、agent-browser 定位失败接管、独立 Browser Host 下执行 worker 被强制结束后的接管与重连。它们不是生产总控，恢复文件不是可靠的多任务锁。结果和限制见 [接管报告](../../docs/总控接管实测-2026-09-27.md)。

每次完整演练都使用新目录，不复用 profile、恢复文件、状态文件或旧 fixture。先在已安装上述依赖的本目录运行：

```sh
trial_dir=$(mktemp -d /tmp/externallink-supervision.XXXXXX)
cp fixture.mjs "$trial_dir/fixture.mjs"
echo 'synthetic upload for supervised browser trial' > "$trial_dir/attachment.txt"
node "$trial_dir/fixture.mjs"
```

另一个终端把输出目录的绝对路径设为 `TRIAL_WORKDIR`，按顺序运行下列脚本。Playwright 定位演练要求 fixture 初始回执为零；后两项在已有回执数上校验只增加一条。

```sh
TRIAL_WORKDIR='/实际的新目录' node handoff.mjs
TRIAL_WORKDIR='/实际的新目录' TRIAL_AGENT_CHROME='/专用 Chrome for Testing 可执行文件' node agent-handoff.mjs
TRIAL_WORKDIR='/实际的新目录' node controller-loss.mjs
```

每项输出暂停状态后，由主代理在对应的独立原生窗口中核对 URL 与产品名，再修改 Description，并保存原生截图。不得同时运行两个控制器的写操作；不要自行点击 Submit test。十分钟内完成接管并把以下对应命令保存至新目录，执行器才会继续：

| 脚本 | 接管后 Description | 恢复文件及 JSON |
|---|---|---|
| handoff.mjs | `Supervisor verified draft` | `resume.json`：`{"owner":"worker","action":"resume","takeoverMethod":"实际接管方法","nativeCua":"实际观察结果"}` |
| agent-handoff.mjs | `Supervisor verified draft` | `agent-resume.json`：`{"action":"resume"}` |
| controller-loss.mjs | `Supervisor restored after controller loss` | `controller-loss-resume.json`：`{"action":"resume","attemptId":"本次输出的 attemptId"}` |

前两项结果中的 `samePage` 是现场记录，脚本未比较不可变页面 ID；第三项 `sameTarget` 来自实际 target ID 比较。原生接管方法由主代理工具记录与截图证明，不能凭报告中的文字字段认定。测试结束停止本次 fixture；脚本只关闭自己的浏览器会话，不接管日常浏览器。
