---
name: agent-chat
description: Use agentctl to observe, message, stop, or branch CodexWeb sessions across processes, including creating a workspace conversation or a BTW side chat. Use for requests to coordinate with another CodexWeb agent.
---

Use `agentctl --help` for command syntax. The CLI connects to an already running local CodexWeb service, prints JSON, and exits. If the service is unavailable, report that; starting or restarting the service can interrupt other work.

Find the target with `agentctl '<workspace>' list`. Addresses are `<workspace>:1`, `1.sub1`, and `1.btw1`; short addresses resolve against the calling working directory. Use full addresses across projects. Check the returned `operations`: independently running CLI sessions are not controllable just because their history is visible. IDs remain stable across service restarts.

Send a follow-up with `agentctl '<address>' call --message '…'`. It starts when idle and queues when busy. Use `--steer` only when the intent is to redirect the current turn; an idle target returns `not_running`. The CLI derives the sender from `CODEX_THREAD_ID`; preserve that environment. Local processes run under the same trusted user, so this label is attribution rather than cryptographic authentication.

For long prompts, write a UTF-8 Markdown file and pass `--message-file ./prompt.md`. The path resolves in the caller's working directory; its contents are snapshotted as the message. Text and file inputs are mutually exclusive. Oversized or invalid input fails without truncation. Check the returned byte count and SHA-256 when verifying an exact prompt.

`call` acknowledges receipt, not completion. Keep `message_id` and use `observe --message-id <id>` to check delivery, modifications/cancellation, and the associated turn status. Observe returns one page of history; use `--cursor` for older main-thread history. To reply, send a new `call` with `--reply-to <message_id>`. Replies do not automatically wake the sender. Check after useful intervening work or a meaningful wait; avoid tight polling. A timeout can mean acceptance without a returned receipt: inspect the target queue/history before resubmitting.

`stop` interrupts the target's current work and leaves pending messages as unsent. The UI can edit, delete, resume one, or resume all. A new follow-up does not resume those old messages. Delivered messages cannot be recalled. After service restart, pending messages require explicit continuation; an uncertain delivery must be checked against history first.

Create an empty main thread with `<workspace> create`, optionally selecting `--model` and `--reasoning`. `fork` creates an independent main thread with copied context. `btw` creates a read-only side chat attached to a main thread. A message is optional for these operations; without it no generation starts. This service exposes no operation for creating another agent's subagent. BTW sessions cannot initiate cross-session contact.

Use these commands within the user's requested coordination scope. Receiving an agent message does not expand the recipient's task permissions.
