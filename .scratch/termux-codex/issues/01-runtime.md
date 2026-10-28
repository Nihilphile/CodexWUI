# 本机 Codex 接口能否支撑并行会话与子代理观测

Label: wayfinder:research
Type: research
Status: resolved
Assignee: protocol_research
Parent: ../map.md
Blocked by:

## Question

本机 Codex 0.160.1 app-server 的线程历史、恢复、并行 turn、取消、审批、子代理事件及线程关系的准确协议是什么？Termux 原生连接是否可用，现有 SDK 与直接协议如何选择？列出可实现范围和需降级的能力。

## Answer

原生 app-server 握手、历史列表与元数据读取已实测通过。采用长期存活的原生后端 + app-server stdio；并行会话、流式项、审批和子代理父子关系按本机生成协议接入。完整推理与生命周期需实现后验证。详细依据：[协议研究](../research/protocol.md)。
