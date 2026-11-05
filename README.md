# Venes helper

A Claude Code plugin that turns a session's hooks and transcript into one structured event stream, so you can follow and answer it from another device: messages, status, permission prompts, questions and plans.

It's the Mac side of Venes, an iOS app that is still in development. Until the app ships, you can use everything from the command line.

Venes is an independent project, not made by or affiliated with Anthropic.

## Install

Requires Claude Code, Node.js 22 or later, and tmux to send input to a session. Tested on macOS.

```sh
curl -fsSL https://raw.githubusercontent.com/Lorpaves/venes-helper/main/install.sh | sh
```

Or at the prompt of a Claude Code session:

```
/plugin install venes --marketplace Lorpaves/venes-helper
```

Then start a new session, or run `/reload-plugins` in an open one. The helper starts by itself with the next session.

## Try it

Run Claude inside tmux, so the helper can type into it:

```sh
tmux new -A -s cc      # then run claude inside it
```

Watch from a second terminal:

```sh
~/.venes/venes watch                  # live events
~/.venes/venes sessions
~/.venes/venes send <session> "hello"
~/.venes/venes allow <request>
```

Run `~/.venes/venes` for every command. Session ids accept a unique prefix. The launcher appears after your first session with the plugin.

## What it does on your machine

- **It stays local.** The plugin makes no network calls and opens no TCP ports. Events go over two Unix sockets in `~/.venes`, a `0700` directory. Another device can reach them only by logging in over SSH.
- **It sees your sessions.** Hooks forward prompts, replies, tool inputs and results to the helper, which keeps the last 5000 events in memory and writes none of them to disk.
- **It can act for you.** Anyone who can log in to your Mac as you can approve tools and type into sessions through it. Use an SSH key, and consider turning password login off.
- **It never touches your Claude credentials.**

If the helper isn't running, the hooks do nothing and Claude Code behaves as usual.

## Uninstall

```sh
~/.venes/venes stop
claude plugin uninstall venes@venes
claude plugin marketplace remove venes
rm -rf ~/.venes
```

## How it works

```
Claude Code ──hook──▶ hook.sock ┐
                                ├─ helper ─▶ client.sock ◀─ ~/.venes/venes attach ◀─ SSH ◀─ app
transcript ───── polled ────────┘     │
                                      └─ tmux ─▶ sends text and Esc to the pane
```

## Protocol

A client runs `~/.venes/venes attach` over SSH and speaks newline-delimited JSON on stdin and stdout. SSH handles authentication. The launcher uses absolute paths because a command run over SSH gets a minimal PATH without node or tmux, and the plugin refreshes it at each session start because the plugin's path changes with every version. The helper starts on demand and outlives the connection.

Every request has an `id` and a `cmd`, and gets a `{"type":"result","id":…,"ok":true,…}` reply. On failure, `ok` is false and `error` holds `{code, message, details}`. Replies can arrive out of order, so match them by `id`.

| Command | Fields | Reply or effect |
|---|---|---|
| `ping` | | `protocol` |
| `sessions` | | `sessions`, `unattached` |
| `subscribe` | `since`, `bootId` (both optional) | Sends a `snapshot`, replays later events, then streams. `gap: true` means events were lost, so reload. |
| `history` | `sessionId`, `limit` | `items`, the conversation from the transcript |
| `respond` | `requestId`, `decision`, `message`, `answers` | Answers a request |
| `send` | `sessionId`, `text` | Types into the session. Slash commands work too. |
| `interrupt` | `sessionId` | Presses Esc |

To reconnect, pass the last `seq` you saw as `since`, together with `bootId` from the snapshot. A helper restart reports `gap: true`.

### Answering requests

`decision` is `allow` or `deny`. `message` is optional on a deny and tells Claude why.

| `request.kind` | What to show | To approve |
|---|---|---|
| `permission` | `toolName`, `input` | `allow` |
| `question` | `input.questions` | `allow` with `answers`, mapping each question's text to the chosen label (join multi-select labels with commas) |
| `plan` | `input.plan` | `allow` |

The same prompt is open in the terminal at the same time, and the first answer wins. `request_closed` means the terminal got there first.

### Events

Each one looks like `{"type":"event","event":{"seq":…,"at":…,"sessionId":…,"kind":…}}`.

| `kind` | Fields |
|---|---|
| `session.discovered`, `session.started`, `session.attached` | `source`, `model`, `pane` |
| `session.status` | `status`: `idle`, `running`, `waiting` or `ended` |
| `session.mode` | `permissionMode` |
| `session.ended` | `reason` (`replaced` after `/clear` or `/resume`) |
| `message.user` | `text` |
| `message.assistant.delta` | `messageId`, `index`, `text`, `final`, `agentId` |
| `tool.start` | `toolUseId`, `name`, `input`, `agentId` |
| `tool.end` | `toolUseId`, `name`, `response`, `durationMs`, `isError`, `interrupted` |
| `request.opened` | `request` |
| `request.closed` | `requestId`, `decision`, `by` (`client`, `terminal`, `turn_end`, `session_end`) |
| `turn.end` | `lastMessage`, `backgroundTasks` |
| `turn.interrupted`, `turn.error` | `error`, `details` |
| `agent.start`, `agent.stop` | `agentId`, `agentType` |
| `task.created`, `task.completed` | `taskId`, `subject` |
| `task.notification` | A background task finished and Claude is resuming |
| `notification` | `notificationType`, `message` |
| `compact.start`, `compact.end` | `trigger` |

Order text by `messageId` and `index`, because hooks run as separate processes and a delta can arrive after `turn.end`.

### Errors worth handling

| `code` | Meaning |
|---|---|
| `request_pending`, `dialog_open` | `send` was refused because Enter would have answered an open prompt |
| `request_closed` | That request was already answered |
| `no_pane` | The session isn't in tmux, so it can be watched and answered but not typed into |
| `not_running` | There's nothing to interrupt |
| `missing_answers` | `details.missing` lists the unanswered questions |

## Behaviour worth knowing

- **Permission mode is respected.** Prompts appear only when Claude Code would ask, so `bypassPermissions` shows no approvals. Questions and plans still appear.
- **Interrupts and terminal rejections fire no hook.** The helper finds them in the transcript, usually within half a second.
- **`turn.end` doesn't mean all work is finished.** Check `backgroundTasks`.
- **Long messages reach Claude as pasted text.** Past roughly 800 characters, or with many lines, Claude Code wraps a message in `<pasted_content>`. Claude still acts on it, and the helper shows the original text.

## Known gaps

- **`send` has a short race.** A prompt that opens in the last moment before Enter can still be answered by it. Two checks narrow this to a few milliseconds but can't remove it.
- **A crashed session can leave a request open.** If Claude Code is killed outright, no event closes it, and answering has no effect.
- **The transcript format is undocumented,** so a Claude Code update could stop interrupt detection and `history` working until the parser is updated.
- **Session state lives in memory.** After a helper restart, sessions reappear on their next event.

## Development

```sh
npm test                                     # unit tests, no Claude needed
VENES_E2E_WS=/abs/workspace npm run e2e      # real Claude Code, in an isolated tmux
```

The end-to-end suite loads this folder with `--plugin-dir`, so nothing gets installed, and it uses a small amount of model usage. Set `VENES_E2E_SSH=1` to add a case that goes through real SSH to this Mac, which needs key login to `localhost`.

## License

[MIT](LICENSE)
