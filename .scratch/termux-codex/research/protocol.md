# Termux Codex app-server 协议研究

日期：2026-10-07。研究者：protocol_research。目的：确认本机原生运行路径与首版 UI 协议，不触发推理、不读取或导出凭据、不输出历史正文。

## 决定

首版由原生 Node 或 Python 后端维持一个长期运行的 `codex app-server --listen stdio://` 子进程，手机浏览器经 localhost HTTP/SSE 访问后端。无需先迁入 Ubuntu。采用 app-server 原生协议作为 Codex 接口；此决定来自所需的历史恢复、审批、双向事件和子代理关系均已在本机协议中存在。官方也将 app-server 定位为深度客户端集成入口。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

“Codex SDK”不能与通用 OpenAI Agents SDK 混为一谈。本次没有安装或验证 TS SDK 包，也不主张其一定无法实现这些能力。直接协议可减少首版依赖与协议适配层。将传输集中在独立 adapter 中，以便以后替换。

## 证据

- 本机安装版本对应生成：`codex app-server generate-ts --out /tmp/termux-codex-protocol --experimental`，退出码 0。以下准确字段主要引用这组本机类型，避免官网与安装版本漂移。
- 原生可执行路径：`/data/data/com.termux/files/usr/bin/{codex,node,python}`；Node v26.4.0、Python 3.14.6。
- 只读 stdio 探测：initialize 成功；thread/list limit 2 返回 2 条；thread/read includeTurns false 成功；sourceKinds subAgentThreadSpawn 列表查询合法，返回 0 条。
- 未进行 turn/start、模型推理、并行推理压测、完整审批或子代理生命周期实测。因此这几项属于协议支持，不能写成已完成端到端验证。

## 启动与分流

