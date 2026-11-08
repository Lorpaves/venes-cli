# Venes helper

A Claude Code plugin that turns a session's hooks and transcript into one structured event stream, so you can follow and answer it from another device: messages, status, permission prompts, questions and plans.

It's the Mac side of Venes, an iOS app that is still in development. Until the app ships, you can use everything from the command line.

Venes is an independent project, not made by or affiliated with Anthropic.

## Install

Requires Claude Code, Node.js 22 or later, and either [Rex](https://www.superlogical.com/rex) or tmux to send input to a session. Tested on macOS.

```sh
curl -fsSL https://raw.githubusercontent.com/Lorpaves/venes-helper/main/install.sh | sh
```

Or at the prompt of a Claude Code session:

```
/plugin install venes --marketplace Lorpaves/venes-helper
```

Then start a new session, or run `/reload-plugins` in an open one. The helper starts by itself with the next session.

## Try it

Run Claude in Rex, or inside tmux, so the helper can type into it:

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

## Pairing the app

Run this and scan the code in the app:

```sh
~/.venes/venes pair
```

The phone reaches this Mac in one of two ways, and `pair` picks for you:

- **Through Rex,** if Tailscale is on in [Rex](https://www.superlogical.com/rex). The phone has to be on your tailnet as the account Rex uses: the app signs in to Tailscale itself, for each Mac, or uses the Tailscale app. Nothing else is needed, not even Remote Login.
- **Over SSH** otherwise. Turn on Remote Login first, in System Settings > General > Sharing. `pair --ssh` picks this even with Rex.

Through Rex, the code holds this Mac's name, its address on your tailnet, and the Tailscale account Rex is signed in with, and no credential: Rex asks Tailscale who's calling and lets in only the account that signed in. To stop a phone reaching this Mac, sign it out of that account or turn Tailscale off in Rex.

Over SSH, the code holds this Mac's name, address and host key, and a one-time key. The address is this Mac's on your tailnet while its Tailscale app is on, so the phone reaches it from anywhere, signed in to Tailscale in the app as any account the tailnet lets reach it. With Tailscale off, it's the Mac's name on the local network. That key is added to `~/.ssh/authorized_keys` and can do nothing but hand over the app's own public key. It works once, and it's removed after five minutes either way. The app's private key never leaves the phone, and nothing asks for your password. To unpair a phone, delete its `venes-phone` line from `~/.ssh/authorized_keys`.

## What it does on your machine

- **It stays local.** Your sessions never leave this Mac except over SSH or Rex to your own devices. The plugin opens no TCP ports, and events go over two Unix sockets in `~/.venes`, a `0700` directory.
- **It checks for updates.** `claude plugin` fetches this repository, and new versions install by themselves. See [Updates](#updates).
- **It downloads one thing.** The first time it starts, it runs `npm install` for Anthropic's [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), into `~/.venes/sdk`, to list your stored sessions. It leaves out the SDK's Claude Code binary, runs no install scripts, and needs no account: the SDK only reads files on this Mac here. Without it, the app still shows what's running.
- **It sees your sessions.** Hooks forward prompts, replies, tool inputs and results to the helper, which keeps the last 5000 events in memory and writes none of them to disk. So that a restart doesn't lose track of them, it keeps a list of open sessions in `~/.venes/sessions.json`: their ids, folders and tmux panes, with no conversation text.
- **It can act for you.** Anyone who can log in to your Mac as you, or get into your Rex, can approve tools, type into sessions and resume stored sessions through it. Use an SSH key, and consider turning password login off.
- **It keeps what you attach.** A picture, video or file sent with a message from the app is saved in your Downloads folder, where Claude can read it and you can find it. They stay there when you delete the session. What the helper knows of them is in `~/.venes/uploads`, until the session is deleted, or for 30 days.
- **It stands in as your status line.** A plugin can't set Claude Code's status line, and what Claude Code tells a status line is the only place a session's limits are, so the helper sets `statusLine` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) to `~/.venes/venes statusline`. That keeps what Claude Code sends in `~/.venes/status`, a file a session for a week, and runs the status line you had with the same input, so your terminal shows what it did. The one you had is kept in `~/.venes/statusline.json`. With none before, it shows nothing, and Claude Code then leaves out the key hints it shows under the box when there's no status line. `~/.venes/venes statusline off` puts yours back and keeps it there; `statusline on` stands in again. A settings file that isn't plain JSON is left alone.
- **It can let your phone in over SSH.** The app asks to, to send files over SSH, and the helper adds the phone's own public key to `~/.ssh/authorized_keys`, as pairing over SSH does. That only works while Remote Login is on.
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
~/.venes/venes statusline off
~/.venes/venes stop
claude plugin uninstall venes@venes
claude plugin marketplace remove venes
rm -rf ~/.venes
```

## How it works

```
Claude Code ──hook──▶ hook.sock ┐
                                ├─ helper ─▶ client.sock ◀─ ~/.venes/venes attach ◀─ SSH or Rex ◀─ app
transcript ───── polled ────────┘     │
                                      └─ Rex or tmux ─▶ sends text and keys to the terminal
```

## Protocol

A client runs `~/.venes/venes attach` over SSH, or [through Rex](#connecting-through-rex), and speaks newline-delimited JSON on stdin and stdout. SSH handles authentication. The launcher uses absolute paths because a command run over SSH gets a minimal PATH without node or tmux, and the plugin refreshes it at each session start because the plugin's path changes with every version. The helper starts on demand and outlives the connection.

The connection opens with `{"type":"hello","protocol":…,"version":…}`. Every request has an `id` and a `cmd`, and gets a `{"type":"result","id":…,"ok":true,…}` reply. On failure, `ok` is false and `error` holds `{code, message, details}`. Replies can arrive out of order, so match them by `id`.

| Command | Fields | Reply or effect |
|---|---|---|
| `ping` | | `protocol`, `version`, `quiet` (whether the helper could restart now), and `tailscaleAccount` while Tailscale is on in Rex: the account Rex is signed in with, which a phone reaches this Mac as through Rex |
| `update` | | Checks for a new version now. `version`, `available` (null if there's none) |
| `sessions` | | `sessions`, `unattached` |
| `library` | `limit`, `offset` | Every session Claude Code has stored, and what's running. See [The library](#the-library). |
| `capabilities` | `sessionId` | `commands` and `models` on offer in the session's folder. See [Commands and models](#commands-and-models). |
| `mentions` | `sessionId`, `query`, `limit` | `items`: what an `@` followed by `query` can name for the session, as Claude Code's own `@` offers it: each with its `path` and `kind`, `file` or `dir`, a folder's path ending in `/`. A `query` that starts like a path (`./`, `../`, `~/`, `/`, or just `~`, `.` or `..`) lists the folder it points into, folders first, hidden entries left out, written the way it was typed, as in `../helper/`. Anything else is looked for among the project's files and the folders above them, best match first, scored as Claude Code scores them: in a git repository every file git has, from the session's folder, then new ones unless ignored; elsewhere what ripgrep finds. With nothing typed, or just `.` or `./`, it's what's in the session's folder. A leading `@` in `query` is ignored. As many as Claude Code shows, 15, or 10 of a folder, and fewer if `limit` asks |
| `configure` | `sessionId`, `model`, `effort` (either or both) | Changes what the session runs on. See [Commands and models](#commands-and-models). |
| `delete` | `sessionId` | Deletes the session from this Mac for good. See [Deleting a session](#deleting-a-session). |
| `subscribe` | `since`, `bootId` (both optional) | Sends a `snapshot`, replays later events, then streams. `gap: true` means events were lost, so reload. |
| `join` | `sessionId`, `limit` | Everything needed to open a session. See [Joining a session](#joining-a-session). |
| `history` | `sessionId`, `limit`, `before` | `items`, `before`, `hasMore`: a page of the conversation, from the transcript. It starts where a turn does, so it can hold more than `limit` |
| `image` | `sessionId`, `imageId` | `mediaType`, `data` in base64: an image from the conversation. See [Images](#images) |
| `avatar` | | `mediaType`, `data` in base64: the picture this Mac's account shows at login, at most 256 pixels on its long side. Empty if it has none |
| `respond` | `requestId`, `decision`, `message`, `answers`, `always` | Answers a request |
| `upload` | `sessionId`, `name`, `mediaType`, `data` in base64 | Keeps a picture or file for a message. `uploadId`, `name`, `mediaType`, `size`, `kind`. See [Attachments](#attachments) |
| `file` | `sessionId`, `uploadId` | `name`, `mediaType`, `data` in base64: a file a message had attached, while the Mac still keeps it |
| `ssh` | `publicKey` | Lets the client's key in over SSH, for files: `user`, `port`, `hostKey`, `hosts`. See [Over SSH](#over-ssh) |
| `statusLine` | `sessionId` | `status`: what Claude Code last told the session's status line, as the helper stands in for it, or `null` before it has. `model` and `effort` as Claude Code names them, `project` the folder it started in, `repo` as `owner/name`, `branch` checked out, `context` with its `percent` used, the input tokens `used` and the window's `size`, `fiveHour` and `sevenDay` with their `percent` used and `resetsAt` in Unix seconds, `cache` with its `percent` of input read from it, whether it's `warm` and when it `expiresAt`, `cost` in dollars, and `updatedAt`. Limits are there with a Claude plan, and an API has none, so its `cost` is what to show. A limit that has reset since is `0` with no `resetsAt`, and a session with no reply yet has the account's last limits. Each field is left out when Claude Code didn't say |
| `send` | `sessionId`, `text`, `clientId`, `lane`, `attachments`, `pages` | Types into the session, or holds the message. Replies with `queued`. Slash commands work too. One that opens a page leaves it open for a client that says it shows `pages`, and the reply has `page: true`; for any other, the page is closed. A session that isn't running is resumed. See [The library](#the-library) and [Attachments](#attachments). |
| `page` | `sessionId` | `page`: what's open in the session's terminal, like `/mcp`'s servers, as `lines` of runs from the edge it opened under to its footer, each run with its `text`, and `color` and `background` as `#rrggbb` and `bold`, `dim`, `italic`, `underline`, `strikethrough` and `inverse` when set. Colours by number are xterm's. `null` when nothing is open |
| `pageKey` | `sessionId`, `key` | Presses `Up`, `Down`, `Left`, `Right`, `Enter`, `Escape`, `Tab`, `BTab`, `Space` or `BSpace` on what's open. With nothing open, it's refused with `no_page`, as Esc would interrupt the turn and Enter would send what's in the box |
| `pageText` | `sessionId`, `text` | Types into what's open, like a page's search box. `no_page` with nothing open |
| `pageClose` | `sessionId` | Closes what's open, as Esc does, a press at a time while its footer says so |
| `cancel` | `sessionId`, `clientId` | Drops a held message. `cancelled` is false if it already went out. |
| `interrupt` | `sessionId` | Presses Esc |
| `taskOutput` | `sessionId`, `taskId` | `output` (null if there's none yet), `truncated` |

To reconnect, pass the last `seq` you saw as `since`, together with `bootId` from the snapshot. A helper restart, which an update causes, closes the connection and reports `gap: true`.

On `gap: true`, throw away everything built from earlier events, including any decoder state, and rebuild from the snapshot and `join`. Events were lost, so text from a new turn could otherwise be mistaken for a late piece of an old one.

### Joining a session

`join` is how to open a session, including one in the middle of a turn. Show `items` as finished history, then play `turn` as if its events were arriving now, so that a call still running shows as running and text half written can carry on.

| Field | Contents |
|---|---|
| `items`, `before`, `hasMore` | A page of `history` that stops where the current turn begins |
| `turn` | This session's events since that turn began. Empty when no turn is going. |
| `seq` | The last event this reply accounts for |
| `sessions`, `requests` | This session's current state, in the form a snapshot has it |

Every event up to `seq` is covered by the reply, and every later one follows it on the wire. So drop what arrives for a session while its `join` is on its way, and apply what comes after. A turn that ended within the last two seconds counts as current, because the transcript can lag behind `turn.end`. A turn older than the event log comes back with an empty `turn`, and shows as history.

### The library

`library` lists sessions the helper may never have heard from, newest first. It comes from `claude agents --json` for what's running, and the Agent SDK's `listSessions()` for what's stored. Pass `offset` from one reply to get the next page.

| Field | Contents |
|---|---|
| `items` | `id`, `title`, `cwd`, `lastActiveAt`, `startedAt`, and `status`: `running`, `waiting`, `idle`, or null if it isn't running. What's running comes first, on the first page, wherever it would otherwise have been. |
| `offset`, `hasMore` | Where the next page starts, and whether there is one |

`join` and `history` work on any of these. For a session the helper doesn't know, `turn` is empty and the session's `status` is `ended` unless it's running somewhere. `claude agents` calls a session busy for as long as a background shell runs, so `join` checks the transcript and says `idle` once the turn is over, though `library` still says `running`.

`send` to a session that isn't running runs `claude --resume` in the session's folder, with the message as its first prompt: in a window labelled `venes-<id>` of a Rex session called `Venes` if Rex is on this Mac, and otherwise in a tmux session named `venes-<id>`. The helper keeps that Rex session's id in `~/.venes/rex-session` and gives it its name back, because Rex can have a Claude Code in it rename it after its task. The reply has `resumed: true` once Claude has the message, and from then on it's a session like any other, with the same id. It keeps the permission mode [Claude Code gives a resumed session](https://code.claude.com/docs/en/sessions#permission-mode-on-resume). A session running outside both is refused with `no_pane`, because resuming it would put two processes on one transcript.

### Commands and models

`capabilities` comes from the Agent SDK's `initializationResult()`, in a session that's never given anything to do. It's read once per folder and kept for five minutes, so a new skill can take that long to show up.

| Field | Contents |
|---|---|
| `commands` | `name`, `description`, `argumentHint` |
| `models` | `value`, `displayName`, `description`, `resolvedModel`, `effortLevels`. Pass `value` to `configure`. `resolvedModel` is the name a session reports. `effortLevels` is empty for a model with no effort setting. |

`configure` changes a running session for that session alone, the way a person would: it opens the model picker with Option+P, moves to the model and the effort level, and presses `s`, which [leaves the defaults for new sessions unchanged](https://code.claude.com/docs/en/model-config#setting-your-model). It takes effect at once, even during a turn, and anything being typed at the terminal stays where it is. Each key is checked on the screen before the next, and if the picker isn't as expected it's closed with nothing changed, and `configure` fails with `picker_failed`. `model` has to be one that `capabilities` lists.

A command that opens a page in the terminal, like `/config` or `/mcp`, is left open for a client that sends `pages: true`, which can show it with `page` and work it with `pageKey` and `pageText`, and close it with `pageClose`; until then, a message is refused with `dialog_open`, because it would act on the page. For any other client the helper closes the page again, and `send` fails with `terminal_only`. To see whether one does, the reply to any slash command comes about a second and a half later. A `/model` or `/effort` with a value, sent as a message, is a `configure`. What a local command prints isn't sent to clients.

A session that isn't running keeps the choice for its next `send`, which passes it as `--model` and `--effort`, so it stays with that session too. A session running outside Rex and tmux is refused with `no_pane`.

A session reports its model and effort through `session.model`, `session.effort`, and `model` and `effort` in `sessions`. Effort is only known from the first hook that carries it, usually the end of the first turn. For a session that isn't running, `join` gives the model that last replied.

### Rex

A session running in Rex needs no tmux. Its hooks carry `REX_BLOCK`, `REX_SESSION` and `REX_SERVER`, and `pane` in `sessions` is then a block id, which is all a client has to know: everything above works the same. The helper uses the `rex` command, and finds it in Rex's install folder when it was started over SSH. It reaches the Mac's own Rex server, so none of this needs Rex's network access turned on.

A session started before this version was installed has none of those variables, so it can't be typed into until it's restarted.

### Connecting through Rex

A client on the same tailnet can reach the helper with no SSH. It runs `attach --pipe` in a terminal of Rex's that no window shows, and uses that terminal's input and output as the pipe. `GET /llms.txt` on a Rex server documents the calls:

1. Open `/api/control`, and find or create the session labelled `Venes`, the one the helper starts sessions in. `session.attach` to it. Its label can change, because Rex can have Claude Code name the session it's in, so keep its id and look for that first, as the helper does.
2. `session.new_block` with `{"shell":"none","login":false,"command":["/bin/bash","-c","read -t 60 _ && ~/.venes/venes attach --pipe"]}`. The `read` holds the helper back until the client is watching, because Rex closes a terminal the moment its program exits, and a client needs to see why it did. It also ends a terminal nobody came for. `login` has to be off, because `login` hides the status a program exits with.
3. `data.connect`, and open `/api/data`. Skip what comes before the first `resize`, which is a picture of the screen.
4. Write a newline with `com.superlogical.terminal.write`, and the helper starts. After that, what goes in with `terminal.write` is its stdin, and what comes out is its stdout, with each line ending in `\r\n` and Rex's own messages to skip. A `child_exited` of 127 means there's no helper.
5. `block.close` when you're done. A client that goes without it leaves `attach --pipe` to exit by itself after a minute of silence, so `ping` more often than that.

### Deleting a session

`delete` removes a session's transcript and its subagents' through the Agent SDK's `deleteSession()`, so it's gone from `claude --resume` too. It can't be undone. A session that's running, in tmux or not, gets SIGTERM first and has to be gone from `claude agents` within five seconds, or `delete` fails with `session_running` and nothing is deleted. Its pane goes back to its shell, and a `venes-<id>` window or tmux session closes. Every client hears `session.deleted`.

Files the session changed stay as they are, and so does anything else Claude Code keeps under the session's id, such as file history.

### Sending during a turn

`lane` says when a message sent during a turn should be read:

| `lane` | Effect |
|---|---|
| `next`, or none | Typed now, or as soon as an open request is answered. Claude Code queues it, and Claude reads it when the tool calls running now finish, in the same turn. With none left to finish, it starts the next turn. |
| `later` | Held by the helper until the turn ends, then typed. An idle session gets it at once. Only held messages can be cancelled, because a message in Claude Code's own queue can't be taken back on its own. |

Held messages go out in order, each once the session is idle and any compaction has finished, including after an interrupted turn. If one can't be delivered, a `send.failed` event says why, and the next one still goes. They live in the helper's memory, so a restart loses them.

`message.user` carries the `clientId` of the send it came from. A message typed in the terminal has none. For a message sent during a turn it comes when Claude reads it, not when it's typed, so a client can show it as waiting until then, as Claude Code does. If someone takes it back at the terminal, `send.failed` with `taken_back` comes instead. Slash commands that Claude Code runs itself, such as `/compact`, fire no hook, so they never echo.

A message that starts with `!` is a line for the shell, which runs in the terminal, as typing it there does. Claude Code fires no hook for one, so it echoes from the transcript once it has run: `message.user` with `shell: true` and the text as typed, then `message.output` with what it printed, `stdout` and `stderr` apart, as Claude Code shows them. Unless `respondToBashCommands` is off, Claude answers it in a turn of its own, so the session goes `running`, and `replies` is true. When `replies` is false nothing follows, and the line is all there is. Both carry the time the transcript has for them as `at`.

### Images

Images stay out of pages and events, because a page can have dozens of them. `history` and `join` items with the role `user` or `tool` can have `images`, each `{id, mediaType, bytes}`, and `image` fetches one when given that `id` as `imageId`, with `unknown_image` if the transcript no longer has it. An image's `id` only means something to `image`, and calls made by a subagent have none.

During a turn, `tool.images` and `message.images` say the same. They come from the transcript, so they can arrive after what they belong to. `tool.end.response` doesn't carry the image itself: its base64 is left out, and the rest stays.

### Attachments

A message can come with pictures, videos and files: `upload` each one, then `send` their `uploadId`s as `attachments`, in the order they should go. `text` can then be empty. An upload is kept for its session, so `send` has to name the same `sessionId`.

Uploads go in the Mac's Downloads folder, as anything else it's sent does, numbered the way Finder numbers a copy when the name is taken. They stay there when their session is deleted: what the helper forgets is which session they were for, then and after 30 days. A Mac that won't let the helper write in Downloads gets them in `~/.venes/uploads` instead.

| `kind` | When | How it reaches Claude |
|---|---|---|
| `image` | `mediaType` is `image/png`, `image/jpeg`, `image/gif` or `image/webp` | Its path is pasted on its own, and Claude Code turns it into an image, as it does one dragged into the terminal. |
| `video` | `mediaType` starts with `video/` | Its path, as it is. Claude can't watch a video, but it can work with one by its path, with a tool, which asks for permission. |
| `file` | Anything else, HEIC included, which Claude can't look at, so convert it first | An `@"path"` reference, which puts its contents in the message. Claude may still read a PDF again with a tool, which asks for permission, because uploads aren't in the session's folder. |

They all go ahead of the text, and the text in `message.user` and in `history` items leaves out what was typed for them: Claude Code's `[Image #n]` marks, the references and the paths, at the start of a message only. Pictures then show as `images`, like any other. Files and videos are listed as `attachments`, each `{uploadId, name, mediaType, size}`. A picture Claude Code didn't take stays as its path, and is listed as a file.

A name loses anything that can't be part of a path, a picture's and a video's lose their spaces, and they end in their type's extension. An upload can be up to 30 MB, and a message can have up to 20. A session that isn't running gets its first message's attachments as references on the command line, pictures too.

#### Over SSH

A file doesn't have to travel in the lines of the connection: base64 makes it a third bigger, and Rex takes a message of at most 1 MB. A client that can log in over SSH runs `~/.venes/venes receive` there instead, and writes a line of JSON with `sessionId`, `name`, `mediaType` and `size`, then exactly `size` bytes. It prints one line, the same `result` `upload` replies with, or one with `ok: false` and an `error`, and exits. The file then goes in a message by its `uploadId`, as any other.

A client that came through Rex gets in with `ssh`, which takes its `publicKey`, an Ed25519 key as `authorized_keys` has them, and lets it in, as pairing over SSH does. Whoever reaches the helper can do as much already. It replies with the `user`, the `port`, the `hostKey` fingerprint, and the `hosts` to try in order: this Mac's own address on its tailnet while its Tailscale is on, then its name on the local network. Rex's built-in Tailscale is no use here, since only Rex answers on that node. `hosts` is empty while Remote Login is off. Over SSH, macOS lets a program in Downloads only with *Allow full disk access for remote users* on, in Remote Login's settings, so `receive` hands the file to the helper, which goes by the terminal's access.

### History

Pass `before` from one reply to get the page before it. It counts items from the start of the transcript, so it stays valid while the session runs. Calls made by a subagent follow the call that started it, carry `parentToolUseId`, and don't count towards `limit`.

| `role` | Fields |
|---|---|
| `user` | `text`, and `shell: true` for a line run with `!` |
| `assistant` | `text` |
| `output` | `stdout`, `stderr`, `replies`: what a line run with `!` printed |
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
| `session.model` | `model` |
| `session.effort` | `effort` |
| `session.ended` | `reason` (`replaced` after `/clear` or `/resume`) |
| `session.deleted` | |
| `message.user` | `text`, `clientId`, `attachments` (only when it has files), `shell` (only for a line run with `!`) |
| `message.output` | `stdout`, `stderr`, `replies`, `clientId`: what the line run with `!` before it printed |
| `message.assistant.delta` | `messageId`, `index`, `text`, `final`, `agentId` |
| `message.thinking` | `text`, `durationMs` |
| `tool.start` | `toolUseId`, `name`, `input`, `agentId`, `parentToolUseId` |
| `tool.end` | `toolUseId`, `name`, `response`, `durationMs`, `isError`, `interrupted`, `parentToolUseId` |
| `tool.images` | `toolUseId`, `images` |
| `message.images` | `images`, for the latest `message.user` |
| `request.opened` | `request` |
| `request.closed` | `requestId`, `decision`, `by` (`client`, `terminal`, `turn_end`, `session_end`) |
| `turn.end` | `lastMessage`, `backgroundTasks` (a count), `tasks` (those running) |
| `turn.interrupted`, `turn.error` | `error`, `details` |
| `agent.start`, `agent.stop` | `agentId`, `agentType`, `parentToolUseId` (on start) |
| `task.created`, `task.completed` | `taskId`, `subject`: items on Claude's task list |
| `background.task` | `task`: a background command, agent or workflow changed. One Claude stopped is `killed`, and one still running when its session ended is `stopped` |
| `task.notification` | `taskId`, `status`, `summary`: a background task finished and Claude is reading about it |
| `notification` | `notificationType`, `message` |
| `compact.start` | `trigger` |
| `compact.end` | `trigger`, `preTokens`, `postTokens` |
| `compact.failed` | `trigger`, `message`: a compaction ended with nothing compacted. `message` is Claude Code's reason, such as `Not enough messages to compact.`, and is missing if the compaction went silent for thirty minutes. |
| `model.refusal` | `id`, `model`, `fallbackModel`, `scope`, `category`, `explanation`, `text`, `prompt` |
| `send.failed` | `clientId`, `code`, `message`: a held message couldn't be delivered |

Order text by `messageId` and `index`, because hooks run as separate processes and a delta can arrive after `turn.end`. `message.thinking` comes from the transcript, so it can arrive after the text it came before.

Snapshots also carry each session's `model`, `lastPrompt` and `lastMessage`, for a list. They stay current through `session.started`, `message.user` and `turn.end`.

A `task` has `id`, `type` (`shell`, `subagent`, `workflow`, `monitor` and others), `status` (`running`, `completed`, `failed`, `killed`), `description`, `name`, `command`, `agentType`, `toolUseId`, `startedAt`, `finishedAt`, `summary`, `tokens`, `toolUses`, `durationMs` and `hasOutput`, as far as they're known. Snapshots list them under `sessions[].tasks`.

`tool.end.response` is the tool's own result. For Bash it can include `gitOperation`, such as `{"commit":{"sha":"d95e564","kind":"committed","branch":"main"}}`.

### Errors worth handling

| `code` | Meaning |
|---|---|
| `request_pending`, `dialog_open` | `send` or `configure` was refused because Enter would have answered an open prompt |
| `request_closed` | That request was already answered |
| `no_pane` | The session isn't in Rex or tmux, or started before the plugin was installed, so it can't be typed into until it's restarted |
| `resume_failed` | Claude Code quit, or took too long, resuming a stored session |
| `sdk_unavailable` | The Agent SDK couldn't be installed, so `library` has nothing to list. The next request tries again. |
| `no_tmux` | Neither Rex nor tmux is installed, so a stored session can't be resumed |
| `no_claude` | Claude Code isn't on the PATH, so `capabilities` has nothing to ask |
| `session_running` | The session wouldn't stop, so `delete` left it alone |
| `background_session` | `delete` doesn't handle background sessions. Use `claude rm`, which has its own rules about their worktrees. |
| `bad_model`, `bad_effort` | `configure` was given something that isn't a model on offer or an effort level |
| `picker_failed` | The terminal's model picker wasn't as expected, so nothing changed. Claude Code's picker may have changed, or the session's model may not be one of its rows. |
| `message_too_long` | The first message to a stored session has to be under 12 KB, because it travels on a command line. Later ones don't. |
| `bad_upload`, `too_large` | An upload had no type, nothing in it, or more than 30 MB |
| `bad_attachment` | `send` named an upload that isn't there any more, or more than 20 |
| `unknown_file` | `file` named an upload the Mac no longer keeps, or that someone moved |
| `bad_key` | `ssh` was given something that isn't an Ed25519 public key |
| `terminal_only` | That slash command opens a page, which only works at the terminal for a client that doesn't show `pages`. The page has been closed. |
| `no_page` | `pageKey` or `pageText` with nothing open in the terminal |
| `bad_query` | `mentions` was given something other than a string, or a very long one |
| `bad_key` | Also a `pageKey` key a page doesn't take |
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
- **The transcript format is undocumented,** so a Claude Code update could stop interrupt detection and `history` working until the parser is updated. The SDK's `getSessionMessages()` doesn't have this problem, but it stops at the last compaction, which can be nearly all of a long session, so `history` reads the transcript.
- **A session outside Rex and tmux can't be typed into.** It's listed, and if it started with the plugin it can be watched and answered. One started before the plugin was installed shows only what's in its transcript.
- **A dialog can stop a resume.** If Claude Code asks something first, such as whether to continue a long conversation, `send` fails with `dialog_open`, and someone at the Mac has to answer it in the `venes-<id>` window or tmux session.
- **`configure` reads the picker off the screen.** Its keys are documented but what it draws isn't, so a Claude Code update could stop `configure` working. It would then fail with `picker_failed` and change nothing. A rebound `modelPicker:thisSessionOnly` or `chat:modelPicker` key does the same. Changing a session's effort also needs its model to be a row in the picker.
- **A restart forgets most of a session's state.** Sessions in Rex or tmux stay listed, as idle until they're next heard from. The rest reappear on their next event. Events, held messages and open requests are lost.
- **A release reaches everyone at once.** Pushing a new `version` to `main` installs it everywhere within about six hours. A push that doesn't change `version` reaches no one.
- **Background tasks can't be stopped from here.** Claude Code offers no way to stop one from outside, so the only route is asking Claude in a message.
- **Workflows report no progress.** A workflow appears as a task with a name and status, but its phases and agents aren't available to hooks.
- **Refusals are untested against the real thing.** `model.refusal` is built from the record format, without a real refusal to check it on.

## Development

```sh
npm test                                     # unit tests, no Claude needed
VENES_E2E_WS=/abs/workspace npm run e2e      # real Claude Code, in an isolated tmux and Rex server
```

The sessions an end-to-end run starts are deleted when it finishes, so they don't stay in Claude Code's list of stored sessions.

The end-to-end suite loads this folder with `--plugin-dir`, so nothing gets installed, and it uses a small amount of model usage. A few cases use `/model` at the terminal, which writes to `~/.claude/settings.json`, and they put it back afterwards. Set `VENES_E2E_SSH=1` to add a case that goes through real SSH to this Mac, which needs key login to `localhost`.

## License

[MIT](LICENSE)
