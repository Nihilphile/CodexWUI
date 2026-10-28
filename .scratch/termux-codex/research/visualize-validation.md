# Visualize 实现与验证

日期：2026-10-28。实现已完成，运行中的 Web 服务需要在本轮结束后 `/reload` 加载新代码。

## 最终实现

按后续用户决策采用工具入口，支持 HTML、Markdown（含 md 别名）和图片。工具参数可直接带文本，或引用项目内文件。工具通过每个主会话的本地 stdio MCP 服务提供，前端只显示内容卡片，隐藏这条工具调用的参数和返回 JSON。

- `server/visualizations.mjs`：参数验证、项目边界内读取、不可变内容快照、状态持久化、工具说明和 Web 投影。
- `server/visualize-mcp.mjs`：无需生产依赖的 MCP stdio 工具入口。
- `server/index.mjs`：新建/恢复线程时注入局部工具配置，提供元数据、图片、受限 HTML runtime 和状态接口。
- `public/visualizations.js`：逐条消息更新、内容卡片、iframe 生命周期、展开/收起、重跑及受限状态桥接。
- `public/visualization-runtime.js`：生成页面内的桥接 SDK。
- `public/app.js`：以工具消息位置展示内容，过滤每轮工具使用说明；BTW 快照过滤该说明。
- `README.md` 的“对话内展示”段落记录使用方法、大小限制和桥接接口。

它是 CodexWeb 的本地工具和渲染能力，不是 ChatGPT 原生 Visualization API，也未宣称完整 MCP Apps UI host 兼容。

## 自动检查

- `npm run check` 通过，新模块全部加入语法检查。
- `npm test`：104 项全部通过，包含原有回归和新增专项 / 整页测试。
- 专项覆盖三种格式、内容快照、状态恢复、大小限制、越界/符号链接、stdio MCP 协议、HTTP CSP、同源检查、工具注册、Web 投影裁剪、隐藏调用日志、增量消息更新与历史切换。
- 日志：`.scratch/visualize-check.log`、`.scratch/visualize-tests.log`。

## 真实 app-server 验证

使用本机 Codex app-server，模型响应由本地 HTTP 测试服务模拟，没有为探测调用远端模型。先创建没有 visualize 的持久线程并执行一轮，再恢复并注入 MCP 配置：

1. 工具启动状态为 ready，发现名为 visualize 的工具。
2. 模拟模型经 functions.exec 的 ALL_TOOLS 找到并调用工具；app-server 发出真实 mcpToolCall 完成事件，结果携带 artifactId。
3. 再次取消订阅、恢复后，工具仍可发布 Markdown。
4. 探测线程已归档，专用后端和临时生成物已清理。

本机执行模式把 MCP 工具放入 functions.exec 可访问的工具目录，初始模型可见工具描述不一定直接列出该工具。因此每轮附加一条被界面隐藏的简短说明，引导 agent 发现并使用它。

探测脚本和日志：`.scratch/visualize-probe.mjs`、`.scratch/visualize-probe.log`。

## 真实 Chromium 验证

复用本机已有 Chromium 151，在独立临时 profile 中以 420×820 视口运行测试 Web 服务：

- 自包含 HTML 的脚本正常执行，实际鼠标点击 iframe 内按钮后计数改变。
- 组件内访问父页面 DOM、localStorage、会话 API 请求均被阻止。
- 组件 JSON 参数写入后端；刷新并重新打开会话后，新实例恢复原参数。
- 后续解释文字通过 SSE 到达时，iframe 节点保持同一实例。
- 界面显示内容卡片，不显示 MCP 调用名称或 HTML 参数。
- 保存并检查移动视口截图：`.scratch/visualize-browser.png`。

脚本 `.scratch/visualize-browser.mjs` 通过 CDP 驱动浏览器，日志 `.scratch/visualize-browser.log` 含 PASS。Termux 当前处于 proot，会阻止嵌套 proot-distro；测试使用现有 rootfs 的 glibc loader 和 Chromium 资源，适配文件仅放在 `.scratch/visualize-chrome-runtime/`。检查结束后测试服务、浏览器和临时 profile 均已退出/清理。

此验证覆盖真实浏览器运行、桥接和响应策略；未声称已在用户当前 Android 浏览器里完成手工验收。
