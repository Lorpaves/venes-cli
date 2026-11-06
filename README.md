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

- **It stays local.** Your sessions never leave this Mac except over SSH to your own devices. The plugin opens no TCP ports, and events go over two Unix sockets in `~/.venes`, a `0700` directory.
- **It checks for updates.** The only network traffic is `claude plugin` fetching this repository, and new versions install by themselves. See [Updates](#updates).
- **It sees your sessions.** Hooks forward prompts, replies, tool inputs and results to the helper, which keeps the last 5000 events in memory and writes none of them to disk.
- **It can act for you.** Anyone who can log in to your Mac as you can approve tools and type into sessions through it. Use an SSH key, and consider turning password login off.
- **It never touches your Claude credentials.**

If the helper isn't running, the hooks do nothing and Claude Code behaves as usual.

## Updates

Every six hours the helper asks Claude Code for a new version of the plugin, using the same `claude plugin` commands you'd run yourself. When there is one, the helper restarts on it the next time nothing is in progress: no turn running, no open request and no held message. A session that has been silent for an hour doesn't count, so a crashed one can't hold an update back.

Open sessions keep working through the restart. They go on using their old hooks until their next start or `/reload-plugins`, and a connected app sees its connection drop and reconnects.

An update is new code running with the helper's access, which can approve tools and type into sessions. To review new versions yourself, turn this off:

```sh
~/.venes/venes auto-update off    # or on
~/.venes/venes update             # check now, whatever the setting
~/.venes/venes version
```

The helper also leaves updates alone when `DISABLE_UPDATES`, `DISABLE_AUTOUPDATER` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, unless `FORCE_AUTOUPDATE_PLUGINS` is too. If you update the plugin another way, the next session to start moves the helper to the new version.

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

The connection opens with `{"type":"hello","protocol":…,"version":…}`. Every request has an `id` and a `cmd`, and gets a `{"type":"result","id":…,"ok":true,…}` reply. On failure, `ok` is false and `error` holds `{code, message, details}`. Replies can arrive out of order, so match them by `id`.

| Command | Fields | Reply or effect |
|---|---|---|
| `ping` | | `protocol`, `version`, `quiet` (whether the helper could restart now) |
| `update` | | Checks for a new version now. `version`, `available` (null if there's none) |
| `sessions` | | `sessions`, `unattached` |
| `subscribe` | `since`, `bootId` (both optional) | Sends a `snapshot`, replays later events, then streams. `gap: true` means events were lost, so reload. |
| `history` | `sessionId`, `limit`, `before` | `items`, `before`, `hasMore`: a page of the conversation, from the transcript |
| `respond` | `requestId`, `decision`, `message`, `answers`, `always` | Answers a request |
| `send` | `sessionId`, `text`, `clientId`, `lane` | Types into the session, or holds the message. Replies with `queued`. Slash commands work too. |
| `cancel` | `sessionId`, `clientId` | Drops a held message. `cancelled` is false if it already went out. |
| `interrupt` | `sessionId` | Presses Esc |
| `taskOutput` | `sessionId`, `taskId` | `output` (null if there's none yet), `truncated` |

To reconnect, pass the last `seq` you saw as `since`, together with `bootId` from the snapshot. A helper restart, which an update causes, closes the connection and reports `gap: true`.

On `gap: true`, throw away everything built from earlier events, including any decoder state, and rebuild from the snapshot and `history`. Events were lost, so text from a new turn could otherwise be mistaken for a late piece of an old one.

### Sending during a turn

`lane` says when a message sent during a turn should be read:

| `lane` | Effect |
|---|---|
| `next`, or none | Typed now. Claude reads it at its next step, and the echo comes straight away. |
| `later` | Held by the helper until the turn ends, then typed. An idle session gets it at once. Only held messages can be cancelled, because a message in Claude Code's own queue can't be taken back on its own. |

Held messages go out in order, each once the session is idle and any compaction has finished, including after an interrupted turn. If one can't be delivered, a `send.failed` event says why, and the next one still goes. They live in the helper's memory, so a restart loses them.

`message.user` carries the `clientId` of the send it came from. A message typed in the terminal has none. Slash commands that Claude Code runs itself, such as `/compact`, fire no hook, so they never echo.

### History

Pass `before` from one reply to get the page before it. It counts items from the start of the transcript, so it stays valid while the session runs. Calls made by a subagent follow the call that started it, carry `parentToolUseId`, and don't count towards `limit`.

| `role` | Fields |
|---|---|
| `user`, `assistant` | `text` |
| `tool` | `toolUseId`, `name`, `input`, `result`, `isError`, `parentToolUseId` |
| `thinking` | `text`, `durationMs` |
| `turn_end` | `durationMs` |
| `compact` | `trigger`, `preTokens`, `postTokens` |
| `system` | `kind`: `interrupted` |

### Answering requests

`decision` is `allow` or `deny`. `message` is optional on a deny and tells Claude why.

| `request.kind` | What to show | To approve |
|---|---|---|
| `permission` | `toolName`, `input`, `permissionSuggestions` | `allow`, with `always: true` to not be asked again |
| `question` | `input.questions` | `allow` with `answers`, mapping each question's text to the chosen label (join multi-select labels with commas) |
| `plan` | `input.plan` | `allow` |

The same prompt is open in the terminal at the same time, and the first answer wins. `request_closed` means the terminal got there first.

`always` saves the rules in `permissionSuggestions`, usually to the project's `.claude/settings.local.json`. Show them before offering it. The list holds only rules: Claude Code also suggests switching the whole session to `acceptEdits`, which is more than "don't ask again for this", so those suggestions aren't passed on. If the list is empty, `always` is refused with `nothing_to_remember`.

### Events

Each one looks like `{"type":"event","event":{"seq":…,"at":…,"sessionId":…,"kind":…}}`.

| `kind` | Fields |
|---|---|
| `session.discovered` | `cwd` |
| `session.started` | `source`, `model`, `cwd` |
| `session.attached` | `pane` |
| `session.status` | `status`: `idle`, `running`, `waiting` or `ended` |
| `session.mode` | `permissionMode` |
| `session.ended` | `reason` (`replaced` after `/clear` or `/resume`) |
| `message.user` | `text`, `clientId` |
| `message.assistant.delta` | `messageId`, `index`, `text`, `final`, `agentId` |
| `message.thinking` | `text`, `durationMs` |
| `tool.start` | `toolUseId`, `name`, `input`, `agentId`, `parentToolUseId` |
| `tool.end` | `toolUseId`, `name`, `response`, `durationMs`, `isError`, `interrupted`, `parentToolUseId` |
| `request.opened` | `request` |
| `request.closed` | `requestId`, `decision`, `by` (`client`, `terminal`, `turn_end`, `session_end`) |
| `turn.end` | `lastMessage`, `backgroundTasks` (a count), `tasks` (those running) |
| `turn.interrupted`, `turn.error` | `error`, `details` |
| `agent.start`, `agent.stop` | `agentId`, `agentType`, `parentToolUseId` (on start) |
| `task.created`, `task.completed` | `taskId`, `subject`: items on Claude's task list |
| `background.task` | `task`: a background command, agent or workflow changed |
| `task.notification` | `taskId`, `status`, `summary`: a background task finished and Claude is reading about it |
| `notification` | `notificationType`, `message` |
| `compact.start` | `trigger` |
| `compact.end` | `trigger`, `preTokens`, `postTokens` |
| `compact.failed` | `trigger`, `message`: a compaction ended with nothing compacted. `message` is Claude Code's reason, such as `Not enough messages to compact.`, and is missing if the compaction went silent for thirty minutes. |
| `model.refusal` | `id`, `model`, `fallbackModel`, `scope`, `category`, `explanation`, `text`, `prompt` |
| `send.failed` | `clientId`, `code`, `message`: a held message couldn't be delivered |

Order text by `messageId` and `index`, because hooks run as separate processes and a delta can arrive after `turn.end`. `message.thinking` comes from the transcript, so it can arrive after the text it came before.

A `task` has `id`, `type` (`shell`, `subagent`, `workflow`, `monitor` and others), `status` (`running`, `completed`, `failed`, `killed`), `description`, `name`, `command`, `agentType`, `toolUseId`, `startedAt`, `finishedAt`, `summary`, `tokens`, `toolUses`, `durationMs` and `hasOutput`, as far as they're known. Snapshots list them under `sessions[].tasks`.

`tool.end.response` is the tool's own result. For Bash it can include `gitOperation`, such as `{"commit":{"sha":"d95e564","kind":"committed","branch":"main"}}`.

### Errors worth handling

| `code` | Meaning |
|---|---|
| `request_pending`, `dialog_open` | `send` was refused because Enter would have answered an open prompt |
| `request_closed` | That request was already answered |
| `no_pane` | The session isn't in tmux, so it can be watched and answered but not typed into |
| `not_running` | There's nothing to interrupt |
| `missing_answers` | `details.missing` lists the unanswered questions |
| `nothing_to_remember` | `always` was sent for a request with no rule to save |
| `unknown_task` | The helper hasn't seen that background task |

## Behaviour worth knowing

- **Permission mode is respected.** Prompts appear only when Claude Code would ask, so `bypassPermissions` shows no approvals. Questions and plans still appear.
- **Interrupts and terminal rejections fire no hook.** The helper finds them in the transcript, usually within half a second.
- **`turn.end` doesn't mean all work is finished.** Check `backgroundTasks`.
- **Long messages reach Claude as pasted text.** Past roughly 800 characters, or with many lines, Claude Code wraps a message in `<pasted_content>`. Claude still acts on it, and the helper shows the original text.
- **Most thinking has no text.** Claude Code stores the text of only some thinking blocks, so `message.thinking` often has just `durationMs`.

## Known gaps

- **`send` has a short race.** A prompt that opens in the last moment before Enter can still be answered by it. Two checks narrow this to a few milliseconds but can't remove it.
- **A crashed session can leave a request open.** If Claude Code is killed outright, no event closes it, and answering has no effect.
- **The transcript format is undocumented,** so a Claude Code update could stop interrupt detection and `history` working until the parser is updated.
- **Session state lives in memory.** After a helper restart, sessions reappear on their next event.
- **A release reaches everyone at once.** Pushing a new `version` to `main` installs it everywhere within about six hours. A push that doesn't change `version` reaches no one.
- **Background tasks can't be stopped from here.** Claude Code offers no way to stop one from outside, so the only route is asking Claude in a message.
- **Workflows report no progress.** A workflow appears as a task with a name and status, but its phases and agents aren't available to hooks.
- **Refusals are untested against the real thing.** `model.refusal` is built from the record format, without a real refusal to check it on.

## Development

```sh
npm test                                     # unit tests, no Claude needed
VENES_E2E_WS=/abs/workspace npm run e2e      # real Claude Code, in an isolated tmux
```

The end-to-end suite loads this folder with `--plugin-dir`, so nothing gets installed, and it uses a small amount of model usage. Set `VENES_E2E_SSH=1` to add a case that goes through real SSH to this Mac, which needs key login to `localhost`.

## License

[MIT](LICENSE)