发送一行一个 JSON，RPC request 为 `{id,method,params}`；收到同 id 的 `{result}` 或 `{error}`。通知没有 id；服务端请求具有 method 和 id，必须与普通响应区分。

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"termux_codex_web","title":"Termux Codex Web","version":"0.1.0"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
{"method":"initialized","params":{}}
```

后端为所有 RPC 请求维护独立 id/promise，不要把整个连接锁定到一个 turn；事件依据 threadId、turnId、itemId 路由到各会话。浏览器切换会话不能杀死 app-server 或取消其他 turn。跨进程的其他 CLI 正在运行会话不等于本 app-server 已载入线程，`notLoaded` 也不能理解成全系统“没在运行”。

来源：[InitializeParams](/tmp/termux-codex-protocol/InitializeParams.ts)、[InitializeCapabilities](/tmp/termux-codex-protocol/InitializeCapabilities.ts)、[ServerNotification](/tmp/termux-codex-protocol/ServerNotification.ts)、[ServerRequest](/tmp/termux-codex-protocol/ServerRequest.ts)。

## 线程与历史

| 方法 | 建议参数与结果 |
| --- | --- |
| thread/start | `{cwd:absoluteProjectPath}`；返回 `{thread,model,approvalPolicy,sandbox,...}`。不要随意覆盖用户权限配置。 |
| thread/list | `{limit:50,modelProviders:[],sortKey:"updated_at"}`；返回 `{data,nextCursor,backwardsCursor}`。传入 nextCursor 继续分页。cwd 可传单路径或路径列表作精确匹配。 |
| thread/read | `{threadId,includeTurns:false}` -> `{thread}`。不会作为开始推理指令。 |
| thread/resume | `{threadId,excludeTurns:true,initialTurnsPage:{limit:20,sortDirection:"desc",itemsView:"full"}}`；返回 thread、initialTurnsPage 和配置。已经运行的线程会重新加入。 |
| thread/turns/list | `{threadId,limit:20,sortDirection:"desc",itemsView:"full",cursor?}` -> `{data:Turn[],nextCursor,backwardsCursor}`。UI 按时间重新排序。 |
| thread/items/list | `{threadId,turnId?,limit,cursor?,sortDirection:"asc"}` -> data 每项为 `{turnId,item,startedAtMs,completedAtMs}`。 |
| turn/start | `{threadId,input:[{type:"text",text:"用户输入",text_elements:[]}]}` -> `{turn}`。 |
| turn/interrupt | `{threadId,turnId}`；等待 turn/completed 的 interrupted 状态确认终止。 |

`Thread` 具有 id、cwd、name、preview、createdAt/updatedAt（秒）、model、modelProvider、reasoningEffort、projectId、parentThreadId、sessionId、source、agentNickname、agentRole、status、canAcceptDirectInput。分页型历史不应假定 read includeTurns true 总能给出完整历史；采用 turns/list，兼容老版本可回退 read。

sourceKinds 省略或空数组只列 interactive 来源；modelProviders 空数组才表示全部 provider。为展示子代理可另查 `{sourceKinds:["subAgentThreadSpawn"],ancestorThreadId:parentId}`；parentThreadId 是直接孩子过滤，与 ancestorThreadId 不能同时使用。主列表可仅展示主会话，把子代理归入父线程卡片。

`Thread.status.type` 为 notLoaded、idle、systemError、active；activeFlags 可能包括 waitingOnApproval、waitingOnUserInput。`Turn.status` 为 inProgress、completed、interrupted、failed；不能仅凭收到 completed 通知就显示“成功”。

来源：[Thread](/tmp/termux-codex-protocol/v2/Thread.ts)、[ThreadListParams](/tmp/termux-codex-protocol/v2/ThreadListParams.ts)、[ThreadResumeParams](/tmp/termux-codex-protocol/v2/ThreadResumeParams.ts)、[ThreadTurnsListParams](/tmp/termux-codex-protocol/v2/ThreadTurnsListParams.ts)、[ThreadItemsListParams](/tmp/termux-codex-protocol/v2/ThreadItemsListParams.ts)、[TurnStartParams](/tmp/termux-codex-protocol/v2/TurnStartParams.ts)、[TurnInterruptParams](/tmp/termux-codex-protocol/v2/TurnInterruptParams.ts)、[ThreadStatus](/tmp/termux-codex-protocol/v2/ThreadStatus.ts)、[TurnStatus](/tmp/termux-codex-protocol/v2/TurnStatus.ts)。

## 流式显示与恢复

- thread/started 携带 thread；thread/status/changed 携带 threadId/status。
- turn/started 和 turn/completed 携带 threadId/turn。
- item/started 和 item/completed 携带 threadId/turnId/item（完整对象）。按 item id 合并，完成对象替换增量缓存，避免重复文本。
- item/agentMessage/delta 与 item/commandExecution/outputDelta 携带 threadId/turnId/itemId/delta。前者追加文本，后者追加命令输出。
- item/reasoning/summaryTextDelta、item/plan/delta 可扩展；turn/diff/updated 给出 turn 对应改动。
- 重连后从后端缓存取得正在运行的状态，再以历史读取补齐。SSE 的连接中断不应被当作模型失败。

来源：[ServerNotification](/tmp/termux-codex-protocol/ServerNotification.ts)、[AgentMessageDeltaNotification](/tmp/termux-codex-protocol/v2/AgentMessageDeltaNotification.ts)、[CommandExecutionOutputDeltaNotification](/tmp/termux-codex-protocol/v2/CommandExecutionOutputDeltaNotification.ts)、[ThreadItem](/tmp/termux-codex-protocol/v2/ThreadItem.ts)。

## 审批与提问

服务端请求需存下原始 id、method、threadId、turnId，显示对应会话内的操作。不要自动同意，也不要把这些请求丢弃导致会话无限挂起。

| 请求 method | response result |
| --- | --- |
| item/commandExecution/requestApproval | `{decision:"accept"}`；常用 decline/cancel/acceptForSession。若 availableDecisions 存在应按其提供选项。 |
| item/fileChange/requestApproval | `{decision:"accept"}`，或 decline/cancel/acceptForSession。 |
| item/tool/requestUserInput | `{answers:{"question-id":{answers:["所选文字或自填内容"]}}}`。 |
| item/permissions/requestApproval | `{permissions: grantedSubset,scope:"turn"}`；拒绝用空 permissions，不可照搬 command 的 decision。 |
| mcpServer/elicitation/request | `{action:"accept"|"decline"|"cancel",content:formValueOrNull}`。 |

包裹为 `{id:originalRequestId,result:上述对象}`。serverRequest/resolved 的 `{threadId,requestId}` 表示清除 pending，包括用户尚未响应但请求已被服务端取消的情形。

userInput questions 含 id/header/question/isOther/isSecret/options；新字段 `isBlocking` 决定阻塞，autoResolutionMs 已被本机类型标为 deprecated。不要依旧以计时器猜测自动回答。

来源：[ServerRequest](/tmp/termux-codex-protocol/ServerRequest.ts)、[ToolRequestUserInputParams](/tmp/termux-codex-protocol/v2/ToolRequestUserInputParams.ts)、[ToolRequestUserInputResponse](/tmp/termux-codex-protocol/v2/ToolRequestUserInputResponse.ts)、[PermissionsRequestApprovalResponse](/tmp/termux-codex-protocol/v2/PermissionsRequestApprovalResponse.ts)、[ServerRequestResolvedNotification](/tmp/termux-codex-protocol/v2/ServerRequestResolvedNotification.ts)。

## 子代理

`ThreadItem.type="collabAgentToolCall"` 为联合类型成员，其字段为：

```text
id, tool, status, senderThreadId, receiverThreadIds[],
prompt|null, model|null, reasoningEffort|null,
agentsStates: { [threadId]: {status, message|null} }
```

tool 包含 spawnAgent/sendInput/resumeAgent/wait/closeAgent/sendMessage/followupTask/interruptAgent/listAgents。agentsStates.status 为 pendingInit/running/interrupted/completed/errored/shutdown/notFound。可做子代理状态卡与任务提示，并按 receiverThreadIds 获取线程历史。

Thread.parentThreadId 是首选父子关系。旧来源结构还可能为 `source.subAgent.thread_spawn.{parent_thread_id,depth,agent_path,agent_nickname,agent_role}`。`subAgentActivity` item 另有 kind/agentThreadId/agentPath，允许显示活动提示。

首版只观测真实派发出的代理；不假造执行状态。模型是否派发取决于任务与权限/配置。已废弃的 multiAgentMode 参数被忽略，不能用来强制开关；本机 TurnStartParams 注释指出 effort ultra 与主动多代理行为有关，但不应擅自提升用户默认推理级别。子代理线程 canAcceptDirectInput 为 false 时不显示可发送输入框。

来源：[ThreadItem](/tmp/termux-codex-protocol/v2/ThreadItem.ts)、[Thread](/tmp/termux-codex-protocol/v2/Thread.ts)、[SubAgentSource](/tmp/termux-codex-protocol/SubAgentSource.ts)、[CollabAgentTool](/tmp/termux-codex-protocol/v2/CollabAgentTool.ts)、[CollabAgentStatus](/tmp/termux-codex-protocol/v2/CollabAgentStatus.ts)、[TurnStartParams](/tmp/termux-codex-protocol/v2/TurnStartParams.ts)。

## 实现边界

原生 Node 与 Python 均具備 subprocess、HTTP 和流转发基础。已验证的是原生 Codex 协议，不是全部 shell 沙箱在 Android 上的可用性；继续继承已有配置并在 UI 展示真实错误。Ubuntu 留作未来执行环境适配，不要第一版同时处理两套路径和 Codex home。多会话同时修改同一工作目录会共享工作树；UI 应显示 cwd，后续再决定工作树隔离。

## 追加：运行中引导、后续消息、快捷命令与技能

对应决策：[运行中引导、后续消息与快捷命令如何接入](../issues/03-interaction.md)。

### Steer

精确请求为 `turn/steer {threadId,expectedTurnId,input,clientUserMessageId?}`，input 复用 UserInput 数组。返回 `{turnId}`。expectedTurnId 必填，必须等于当前正在运行的 turn.id。不存在运行 turn 或 id 不符时失败；前端应保留输入提示用户处理，不能无提示转换为新任务。不会产生新 turn/started，不能附带 model/cwd/sandboxPolicy/outputSchema 等 turn 级覆盖。review/compact 为不可 steer 的 turn 类别。

来源：[TurnSteerParams](/tmp/termux-codex-protocol/v2/TurnSteerParams.ts)、[TurnSteerResponse](/tmp/termux-codex-protocol/v2/TurnSteerResponse.ts)、[NonSteerableTurnKind](/tmp/termux-codex-protocol/v2/NonSteerableTurnKind.ts)、[官方 steer 说明](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)。

### Follow-up 与原生队列

本机并非没有队列 API，生成类型中明确有以下方法：

| 方法 | 参数 / 返回 |
| --- | --- |
| thread/queue/add | `{threadId,input,clientUserMessageId}`，其中 clientUserMessageId 必填；返回 `{queuedSubmission:{id,input,clientUserMessageId}}`。 |
| thread/queue/list | `{threadId,cursor?,limit?}`；返回 `{data:QueuedSubmission[],nextCursor}`。 |
| thread/queue/update | `{threadId,queuedSubmissionId,input}`。 |
| thread/queue/delete | `{threadId,queuedSubmissionId}`。 |
| thread/queue/start | `{threadId,queuedSubmissionId?}`；返回 `{turn}`。 |
| thread/queue/changed 通知 | 只有 `{threadId}`，应重新读取队列。 |

但本次官网没有找到 queue 文档，生成类型也没有解释自动续跑、持久化和失败重试语义。不能单凭 API 名字声称 add 自动开始下一轮。为了首版行为可控，可以采用后端 Web 队列，明确 UI 文案为“当前回复结束后发送”；当前 turn completed 时发送一次下一项，failed/interrupted 后暂停队列；重启恢复时避免自动重复发送。若采用原生队列，必须补充实际验证调度行为后才启用自动继续，不要同时维护两份队列导致重复任务。这里建议首版采用 Web 队列，后续替换原生队列时保留同一 UI 语义。

来源：[ThreadQueueAddParams](/tmp/termux-codex-protocol/v2/ThreadQueueAddParams.ts)、[ThreadQueueListParams](/tmp/termux-codex-protocol/v2/ThreadQueueListParams.ts)、[ThreadQueueStartParams](/tmp/termux-codex-protocol/v2/ThreadQueueStartParams.ts)、[ThreadQueueChangedNotification](/tmp/termux-codex-protocol/v2/ThreadQueueChangedNotification.ts)。

### Skills

`skills/list {cwds:[projectAbsolutePath],forceReload?:boolean}` -> `{data:[{cwd,skills,errors}]}`。每个 SkillMetadata 至少有 name/description/path/scope/enabled/pluginId，另可有 interface/shortDescription/dependencies。列表应按当前项目 cwd 读取，过滤或禁用 enabled false 项，错误单独展示，不能当作空列表静默吞掉。skills/changed 是失效通知，可重新取列表。

技能选择之后，保留文本中的 `$name`，同时追加 `{type:"skill",name:返回的name,path:返回的path}` 到 input。原生 UserInput 联合适用于 turn/start、turn/steer 和 queue/add；不要自行猜测 SKILL.md 路径。仅打字 `$name` 也能被模型发现，但结构化 skill item 能明确注入。名称冲突时保留选择结果中的路径。

来源：[SkillsListParams](/tmp/termux-codex-protocol/v2/SkillsListParams.ts)、[SkillsListResponse](/tmp/termux-codex-protocol/v2/SkillsListResponse.ts)、[SkillMetadata](/tmp/termux-codex-protocol/v2/SkillMetadata.ts)、[UserInput](/tmp/termux-codex-protocol/v2/UserInput.ts)、[官方技能调用说明](https://learn.chatgpt.com/docs/app-server#skills)。官网提到的 perCwdExtraUserRoots 不在本次生成的 SkillsListParams 内，首版不要依赖。

### 斜杠命令范围

斜杠命令是本 Web 客户端输入控制，必须前端解析并调用相应操作，不能直接将文本发到模型后声称 CLI 命令已执行。

| 首版命令 | 行为 |
| --- | --- |
| /new | 为当前项目调用 thread/start 并切换到新会话；不终止旧会话。 |
| /stop | 当前会话 turn/interrupt，需要当前 turnId。 |
| /compact | thread/compact/start `{threadId}`，通过常规 turn/item 事件显示过程；运行中禁用或提示等待。该操作可能进行模型调用，本次研究未执行。 |
| /skills | 打开按 cwd 获取的技能选择器。 |
| /status | 展示 thread/read 元数据与连接状态/当前 turn，不把只读元数据写入模型上下文。 |
| /help | 显示这个固定支持列表。 |

未知 slash 命令应提示不支持，允许用户明确作为普通文本发送。不要承诺 CLI 的 /model、/permissions、/resume、/apps 等全部原生界面命令在 Web 自动可用。

来源：[ThreadCompactStartParams](/tmp/termux-codex-protocol/v2/ThreadCompactStartParams.ts)、[ClientRequest](/tmp/termux-codex-protocol/ClientRequest.ts)，其他参数见前文已验证协议。

只读追加探测结果：skills/list 按本项目 cwd 返回 58 个技能、0 个错误；thread/queue/list 在一个历史 thread 上合法返回空队列。未发送 steer、queue/add、queue/start 或 compact，未触发推理。
