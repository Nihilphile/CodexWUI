# ChatGPT 对话内交互 UI：官方功能与公开工程路线

日期：2026-10-28。范围：只读研究；实际打开官方页面；没有修改产品代码，也没有登录 ChatGPT 复现。本文区分官方可确认事实、研究边界和工程判断。

## 先理解用户看到的体验

最接近“让回答直接变成可操作小网页”的官方功能是 **Visualizations**：在聊天中生成图表、地图、关系图、计算器、模拟器及交互式解释。模型可主动选择，也可用 `@Visualize` 指定。官方文档内有可直接操作的万花尺、波干涉、tokenizer 示例：调整滑杆、暂停动画、输入文字、逐步查看结果。它把“继续追问”和“直接操作结果”放在同一段工作流中。[官方 Visualizations 文档及交互示例](https://learn.chatgpt.com/docs/visualizations)

体验边界也很重要：生成可能超过一分钟；追加要求可能创建替代版本；结果通常是生成时的数据快照；账号与平台存在开放差异。文档明确 Codex CLI 和 IDE 扩展不渲染 Visualizations。这里不能进一步外推用户的自建 Codex Web 必然拥有或必然不可能实现同类体验。[可用性、继续修改和失败恢复说明](https://learn.chatgpt.com/docs/visualizations)

上面只确认产品体验。该页没有公开 Visualizations 的 iframe 实现、内容分发格式或第三方渲染 API。本轮没有找到可直接调用的“返回 ChatGPT 原生 Visualization”公开接口；这是调查结果，不是对所有内部接口的断言。

## 视觉相似的功能，不应合并为一个技术结论

| 场景 | 需要理解的区别 | 对当前目标的意义 |
| --- | --- | --- |
| 按当前问题生成交互式解释 | 内容和控件随本次任务产生 | 最应对齐的目标体验 |
| MCP 工具返回插件卡片 | 开发者预先提供 HTML 组件，工具数据填充组件 | 有公开 iframe 宿主协议可参考 |
| ChatKit 卡片、表单 | 按组件 schema 生成结构化 widget | 可参考交互模型；采用 SDK 涉及现有聊天栈的整合 |
| 单独打开网页预览或编辑工作区 | 需要离开回答正文进入另一工作面 | 本次目标应验证“直接在对话流里操作”是否成立 |

前两类可以用相似容器展示，但不能由“看见 iframe”推断它们拥有同一生成链路、同一持久化方式或同一官方 API。

## 已公开的 iframe 工程路径：MCP Apps

OpenAI 当前文档明确：ChatGPT 实现开放的 MCP Apps 标准；工具可以关联 HTML UI 资源，组件在 iframe 内运行，通过 `postMessage` 上的 JSON-RPC 与宿主通信。新实现首选标准接口，`window.openai` 仅用于标准未覆盖的扩展，旧 `openai/outputTemplate` 是兼容别名。[Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)

官方 quickstart 给出的完整链路是：

1. MCP 服务注册工具，并在**工具描述**上设置 `_meta.ui.resourceUri`，例如 `ui://widget/todo.html`。
2. 注册对应 UI resource，返回 HTML，MIME 为 `text/html;profile=mcp-app`，可用 `@modelcontextprotocol/ext-apps/server` 的 `RESOURCE_MIME_TYPE`。
3. 宿主加载组件；组件发送 `ui/initialize`，随后发送 `ui/notifications/initialized`。
4. 宿主发送 `ui/notifications/tool-result`；组件读取 `structuredContent` 更新画面。
5. 按钮可经 `tools/call` 调用工具，拿回新状态继续渲染。

这证明有“工具 → HTML 资源 → iframe → 双向桥接”的公开实现，不等于已有 Codex 客户端会自动处理这些字段。[MCP server and UI quickstart，包含前后端代码](https://developers.openai.com/plugins/build/app-quickstart)

若要让用户的操作进入后续推理，标准还提供 `ui/update-model-context`；后续聊天可用 `ui/message`。临时控件状态适合保留在组件内，重要数据由服务端保存；数据工具与渲染工具分开可减少无意义的 iframe 重挂载。[组件桥接、状态与渲染职责](https://developers.openai.com/plugins/build/chatgpt-ui)

宿主实现必须分别处理：模型与 UI 都可见的 `content`、`structuredContent`，以及只交给组件的 tool result `_meta`。工具描述的 `_meta.ui.resourceUri`、资源 contents 的 `_meta.ui.csp`、工具结果 `_meta` 是不同位置，不能混为一个对象。资源 CSP 支持 `connectDomains`、`resourceDomains`、可选 `frameDomains`，嵌套 iframe 默认禁止。[Plugin UI reference](https://developers.openai.com/plugins/reference)

## 可以参考的交互设计

官方插件 UI 的 inline 模式直接位于对话流，当前在模型后续回答之前。卡片可直接编辑、自动适配高度，复杂交互可展开到 fullscreen，输入框仍可继续对话。官方建议避免卡片内嵌套滚动、重复聊天输入框和过深导航。这些是插件 UI 的规范，不应强行当成所有生成式可视化的限制。[UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)

## ChatKit 是另一条公开路线

ChatKit 提供可嵌入聊天 UI，可用自己的服务端和 Python SDK 连接 agent 服务。Widgets 通过 JSON 组件树描述 Card、ListView、Button、Form 等；点击产生 action payload，经 `onAction` 等回调交给应用处理。[ChatKit overview](https://developers.openai.com/api/docs/guides/chatkit)、[ChatKit widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets)

自定义服务端的 `stream_widget` 可立即渲染或流式更新 widget。因此它适合“schema 约束的原生交互卡片”，不能从这份文档推断为“任意 HTML/JS 的通用执行容器”，也不能视为无需改造现有 Codex Web 数据流的开关。[Advanced integrations with ChatKit](https://developers.openai.com/api/docs/guides/custom-chatkit)

## 工程判断：供仓库集成方案使用

以下为本研究的设计判断，不是 OpenAI 已提供的 Codex 功能：

- 第一阶段应验证“同一条回答内出现一个生成式交互块”，例如可拖动参数的计算器或模拟器，保留解释文字、交互和后续修改的连续性。
- 可以先为生成 HTML 建立自己的受限渲染协议与独立 iframe 容器；如果明确要复用现有 MCP 组件，再建设 MCP Apps host。
- MCP Apps 是值得对齐的长期协议，但单纯加入 iframe 并不会自动解决生成物如何到达 UI、资源读取、消息定位、状态恢复、权限桥接。
- 无论采用哪条路线，都应区分不调用模型的本地交互、需要调用工具的业务操作、需要后续推理的上下文更新；不能每次拖动滑杆都触发新一轮模型回复。
- 验收时应实际观察首次渲染、连续拖动、窄屏高度、主题、刷新恢复、追加修改与失败降级，而不是仅验证 iframe 标签能显示。

后续仓库方案应结合实际 app-server 类型和当前消息渲染链路，说明哪些能力已存在、哪些需要新增。本文不作未经代码验证的仓库可行性承诺。
