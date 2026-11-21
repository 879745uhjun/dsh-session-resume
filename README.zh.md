# dsh-session-resume

DSH 关掉时还没跑完的那一轮，重新打开后问你一句「要不要接着做」。

## 它解决什么

会话日志是追加写的（`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`），一次 `turn/start`
到下一次 `turn/end` 之间是一整轮任务。进程被杀、断电、崩溃时，最后那一轮只有 `turn/start`
没有 `turn/end` —— 这是磁盘上已有的硬事实，不需要在关闭时抢救任何东西。

宿主半启动后扫最近 14 天的日志，把「最后一轮没结束」的会话整理成一条条摘要：标题、工作区、
中断多久、第几步、当时在跑哪个工具、你最初的任务、模型最后的输出。

## 交互

1. 页面加载后，如果有可恢复的条目，弹一次居中对话框；**一次只显示一条**，处理完自动换下一条，最后一条处理完自动关闭。
2. 每条右边「从断点继续」：打开那个会话，把续跑指令填进输入框，**不自动发送**。
3. 「忽略」：按中断时间戳记账，同一会话再次中断会重新提示。
4. 没有可恢复项时显示「现在没有需要恢复的任务」；点「复制」成功后弹窗也直接关闭。
5. 输入框没认出来时，弹窗里展开指令并提供「复制」按钮（9 秒内会反复重试并校验写入是否被重渲染清掉）。

## 判定口径

- 只算「跑到一半被关掉」：`turn/start` 之后没有 `turn/end`。
- 日志 45 秒内还在写的会话视为正在运行，不进弹窗；页面加载后会**每 4 秒复查、最多 30 次**，
  所以刚重启时"全都像在跑"的情况会在窗口过去后自动弹出，不需要刷新。
- `user/message` 里只有 `source.kind === "user"` 的才算你的任务，运行时注入的上下文、时间戳、
  技能目录都排除。

## 安装

### 主路径（运行中即可，不用退出 DSH）

```bash
dsh plugin add "D:/Deepseek work/workplace/dsh-session-resume"
```

然后**刷新页面**：宿主半热应用，客户端模块在页面加载时构建。

装好后 profile 的 `package.json` 必须同时有两处，缺一不可：

```json
{
  "dependencies": { "dsh-session-resume": "link:D:/Deepseek work/workplace/dsh-session-resume" },
  "dsh": { "profile": { "bundles": ["...", "dsh-session-resume"] } }
}
```

缺 `dependencies` 解析不到包；缺 `dsh.profile.bundles` 不会被 loader 当成插件加载——
后者是早期 `/session-resume/list` 返回 404 的根因。

### 备用路径（没有 CLI 时；必须退出 DSH）

```bash
node install-offline.mjs --dry
node install-offline.mjs
```

DSH 运行时会锁住自己的 `node_modules`，拷贝会阻塞。脚本同样写两处 manifest，失败会整体回滚。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/session-resume/list` | 中断会话列表（不含已忽略的） |
| POST | `/session-resume/dismiss` | `{sessionId, interruptedAt}`，记一条忽略 |
| POST | `/session-resume/forget` | 撤销某条忽略 |

三条路由用 `exact` 注册；数据文件 `~/.dsh/session-resume.json`。

## 测试

```bash
node --test --test-timeout=15000 test/host.test.mjs test/routes.test.mjs test/client.test.mjs
node test/live-roundtrip.mjs
```

覆盖：已完成不报、未完成报（步骤/工具/任务/最后输出）、尾部读取不丢 `turn/start`、
路由 200/405/400/404、dismiss 落盘且重启后仍隐藏、空/坏日志不误报、
客户端只注册一个 overlay 且启动只发 GET。

## 从 GitHub 安装

```sh
dsh plugin --profile desktop add github:879745uhjun/dsh-session-resume
```

装好后刷新 Web 页面。
