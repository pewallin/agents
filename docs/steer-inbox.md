# Steer inbox

A coordinator in AgentsNext corrects a working agent with `agents-app-control agent send
--mode steer`. Codex takes the message through its app-server (`turn/steer`). Claude Code and Pi
have no API that another process can call, so they take it through a steer inbox, which our own
hook (Claude Code) and extension (Pi) read at a safe point of the turn. Nothing is typed into the
terminal, and nothing is interrupted.

## Where

One directory per tmux pane, on one tmux server:

```
<AGENTS_TMP_DIR, else <agents home>/runtime/tmp>/steer/<tmux server pid>-pane-<n>/
```

Here `<agents home>` is `AGENTS_HOME`, or else `${AGENTS_SHARED_HOME:-~/.agents}/${AGENTS_PRODUCT_DIRNAME:-agents-app}`.
The hook takes the server pid from `$TMUX` (`socket,pid,session`) and the pane from `$TMUX_PANE`.

## Files

| File | Written by | Meaning |
| --- | --- | --- |
| `harness.json` | hook or extension | `{harness: "claude" or "pi", pid}`: the agent in this pane takes steered messages. The CLI uses the inbox only while that pid is alive and runs inside the target pane. |
| `<id>.msg` | CLI | `{id, text}`: a message waiting to be taken. |
| `<id>.taken` | hook or extension | The `.msg` renamed when it is taken. |
| `<id>.withdrawn` | CLI | The `.msg` renamed when the turn ended before it was taken. |
| `<id>.ack.json` | hook or extension | `{state, detail, at}`: `steered` when the agent has the message, `acknowledged` when it shows that it delivered it, `rejected` when it could not. |

Taking and withdrawing are the same rename of `<id>.msg`, so only one of them succeeds. A
message is never both delivered and withdrawn, and never delivered twice.

## Claude Code

`extensions/claude/steer-hook.sh` is the PostToolUse hook. After every tool call it writes
`harness.json` (if it is missing or names a dead pid) and takes every waiting message. It returns
the messages as `hookSpecificOutput.additionalContext`, which Claude Code adds before the model's
next step in the same turn. Claude Code shows nothing that would confirm more than that, so its
acks stay at `steered`. A turn that makes no further tool call ends before the hook runs, and the
CLI's supervisor then withdraws the message.

## Pi

The reporting extension (`extensions/pi/dustbot-reporting.ts`) writes `harness.json` at session
start. While a run is in progress, it checks the inbox every 500 ms. It takes each message and
calls `pi.sendUserMessage(text, { deliverAs: "steer" })`, which Pi delivers after the current
tool calls and before the next model call. It acks `steered` at once, and `acknowledged` when the
message arrives as a user message of the run (`message_start`).

## Other agents

Copilot's SDK has `session.send({ mode: "immediate" })`, but it is not wired yet. OpenCode, Kiro
and Hermes have no way in. The CLI refuses to steer them and prints the command that queues the
message instead.
