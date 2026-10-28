# 首版交互与 Git 范围如何收敛

Label: wayfinder:grilling
Type: grilling
Status: resolved
Assignee: codex
Parent: ../map.md
Blocked by:

## Question

如何定义项目、会话、子代理的关系及首版交互；文件浏览是否暂缓；Git 是否可运行，首版做到哪些操作；同项目并行会话采用共享目录还是 worktree？

## Comments

- 用户确认：规划后直接实现；项目、历史、流式、多会话并行/切换、查看子代理；手机 localhost。
- 用户补充：先验证 Git 支持，有则考虑实现；Termux 另有 Ubuntu。
- 已发起范围问题，建议文件浏览暂缓、基本 Git 状态/diff/手动提交、并行会话共享目录并提示。待回复或经过合理时间后将可逆实现选择注明为首版假设。

## Answer

用户确认：文件浏览暂不实现；Git 只读查看状态与 diff，写操作通过 agent 发起；多会话允许并行，共享项目工作目录，自动 worktree 隔离后续再做。保持手机 localhost 部署。项目包含多个会话，子代理通过父子关系与实际协议事件展示，可打开查看历史。
