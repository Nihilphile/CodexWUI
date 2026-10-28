# CodexWeb 对话内交互组件：理解与接入方案

日期：2026-10-28。状态：初始研究与建议；后续用户选择工具调用入口，并扩展到 Markdown 与图片，最终实现和验证见 [visualize-validation.md](visualize-validation.md)。配套资料：[官方功能与工程路线调查](chatgpt-inline-ui-official.md)。

## 要复现的体验

按用户“iframe 直接在对话流中渲染交互式 web 组件”的描述，暂以 ChatGPT **Visualizations** 为首要参照。用户尚未确认具体界面，因此保留它实际是 App 卡片的可能。官方 Visualizations 页面提供可操作示例，最适合双方对齐：[官方说明和演示](https://learn.chatgpt.com/docs/visualizations)。

目标交互应是：

> 用户问“轨道高度如何影响地面轨迹？” → 回答中出现解释和模拟器 → 用户拖动高度、倾角等参数，立即看到变化 → 接着问“加上重复轨迹的条件” → 同一聊天出现改进版本。

用户无需复制代码、手动启动预览服务器或切换到文件页面。组件是回答的一部分；拖动控件在浏览器里计算，追加设计要求才需要模型工作。第一版可保留旧版并生成新版，不承诺原位置热更新。

应分别理解三个层次：

| 层次 | 要解决的问题 | 本次结论 |
| --- | --- | --- |
| 生成 | 根据问题制作什么内容、控件和计算逻辑？ | Codex 已能写 HTML/CSS/JS，宿主需要告知输出约定 |
| 呈现 | 如何把生成物放进对应回答并维持运行？ | 需要增加独立组件容器、定位、状态和生命周期 |
| 对话协作 | 组件状态如何影响后续推理？ | 需要明确的状态桥接；模型不会自动看到 iframe 当前画面 |

iframe 提供运行边界，但完整体验还包含以上三层。单独打开网页属于现有文件预览工作流，不能替代对话内呈现。

## OpenAI 已公开什么

Visualizations 的产品能力已公开，但本次未找到直接返回 ChatGPT 原生 Visualization 的公共 API，也未找到其内部内容协议。不能把它与 MCP Apps 的内部实现画等号。[Visualizations](https://learn.chatgpt.com/docs/visualizations)

可参考的公开 iframe 路线是 **MCP Apps**：工具描述关联 HTML resource，宿主提供 iframe 与 JSON-RPC / postMessage 桥接。新实现优先标准字段和 `ui/*`，`window.openai` 属于可选扩展。我们在这条链路中的角色是实现宿主；仅安装组件库或接上 MCP 工具不会自动出现 UI。[Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)

ChatKit 则提供 JSON 组件树、widget 和 action 回调，适合结构化卡片和表单。采用它需要整合现有聊天层，单靠它无法证明任意生成 HTML/JS 能直接运行。对当前已有 app-server、SSE 和原生 JS 界面的项目，不建议为了一个交互块先替换整个聊天栈。[ChatKit widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets)

## 本仓库的接入条件

以下来自本地代码和已生成的本机协议 schema，属于静态检查，尚未用实际工具调用验证新功能：

| 已有能力或限制 | 证据 | 接入含义 |
| --- | --- | --- |
| 浏览器 → Node HTTP/SSE → Codex app-server | `server/index.mjs`、`server/codex.mjs` | 可增加 Web 渲染能力而继续使用现有 Codex 登录、会话和模型 |
| assistant、plan 使用 Markdown；MCP 结果只显示 JSON | `public/app.js:271`、`:294` | 需要新内容类型或专用声明识别；MCP UI 元数据目前没有渲染入口 |
| Markdown 禁用原始 HTML | `public/markdown.js:3` | 保留普通文本规则，为交互内容新增明确入口 |
| 消息区整体 `innerHTML` 重建 | `public/app.js:300` | 必须先改为稳定节点更新，否则文本 delta 会导致 iframe 重新加载 |
| 文件接口校验项目边界；HTML 按文本返回并禁止脚本 | `server/files.mjs`、`server/index.mjs:333` | 可复用受控文件读取，但需新增执行生成物的独立路由及策略 |
| Web 响应默认 `X-Frame-Options: DENY`、`frame-ancestors 'none'` | `server/index.mjs:272` | 新运行页面需专门配置嵌入策略，不能直接嵌入现有文件响应 |
| 单条 live item 超过 256 KiB 会裁剪，整体缓存有上限 | `server/state.mjs:28` | HTML 应单独存放；消息只携带小描述对象 |
| schema 已有 `mcpAppUi.resourceUri`、展示偏好、旧版 `mcpAppResourceUri` | `.scratch/btw-schema/v2/ThreadTurnsListResponse.json` | 将来实现 MCP Apps host 有明确的资源定位依据；字段存在不等于运行兼容性已验证 |
| schema 有 `mcpServer/resource/read` 和 `mcpServer/tool/call` | `.scratch/btw-schema/ClientRequest.json` | 可评估通过现有 app-server 取资源、代理组件操作；仍需验证账号、服务端及连接上下文 |
| 动态工具已用于 BTW，handler 目前仅分发给 BTW | `server/btw.mjs:88`、`server/index.mjs:152` | 动态工具可作为后续发布入口，但不能简单覆盖已有 handler |
| 后端会清理空闲工具进程 | `server/lifecycle.mjs`、`README.md` | 自包含 HTML 不依赖常驻 Vite 等服务，适合手机当前运行方式 |

官方 app-server 文档确认资源读取、MCP 工具调用及实验性动态工具接口。动态工具注册在 `thread/start`；本地 `ThreadResumeParams` 没有对应注册字段，不能承诺给既有历史线程直接补上工具。[App Server API overview / Dynamic tool calls](https://learn.chatgpt.com/docs/app-server)

## 建议路线：先交付生成式交互块，再扩展标准宿主

### 第一阶段：CodexWeb 自己的生成物协议

优先实现单文件 HTML/CSS/JS，支持 Canvas/SVG/普通 DOM，暂不要求 JSX 转译或 npm 安装。图表、计算器、教学模拟器都可覆盖；后续有明确需求再增加离线库或构建链。

最小闭环：

```text
用户提出问题或请求交互式解释
  ↓
Codex 写入项目中的自包含 HTML
  ↓
回答在指定位置输出一个小型、版本化的组件声明
  ↓
Node 校验所属线程、项目、路径、大小并保存不可变内容快照
  ↓
SSE / 历史接口提供 artifactId 和加载状态
  ↓
对应回答位置创建稳定 iframe，加载受限运行页面
  ↓
控件本地交互；需要继续讨论时显式带上参数摘要
```

可使用专用 fenced block 表达声明，例如 `codexweb-visualization` 内包含 `{version:1,path,title}`。这是**拟议的本地协议**，不是 OpenAI 私有标记，也不是完整 MCP Apps。后端只在完整 assistant 消息达到约定发布时机后处理，不能把普通 HTML 代码块、用户粘贴内容、工具日志或半段流式输出直接执行。发布前显示占位，发布后隐藏协议声明并呈现组件。

选择小声明的原因：现有历史会话即可使用；不依赖对旧线程补注册动态工具；不把完整 HTML 塞进消息缓存。后续可以将显式 `render_visualization` 工具作为另一个发布入口，两者调用同一个生成物服务。历史中从未发布的声明必须明确标为未发布，不在每次重读历史时自动执行或以当前文件冒充旧版本。

首次成功发布时，保存线程/轮次/消息位置、原路径、内容 hash、artifactId、版本和完整字节。重连、刷新与文件后续改动均按快照恢复。映射应在后端持久保存，不能只存在浏览器或有界 SSE 回放中。

### 共同的运行与状态能力

- 用 `(threadId, itemId, blockIndex, artifactVersion)` 定位组件。增量更新文本时保持已有 iframe 挂载；将旧节点移除再插回也可能重新加载，不能把“保留对象引用”当作生命周期验证完成。
- 将运行页面放在独立路由，配置该路由自己的 CSP/嵌入响应头及 `sandbox`；初始只给予脚本能力，不给予父页面同源访问。避免直接以 `srcdoc` 加一段脚本，因为父页 CSP 继承也需处理。主页面继续采用现有脚本策略。
- 默认使用自包含资源和本地计算。运行页面不能持有 Codex 凭据、任意文件读取或通用 HTTP/RPC 代理；后续每一种桥接能力都单独定义参数和作用域。
- 第一版桥接只处理 ready、受限高度更新、主题、JSON 状态保存/恢复和“把当前参数带入输入框”。校验消息来源窗口、实例标识、版本、负载大小和允许方法；opaque origin 下不能只靠 `event.origin` 判定合法消息。
- 拖滑块不产生模型调用。状态快照可由生成页面按统一 SDK 上报；用户继续讨论时把可见的参数摘要作为数据上下文附加到下一轮。未上报状态的任意 HTML 只能恢复初始态，不能宣称模型已知道其状态。
- 页面刷新后恢复已保存的 JSON 参数；切换会话时可以卸载实例并在返回时恢复。动画进度和任意内存对象不承诺完整恢复。旧版/新版默认各自保留，版本替换必须显式。
- 手机上默认嵌入聊天宽度，提供展开/收起与重新运行；高度变化不能抢走用户阅读位置。设置活动实例和状态大小上限，隐藏时暂停协作式动画。浏览器执行资源与 Node 进程预算不是同一限制，应在真机测量。
- 文件缺失、声明错误、资源过大或脚本失败时，组件位置显示原因和源文件入口，正文继续可读。发布后原文件删除不应破坏已保存的快照。

以上是工程设计要求。iframe、CSP 和消息桥的实际边界必须用真实浏览器验证；仅通过 jsdom 不能宣称完成隔离、布局或加载状态验证。

### 第二阶段：MCP Apps 兼容入口

在共同运行层稳定后，再接入现有 MCP 组件：

1. 识别 `mcpToolCall.mcpAppUi.resourceUri`；兼容旧历史中的 `mcpAppResourceUri`，保留原始工具 JSON 作为降级入口。
2. 结合可信的调用来源、server、threadId、appContext 和 originCallId，通过 app-server 的 `mcpServer/resource/read` 读取资源；具体字段组合按本机 schema 和实际响应验证，不能让组件自由选择服务或账号。
3. 按标准初始化、传递 tool-input / tool-result、处理大小变化和宿主能力协商；没有支持的能力不要虚报。
4. 将 `tools/call` 映射到限定的工具入口，核实工具可见性、原调用来源与审批流程。现有客户端尚未实现完整 MCP elicitation，写操作组件不能绕过这层直接接通。
5. 区分只用于 UI 的 `_meta`、结构化结果和模型上下文。组件 UI 状态不自动等于模型可见数据。

这部分应按 MCP Apps 正式规范另立兼容验收，不能把第一阶段自定义桥接标成完整标准支持。[OpenAI 的标准接口对照](https://developers.openai.com/plugins/build/chatgpt-ui)、[官方最小端到端示例](https://developers.openai.com/plugins/build/app-quickstart)

## 可实施的改动边界

以下是计划新增或调整的职责，不表示文件已经创建：

| 模块 | 建议职责 |
| --- | --- |
| `server/visualizations.mjs`（拟新增） | 声明解析、内容发布/快照、持久映射和状态大小限制 |
| `server/index.mjs` | 在完成事件处发布，提供受控加载/状态接口，将小型描述加入历史与 SSE |
| `public/app.js` | 从整体消息替换改为稳定节点更新；保持原消息顺序、滚动与工具卡片状态 |
| `public/visualizations.js`（拟新增） | 实例管理、桥接、主题、展开与状态恢复 |
| 独立 runtime 路由 | 与普通文件预览区分的执行策略、响应头和加载错误处理 |
| `public/markdown.js` | 普通 Markdown 保持原规则；交互声明由专用组件解析层处理 |
| 后续 MCP 适配器 | 发现资源、读取资源、标准协议映射与能力协商 |

无需为了研究或第一阶段引入 React、ChatKit、远程托管服务或修改 Codex 模型实现。

## 验收：重点验证它是否像回答的一部分

先用现有 `ground-track.html` 做输入样本，在隔离运行环境中检查其依赖和降级。它目前尝试访问 localStorage，有异常捕获，但在 opaque origin 中仍需实测；这只是适合的样本，不代表已确认能原样兼容。再让 Codex 按新约定生成一个简单计算器，验证实际生成链路。

验收场景：

1. 用户提出问题后，解释文字与交互块在同一回答位置出现，无手动启动步骤。
2. 连续拖动参数时，后续文字 delta、工具事件、内存采样等更新不会重载 iframe。
3. 切换会话、恢复网络、刷新页面或重启 Web 服务后，恢复已发布的同一内容版本及已保存参数。
4. 追加“增加一个比较曲线”生成新版；旧消息仍是旧版，文件改写不会偷偷改变它。
5. “根据我当前参数解释”确实携带已确认的参数摘要；未同步的 UI 状态不被声称已知。
6. 手机窄屏、软键盘及展开/收起可用；动画暂停、文字说明和错误降级可用。
7. 真实浏览器验证父页面 DOM、API、存储访问边界，以及伪造桥接、超大状态和加载失败；使用受控样本验证隔离策略。
8. 自动回归关注消息节点稳定、协议解析与历史恢复；CSP、iframe 状态与布局用真实浏览器检查。原有 Markdown/文件预览行为继续通过现有检查。

第一阶段验收通过，才能说 CodexWeb 已拥有类似的对话内生成式交互体验；完成第二阶段兼容测试后，才能另外声明支持已验证范围内的 MCP Apps。
