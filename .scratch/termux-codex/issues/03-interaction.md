# 运行中引导、后续消息与快捷命令如何接入

Label: wayfinder:research
Type: research
Status: resolved
Assignee: protocol_research
Parent: ../map.md
Blocked by:

## Question

核实本机 app-server 的 turn/steer、follow-up、skills/list 和技能输入协议；哪些斜杠命令需要前端实现而不能当作 CLI 命令透传？确认最小正确实现及限制。

## Answer

已核实 steer 的 expectedTurnId、结构化技能输入和按 cwd 发现。原生 queue API 存在且 list 只读探测成功，但自动续跑语义未证实；首版用后端可控 follow-up 队列。slash 仅映射 /new、/stop、/compact、/skills、/status、/help。字段、行为边界与证据见[协议研究追加章节](../research/protocol.md)。
