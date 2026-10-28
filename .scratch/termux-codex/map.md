# Termux Codex Web 首版

Label: wayfinder:map
Status: complete

## Destination

明确方案后直接实现可在 Termux 启动、用本机手机浏览器访问 localhost 的 Codex Web 首版：项目、历史会话、流式会话、多会话并行/切换、子代理状态，以及可用的基本 Git 功能。

## Notes

- 用户明确将本次规划扩展为首版实现；规划决策落定后直接执行和验证。
- 使用 wayfinder、grilling、domain-modeling 和 OpenAI Docs；研究使用 research。
- 本地 Markdown tracker；子票据按编号排列，依赖写在 Blocked by，认领写在 Assignee 和 Status。
- Termux 原生优先；用户说明已有 Ubuntu，可作为兼容性备选。
- 仅监听 localhost，不部署外网。
- 尚未建立 Git 仓库，研究记录先保存在本地 research 目录，不为规划修改现有文件的版本历史。
- 首版已经实现并启动，使用 `CodexWeb` 打开；[实现规格](spec.md)、[验收记录](research/validation.md)、[使用说明](../../README.md)。

## Decisions so far

- [运行中引导、后续消息与快捷命令如何接入](issues/03-interaction.md)：显式 steer、后端后续消息队列、按 cwd 技能选择及六个 Web 快捷命令。

- [本机 Codex 接口能否支撑并行会话与子代理观测](issues/01-runtime.md)：原生 app-server 只读握手通过；采用 stdio 长连接并按线程路由，字段与验证范围见研究。

- [首版交互与 Git 范围如何收敛](issues/02-scope.md)：手机 localhost；会话共享目录并行；子代理可观察；Git 仅状态和 diff。

## Not yet specified

无阻塞首版实现的待决策事项。

## Out of scope

- 本次不部署公网、多用户服务或完整 Windows 桌面应用。
- 文件浏览、Git 写操作按钮、自动 worktree 隔离留待后续。
- Android 长期后台保活与真实手机的视觉微调不作为本次首版自动化验收条件。
