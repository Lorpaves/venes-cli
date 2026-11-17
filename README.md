# Venes CLI

A Claude Code plugin, and the `venes` command, that turns a session's hooks and transcript into one structured event stream, so you can follow and answer it from another device: messages, status, permission prompts, questions and plans.

It's the computer's side of [Venes](https://venes.lorpaves.com), an app for iPhone and iPad, and runs on macOS and on Linux. Everything can be used from the command line too.

Venes is an independent project, not made by or affiliated with Anthropic.

## Install

Requires Claude Code, Node.js 22 or later, and either [Rex](https://www.superlogical.com/rex) or tmux to send input to a session. It runs on macOS and on Linux, where it needs curl too. What's different on Linux is under [Linux](#linux).

```sh
brew install lorpaves/venes/venes
```

That installs the plugin into Claude Code, starts its background helper, and puts `venes` on your PATH. Sessions that were open before need a restart or `/reload-plugins` to be seen. The plugin then keeps itself up to date through Claude Code, and `brew upgrade` updates it whenever there's a new release.

That's the same on a Mac and on Linux, where Homebrew runs too. Without Homebrew, run the install script, which does the same but leaves the command at `~/.venes/venes`:

```sh
curl -fsSL https://raw.githubusercontent.com/Lorpaves/venes-cli/main/install.sh | sh
```

On Linux it links the command into `~/.local/bin` as well, where Claude Code's own installer puts `claude`, so it's `venes` once that folder is on your PATH.

Or at the prompt of a Claude Code session, `/plugin install venes --marketplace Lorpaves/venes-cli`. The helper then starts with the next session, or with the next message after `/reload-plugins`.

## Try it

Run Claude in Rex, or inside tmux, so the helper can type into it:

```sh
tmux new -A -s cc      # then run claude inside it
```

Watch from a second terminal:

```sh
venes watch                  # live events
venes sessions
venes send <session> "hello"
venes allow <request>
```

Run `venes` for every command. Session ids accept a unique prefix. Installed without Homebrew, the command is `~/.venes/venes`, which appears once the helper has started.

## Pairing the app

Run this and scan the code in the app:

```sh
venes pair
```

The phone reaches this Mac in one of two ways, and `pair` asks which, starting on one that works now, Rex first. A way that's ready says it needs nothing downloaded:

- **Rex,** with *Serve over Tailscale* on in [Rex](https://www.superlogical.com/rex)'s settings. The phone has to be on your tailnet as the account Rex uses: the app signs in to Tailscale itself, for each Mac, or uses the Tailscale app. Nothing else is needed, not even Remote Login.
- **tmux, over SSH,** with Claude Code running inside tmux (`brew install tmux`) and Remote Login on, in System Settings > General > Sharing.

A way that's only switched off is waited for while you turn it on, and Remote Login's settings open for you. One that needs something downloaded says how to get it. `pair --rex` and `pair --ssh` pick a way without asking, as running it anywhere but a terminal does: Rex when that works, and SSH otherwise. `--ssh` doesn't ask for tmux, for a Mac whose sessions run in Rex.

Through Rex, the code holds this Mac's name, its address on your tailnet, and the Tailscale account Rex is signed in with, and no credential: Rex asks Tailscale who's calling and lets in only the account that signed in. To stop a phone reaching this Mac, sign it out of that account or turn Tailscale off in Rex.

Over SSH, the code holds this Mac's name, address and host key, and a one-time key. The address is this Mac's on your tailnet while its Tailscale app is on, so the phone reaches it from anywhere, signed in to Tailscale in the app as any account the tailnet lets reach it. With Tailscale off, it's the Mac's name on the local network. On Linux that's the computer's name where Avahi answers for it, and its address on the network where not. That key is added to `~/.ssh/authorized_keys` and can do nothing but hand over the app's own public key. It works once, and it's removed after five minutes either way. The app's private key never leaves the phone, and nothing asks for your password. To unpair a phone, delete its `venes-phone` line from `~/.ssh/authorized_keys`.

## What it does on your machine

- **It stays local.** Your sessions never leave this Mac except over SSH or Rex to your own devices. The plugin opens no TCP ports, and events go over two Unix sockets in `~/.venes`, a `0700` directory.
- **It checks for updates.** `claude plugin` fetches this repository, and new versions install by themselves. See [Updates](#updates).
- **It downloads one thing.** The first time it starts, it runs `npm install` for Anthropic's [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), into `~/.venes/sdk`, to list your stored sessions. It leaves out the SDK's Claude Code binary, runs no install scripts, and needs no account: the SDK only reads files on this Mac here. Without it, the app still shows what's running.
- **It sees your sessions.** Hooks forward prompts, replies, tool inputs and results to the helper, which keeps the last 5000 events in memory and writes none of them to disk. So that a restart doesn't lose track of them, it keeps a list of open sessions in `~/.venes/sessions.json`: their ids, folders and tmux panes, with no conversation text.
- **It can act for you.** Anyone who can log in to your Mac as you, or get into your Rex, can approve tools, type into sessions and resume stored sessions through it. Use an SSH key, and consider turning password login off.
- **It changes your files only when you ask.** From the app you can look through a session's folder, and through any folder on this Mac while you choose where a session starts, and there make a file or a folder, edit a text file, and delete one. A file that changed since you opened it isn't written over unless you say so, and what you delete goes to the Trash, where you can put it back from: on Linux the desktop's own, as its file manager keeps it.
- **It keeps what you attach.** A picture, video or file sent with a message from the app is saved in your Downloads folder, where Claude can read it and you can find it: on Linux the one your desktop names. They stay there when you delete the session. What the helper knows of them is in `~/.venes/uploads`, until the session is deleted, or for 30 days.
- **It stands in as your status line.** A plugin can't set Claude Code's status line, and what Claude Code tells a status line is the only place a session's limits are, so the helper sets `statusLine` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`) to `~/.venes/venes statusline`. That keeps what Claude Code sends in `~/.venes/status`, a file a session for a week, and runs the status line you had with the same input, so your terminal shows what it did. The one you had is kept in `~/.venes/statusline.json`. With none before, it shows nothing, and Claude Code then leaves out the key hints it shows under the box when there's no status line. `~/.venes/venes statusline off` puts yours back and keeps it there; `statusline on` stands in again. A settings file that isn't plain JSON is left alone.
- **It can let your phone in over SSH.** The app asks to, to send files over SSH, and the helper adds the phone's own public key to `~/.ssh/authorized_keys`, as pairing over SSH does. That only works while Remote Login is on.
- **It follows Antigravity, if you use it.** On a Mac that has Google's Antigravity (a `~/.gemini` folder), the helper puts a plugin of its own in `~/.gemini/config/plugins/venes`, whose hooks hand what an Antigravity session does to the helper, as the Claude Code plugin's do. No hook of it is asked whether a tool may run, so Antigravity decides that as it would without it, and with no helper running the hooks do nothing. A session you start from the app runs `agy` in Rex or tmux, and `agy acp` once, for a moment, to make the empty conversation. While you look at a session's status it runs `agy -p /usage` every few minutes, for your limits. It reads Antigravity's own list of your conversations and their transcripts, and changes what Antigravity keeps only when you delete a session from the app, which moves that conversation to the Trash. See [Antigravity sessions](#antigravity-sessions).
- **It talks to Codex, if you use it.** Codex keeps a server of its own on this Mac for its apps, and the helper connects to it over the socket in `~/.codex/app-server-control`, to list your Codex sessions and work them. It only starts that server, with `codex app-server daemon start`, when you start or open a Codex session from the app. See [Codex sessions](#codex-sessions).
- **It counts what you've used.** For the app's usage card, it reads the token counts Claude Code, Codex and Antigravity write in their own chats (`~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/antigravity-cli/conversations`), adds them up by day, and keeps the sums, and no content, in `~/.venes/usage.json`. To say what those tokens would cost, it downloads a public list of model prices, [LiteLLM's](https://github.com/BerriAI/litellm), from GitHub once a day into `~/.venes/prices.json`, and sends nothing with the request. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `VENES_NO_PRICES` turns the download off, and the prices are then those this version came with.
- **It never touches your Claude or Codex credentials.**

If the helper isn't running, the hooks do nothing and Claude Code behaves as usual.

## Updates

Every six hours the helper asks Claude Code for a new version of the plugin, using the same `claude plugin` commands you'd run yourself. When there is one, the helper restarts on it the next time nothing is in progress: no turn running, no open request and no held message. A session that has been silent for an hour doesn't count, so a crashed one can't hold an update back.

Open sessions keep working through the restart. They go on using their old hooks until their next start or `/reload-plugins`, and a connected app sees its connection drop and reconnects.

An update is new code running with the helper's access, which can approve tools and type into sessions. To review new versions yourself, turn this off:

```sh
venes auto-update off    # or on
venes update             # check now, whatever the setting
venes version
brew upgrade venes       # installed with Homebrew: update to the newest release now
```

The helper also leaves updates alone when `DISABLE_UPDATES`, `DISABLE_AUTOUPDATER` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set, unless `FORCE_AUTOUPDATE_PLUGINS` is too. If you update the plugin another way, the next session to start moves the helper to the new version.

## Uninstall

```sh
brew uninstall venes
```

Installed without Homebrew, run `~/.venes/venes uninstall`, which is what Homebrew runs too. It asks first, or doesn't with `--yes`. Then it:

- takes the plugin and its marketplace out of Claude Code;
- puts your status line back, takes its plugin out of Antigravity's folder, and stops the helper;
- takes the keys phones were let in with out of `~/.ssh/authorized_keys`: only lines marked `venes-phone`, or `venes-pairing-…` from a pairing that never finished;
- deletes `~/.venes`.

`brew upgrade` and `brew reinstall` only stop the helper, bring the plugin up to date and start it again, and paired phones stay paired.

Sessions that are open still run the plugin's hooks until they restart or run `/reload-plugins`, but those hooks don't set the helper up again.

It leaves alone:

- pictures, videos and files sent from the app, in your Downloads folder;
- the Mac in the app, which you forget there; this Mac sends the phone no more notifications;
- Rex's *Serve over Tailscale* and Remote Login, which are your own settings; turn them off if nothing else needs them.

If `~/.venes/venes` isn't there, the helper never started, and `claude plugin uninstall venes@venes` is all there is to do.

## Linux

The helper does on Linux what it does on a Mac, with what a Linux system has:

- **Installing.** With Homebrew as on a Mac, or with the install script above. Either way it needs `curl`, which a session's hooks reach the helper with. With Homebrew, an upgrade from 0.28.2 or earlier takes Venes off whole before it installs the new one, and phones have to be paired again that once: the script that tells an upgrade from an uninstall couldn't on Linux until 0.28.3.
- **tmux.** 3.2 or later, which is the first that can start a session with the settings the helper gives it. Ubuntu 22.04 and Debian 12 have one, and older systems' own packages don't.
- **Pairing over SSH.** Remote Login is the SSH server: `sudo systemctl enable --now ssh` (the service is `sshd` on Fedora and Arch). `venes pair` draws its code itself, with nothing to install for it.
- **Pairing through Rex.** The Rex server from [its own installer](https://www.superlogical.com/rex/docs/installation), with its Tailscale on: `rex server tailscale login`, then `rex server tailscale on`.
- **The Trash.** What's deleted from the app goes where a file manager's Move to Trash puts it, by the [freedesktop.org Trash specification](https://specifications.freedesktop.org/trash/latest/): `~/.local/share/Trash` for what's on the home folder's disk, and a `.Trash-<uid>` folder at the top of another disk for what's there. Each thing has its note of where it was, so the file manager can put it back.
- **Downloads.** The folder the desktop names in `~/.config/user-dirs.dirs`, or `~/Downloads`.
- **The account's picture.** `~/.face`, or the one the system keeps for the account, if it's a JPEG or a PNG under a megabyte.
- **No Screen Sharing.** That's a Mac's own. `screen` answers that it's off.

What has been run on Linux: the unit tests, the Homebrew cask on a machine of GitHub's (installed, reinstalled as an upgrade does, and uninstalled), and the helper end to end in an Ubuntu container, installed by its script into Claude Code, paired over sshd, reached as the app reaches it, with files made and trashed, terminals driven through tmux and through Rex, and hooks taken in from both. And with the app itself, in an iPhone simulator paired with Ubuntu 24.04 over SSH: sessions of Claude Code (against a stand-in for the model's API), of Codex and of Antigravity (both signed in) were started from the app, typed into through tmux, and asked and answered for permission, with the folder's trust asked first where it wasn't trusted. Not run on Linux: Claude Code signed in to an account, pairing through Rex's Tailscale, and a phone rather than a simulator.

## Windows

Not finished. What's there: the helper follows the sessions at the computer, and a phone paired over SSH can read them, answer what they ask, and look through their files and their git. The app can't type into a session on Windows yet, or start one, and says so when asked to. It has been tried with the app in an iPhone simulator, and **not yet on a phone**.

**Installing.** Node.js has to be installed, with `node` on the `PATH`: Claude Code's own installer doesn't bring one. Then, in Claude Code:

```
/plugin marketplace add Lorpaves/venes-cli
/plugin install venes-windows@venes
```

`venes-windows` is this plugin with hooks that start Node themselves. A hook takes about 75 ms that way. The plugin under its own name, `venes`, works on Windows too, through a shell: about 0.16 seconds a hook in Git Bash where [Git for Windows](https://git-scm.com/downloads/win) is installed, and about a second in PowerShell where it isn't. Before 0.27.0 a hook failed in PowerShell, which stopped every tool Claude used.

**Pairing.** With Windows' own OpenSSH Server: add it in Settings > System > Optional features, then in a terminal opened as administrator, `Start-Service sshd; Set-Service sshd -StartupType Automatic`. Then `cmd /c "%USERPROFILE%\.venes\venes.cmd" pair`, which PowerShell and the older prompt both take: `%USERPROFILE%` alone means nothing to PowerShell, and `~` nothing to the older prompt.

- **An administrator's keys.** sshd keeps them in `C:\ProgramData\ssh\administrators_authorized_keys`, which only an administrator can change. In a terminal that wasn't opened as one, Windows asks to let Node.js make changes: that's `pair`, adding the one-time key there. Any other account's keys are in its own `.ssh\authorized_keys`, and nothing is asked.
- **The firewall.** Windows lets SSH in only on a network it calls private, and calls a new network public. `pair` says so when that's in the way, and how to change it.
- **The phone's key.** sshd on Windows gives a command to `cmd`, which can make nothing of `~/.venes/venes attach`. So the phone's key is tied to `venes.cmd ssh`, which reads what the phone asked for and does it if it's `attach` or `receive`. The key can run nothing else, and can still forward a port.
- **The address.** The tailnet's when Tailscale is on, and otherwise the computer's address on its network, which a router can change.

**What's different from a Mac.**

- **Paths.** The app takes a path apart at its slashes, so the helper says `C:\Users\ada\work` as `/C:/Users/ada/work` and takes it back the same way. `/` lists the drives.
- **The helper.** Its launcher is `%USERPROFILE%\.venes\venes.cmd`, and its two sockets are named pipes. Windows' management service starts it, so that it's no session's to end: started any other way, it went when the SSH session that started it closed.
- **Who starts it.** Claude Code at the computer does, when a session starts. A phone that connects before that, to an administrator's account, is told to start Claude Code there: sshd gives an administrator's session an administrator's full rights, and a helper started with those couldn't be reached by Claude Code, which runs without them. For the same reason a Claude Code run as administrator and one that isn't don't share a helper.
- **The Recycle Bin.** What's deleted from the app is moved into the bin's own folder on its drive, where Explorer shows it and puts it back. On a drive with no bin for the account, nothing is deleted.
- **In WSL.** Claude Code inside WSL is on Linux, and so is the helper: the Linux notes above are the ones that apply. That hasn't been run.
- **Not there yet.** Typing into a session and starting one (there's no tmux on Windows, and Rex hasn't been tried there), the status line, Codex and Antigravity.

What has been run on Windows: the smoke test (`node test/smoke.mjs`) and the unit tests that hold there, on Windows 11 on Arm and on GitHub's Windows machines; Claude Code 2.1.325 with the plugin under both names on Windows 11, with Git for Windows and without, against a stand-in for the model's API, where sessions were followed and tools ran; and against Windows 11's OpenSSH Server from another computer: pairing in a terminal opened as administrator and in one that wasn't, then folders, files, git, a delete that Explorer put back, and a permission asked and answered. And with the app itself, in an iPhone simulator on the computer the Windows machine ran on: paired by the link `pair` prints, it listed the sessions, showed one as it ran, answered a permission Claude Code asked at its terminal (which then ran the command), and showed the folder's files and its git.

## How it works

```
Claude Code ──hook──▶ hook.sock ┐
                                ├─ helper ─▶ client.sock ◀─ ~/.venes/venes attach ◀─ SSH or Rex ◀─ app
transcript ───── polled ────────┘     │
                                      ├─ Rex or tmux ─▶ sends text and keys to the terminal
                                      └─ Codex's app server ◀──▶ Codex sessions, as its own messages
```

## Protocol

A client runs `~/.venes/venes attach` over SSH, or [through Rex](#connecting-through-rex), and speaks newline-delimited JSON on stdin and stdout. SSH handles authentication. The launcher uses absolute paths because a command run over SSH gets a minimal PATH without node or tmux, and the plugin refreshes it at each session start because the plugin's path changes with every version. The helper starts on demand and outlives the connection.

The connection opens with `{"type":"hello","protocol":…,"version":…,"platform":…}`, where `platform` is what the helper runs on, `darwin` or `linux`, as Node names it, which says whether there's a Mac's Screen Sharing to ask for. Every request has an `id` and a `cmd`, and gets a `{"type":"result","id":…,"ok":true,…}` reply. On failure, `ok` is false and `error` holds `{code, message, details}`. Replies can arrive out of order, so match them by `id`.

A line ends at a line feed and nowhere else. JSON leaves a line separator (U+2028) or a paragraph separator (U+2029) in a string as it is, and a reader that takes either for a line's end, as Node's `readline` does, loses any message with one in it, which a message's text or a file's can have. The helper reads a client's lines by the line feed alone (a helper before 0.19.1 didn't), and escapes those two in what it writes, so a client is safe to send them as they are or escaped, and to read with whatever splits lines.

| Command | Fields | Reply or effect |
|---|---|---|
| `ping` | | `protocol`, `version`, `platform`, `quiet` (whether the helper could restart now), and `tailscaleAccount` while Tailscale is on in Rex: the account Rex is signed in with, which a phone reaches this Mac as through Rex |
| `update` | | Checks for a new version now. `version`, `available` (null if there's none) |
| `sessions` | | `sessions`, `unattached` |
| `library` | `limit`, `offset` | Every session Claude Code has stored, and what's running. See [The library](#the-library). |
| `capabilities` | `sessionId` | `commands` and `models` on offer in the session's folder. See [Commands and models](#commands-and-models). |
| `mentions` | `sessionId`, `query`, `limit` | `items`: what an `@` followed by `query` can name for the session, as Claude Code's own `@` offers it: each with its `path` and `kind`, `file` or `dir`, a folder's path ending in `/`. A `query` that starts like a path (`./`, `../`, `~/`, `/`, or just `~`, `.` or `..`) lists the folder it points into, folders first, hidden entries left out, written the way it was typed, as in `../helper/`. Anything else is looked for among the project's files and the folders above them, best match first, scored as Claude Code scores them: in a git repository every file git has, from the session's folder, then new ones unless ignored; elsewhere what ripgrep finds. With nothing typed, or just `.` or `./`, it's what's in the session's folder. A leading `@` in `query` is ignored. As many as Claude Code shows, 15, or 10 of a folder, and fewer if `limit` asks |
| `configure` | `sessionId`, `model`, `effort` (either or both) | Changes what the session runs on. See [Commands and models](#commands-and-models). |
| `setMode` | `sessionId`, `mode` | Changes the mode a session asks permission in. See [Permission modes](#permission-modes). |
| `delete` | `sessionId` | Deletes the session from this Mac for good. See [Deleting a session](#deleting-a-session). |
| `folders` | `path`, `hidden` (both optional) | Where a new session can start. Without `path`: `home`, and `recent`, the folders sessions ran in lately. With it: that folder's `path`, `name` and `trusted`, its `entries`, and `truncated`. See [Starting a session](#starting-a-session). |
| `folderCreate` | `path`, `name` | Makes a new folder in that one, for a session to start in: its `name`, `path` and `trusted`. See [Starting a session](#starting-a-session). |
| `folderFileCreate` | `path`, `name` | Makes an empty file in that folder, for the session that starts there to find: its `name`, `path`, `kind` and `size` |
| `pushRegister` | `deviceId`, `token`, `key`, `sandbox`, `mac`, `agents` | A phone that wants notifications while it isn't connected. See [Notifications](#notifications). |
| `pushUnregister` | `deviceId` | That phone doesn't want them any more |
| `start` | `cwd`, `trust`, `agent` | Starts Claude Code in that folder and replies with its `sessionId` once the session has started. See [Starting a session](#starting-a-session). With `agent: "codex"` it starts a Codex session there. See [Codex sessions](#codex-sessions). |
| `files` | `sessionId`, `path` (optional) | What's in the session's folder, or in a folder inside it: `entries`, each a `dir` or a `file`. With no `sessionId`, what's in the folder at `path`, anywhere on this Mac. See [Files and git](#files-and-git). |
| `fileRead` | `sessionId`, `path` | One of its files: its `text`, or for anything else its bytes in `data`. See [Files and git](#files-and-git). |
| `fileChunk` | `sessionId`, `path`, `offset`, `length` | A piece of one of its files, of any size: its bytes in `data`, with the file's `size` and `modifiedAt` |
| `fileCreate` | `sessionId`, `path` (optional), `name`, `folder` | Makes an empty file, or with `folder: true` a folder, in the session's folder or in one inside it, and replies with it as `files` lists it. See [Files and git](#files-and-git). |
| `fileWrite` | `sessionId`, `path`, `text`, `was`, `overwrite` | Writes a text file's new text, when it's still the file that was read: its `size` and `modifiedAt` now. See [Files and git](#files-and-git). |
| `fileDelete` | `sessionId`, `path` | Moves one of its files or folders to the Trash: its `name` and `path` |
| `git` | `sessionId`, `root` | `git`: the branch and what has changed in the session's repository, or null with none, and its `repositories`. See [Files and git](#files-and-git). |
| `gitDiff` | `sessionId`, `path`, `staged`, `commit` | `diff`: one file's change, from its first hunk on |
| `gitLog` | `sessionId`, `limit`, `skip`, `all` | `commits`, newest first, each with its `parents` and `refs`, and `hasMore` |
| `gitCommit` | `sessionId`, `commit` | `commit`, with all it says, and the `files` it changed |
| `gitBranches` | `sessionId` | `branches`, the one last committed to first |
| `gitStage`, `gitUnstage` | `sessionId`, `paths` or `all` | Puts files' changes in the next commit, or takes them back out |
| `gitCommitStaged` | `sessionId`, `message` | Commits what's staged. Replies with the `commit`'s `hash` and `short` form. |
| `gitSwitch` | `sessionId`, `branch` | Moves the folder to another of the repository's branches |
| `subscribe` | `since`, `bootId` (both optional), `agents` | Sends a `snapshot`, replays later events, then streams. `gap: true` means events were lost, so reload. `agents` lists the sessions other than Claude Code's that the client can show: `["codex"]`. See [Codex sessions](#codex-sessions). |
| `join` | `sessionId`, `limit` | Everything needed to open a session. See [Joining a session](#joining-a-session). |
| `history` | `sessionId`, `limit`, `before` | `items`, `before`, `hasMore`: a page of the conversation, from the transcript. It starts where a turn does, so it can hold more than `limit` |
| `image` | `sessionId`, `imageId` | `mediaType`, `data` in base64: an image from the conversation. See [Images](#images) |
| `avatar` | | `mediaType`, `data` in base64: the picture this Mac's account shows at login, at most 256 pixels on its long side. Empty if it has none |
| `respond` | `requestId`, `decision`, `message`, `answers`, `always`, `option` | Answers a request |
| `upload` | `sessionId`, `name`, `mediaType`, `data` in base64 | Keeps a picture or file for a message. `uploadId`, `name`, `mediaType`, `size`, `kind`. See [Attachments](#attachments) |
| `file` | `sessionId`, `uploadId` | `name`, `mediaType`, `data` in base64: a file a message had attached, while the Mac still keeps it |
| `discard` | `sessionId`, `uploadId` | `discarded`: an upload taken back out of the composer before its message went. Its file goes from Downloads too, unless a message has it or it was moved or changed since. See [Attachments](#attachments) |
| `ssh` | `publicKey` | Lets the client's key in over SSH, for files: `user`, `port`, `hostKey`, `hosts`. See [Over SSH](#over-ssh) |
| `screen` | | Where this Mac's own Screen Sharing is, to reach straight over the tailnet: `user`, `port` (5900), `on`, `hosts`, and where its `displays` are. See [The screen](#the-screen) |
| `statusLine` | `sessionId` | `status`: what Claude Code last told the session's status line, as the helper stands in for it, or `null` before it has. `model` and `effort` as Claude Code names them, `project` the folder it started in, `repo` as `owner/name`, `branch` checked out, `context` with its `percent` used, the input tokens `used` and the window's `size`, `fiveHour` and `sevenDay` with their `percent` used and `resetsAt` in Unix seconds, `modelLimits` for an account whose week has limits that are each for one model, as Fable's is, each with the model's `name`, `percent` and `resetsAt`, `limits` for an agent whose limits are more than those two, each with the `name` it goes by, its `window` (`fiveHour` or `sevenDay`, or none for another length), `percent` and `resetsAt`, `credits` for an account that has some past its plan's limits, with its `balance` or that it's `unlimited`, `limitResets` for the resets of its limits an account has to hand, each with a `title` and when it `expiresAt` where the agent says, `cache` with its `percent` of input read from it, whether it's `warm` and when it `expiresAt`, `cost` in dollars, and `updatedAt`. Limits are there with a Claude plan, and an API has none, so its `cost` is what to show. A limit that has reset since is `0` with no `resetsAt`, and a session with no reply yet has the account's last limits. `modelLimits` aren't in what a status line is told: they're what Claude Code's `/usage` shows, read through the Agent SDK at most every three minutes, by a call the SDK names experimental, so a helper without it, or an account without such a limit, leaves them out. The first read can come with a later `statusLine`. Each field is left out when Claude Code didn't say |
| `usage` | `timeZone`? | What every agent on this computer has used, for the account and not for one session. `timeZone` is the client's, by its name (`Asia/Shanghai`), and days and hours are told by the clock there; with none, or one the computer doesn't know, by the computer's own. `zone` is the one they're told by. `days`, the last ninety as dates by that clock (`2026-11-16`), oldest first and today last, and `hours`, the last twenty-four as its hours (`2026-11-16T15`), this one last. `agents`, each with its `agent` (`claude`, `codex`, `antigravity`) and what it has to show: `tokens`, with `input`, `output`, `cacheRead` and `cacheWrite`, each a number a day in the order of `days`; `cost` in dollars, a number a day, which is those tokens at public prices and not a bill; `saved`, what reading from a cache saved, a number a day: those reads at the price of input, less what they cost; `models`, each model the agent ran with its `model` name, `cost` and `tokens` (all kinds together) a number a day and `hourly` with the same an hour, and `unpriced`, its tokens the price list has nothing for, when any were, the costliest first; `hourly`, with `tokens`, `cost` and `saved` as those are and a number an hour, in the order of `hours`; `unpriced`, how many tokens were of models the price list has nothing for, when any were; `limits`, each with its `window` (`fiveHour` or `sevenDay`, or none for some other length), `percent` used, `resetsAt` in Unix seconds, and a `name` when it's one the agent meters apart; the account's `plan` and `credits`, as `statusLine` has them, where the agent says; and `limitsAt` in Unix seconds, when the limits were read. An agent nothing was counted for has only its `limits`. `scanning` is true while there's more to come, since the chats can be gigabytes and a reply doesn't wait for all of them: ask again in a moment. `updatedAt` in Unix seconds. See [What was used](#what-was-used) |
| `send` | `sessionId`, `text`, `clientId`, `lane`, `attachments`, `pages` | Types into the session, or holds the message. Replies with `queued`. What's sent is the message and nothing else: the terminal's input box is emptied first of whatever's in it, as a draft left at the Mac or a message Claude Code put back there when its turn was stopped, with the box's own keys (Ctrl+K and Ctrl+U, a few times over). A box that won't empty fails the send with `box_not_empty`. Slash commands work too. One that opens a page leaves it open for a client that says it shows `pages`, and the reply has `page: true`; for any other, the page is closed. A session that isn't running is resumed. See [The library](#the-library) and [Attachments](#attachments). |
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
| `queued` | Messages sent during the turn that Claude hasn't read yet, oldest first, each `{text, clientId, attachments}`. `clientId` is the send's, for one sent from a client, and there's none for one typed in the terminal. Each comes as `message.user` once Claude reads it. |
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

### Permission modes

A session says the mode it asks permission in as `permissionMode`, and the modes it can be switched to as `permissionModes`, in `sessions`, a snapshot and `join`, and in a `session.mode` event when either changes. `setMode` switches to one of them.

A Claude Code session's are Claude Code's own: `default`, which its terminal calls Manual, `acceptEdits` and `plan` always, then `bypassPermissions` and `auto` for a session that has them. Claude Code tells no one which a session has, so those two are listed once the session has been seen in them. Its mode is changed where a person changes it, in its terminal: the helper presses Shift+Tab, which goes round the session's modes, and reads the status bar after each press, until the bar says the mode asked for. A mode the bar comes all the way round without is one the session doesn't have, as `bypassPermissions` is for a session that wasn't started with it: the command fails with `mode_unavailable`, and the session is back in the mode it was in. The modes passed on the way are ones the session has, and are listed from then on. A hook says a session's mode only when the session does something, so the status bar is also read when a session is joined, which catches a mode switched to in the terminal since. A session outside Rex and tmux is refused with `no_pane`, and one with a dialog open with `dialog_open`. `dontAsk` is only ever started in, so it can be a session's `permissionMode` and never one of its `permissionModes`.

A Codex session's are the three choices Codex's terminal gives under `/permissions`, and planning: `readOnly` (Read Only), `workspace` (Default) and `fullAccess` (Full Access), each an approval policy and a sandbox, then `plan`. For one of the three, `setMode` takes hold from the session's next turn and holds for the turns after, and `session.mode` says so at once. Settings that are none of the three, as from a config of the reader's own, are `custom`, which can't be switched to.

`plan` is Codex's Plan mode, which its terminal goes in and out of with Shift+Tab: Codex looks, asks, and writes a plan, and changes nothing. Codex keeps it apart from the three, so a session that's planning still has one of them, and is back in it once the planning stops. `setMode` starts and stops the planning at once (Codex's `thread/settings/update`), for every client of the thread, Codex's own terminal among them, and one of the three picked while it plans stops it too. A Codex that won't take it fails the command with `mode_unavailable`.

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

### Starting a session

`folders` lists, newest first, the folders where the last 200 stored sessions ran, up to 20 of them, leaving out any that have gone. Each has its `path`, `name`, `running` (how many sessions are going in it now) and `trusted`. Beside them is `codex: true` when Codex is on this Mac, for a client to offer a [Codex session](#codex-sessions) there. With `path`, it lists the folders in that one, as Claude Code's `@` lists a folder: hidden ones left out unless `hidden` is true, by name as Finder sorts them, up to 1,000 with `truncated` past that. Each entry has its `name` and `path`.

`folderCreate` makes a folder named `name` in the one at `path`, for a session to start somewhere new, and replies with its `name`, its `path` and whether it's `trusted`. A name is one name: not empty, not `.` or `..`, with no `/` or `:` in it, and no longer than 255 bytes, or it's refused with `bad_name`. A name that's taken there, by a file or a folder, is refused with `name_taken`, and what's there is left as it is. A folder nothing can be made in is refused with `unwritable_folder`. `folderFileCreate` makes an empty file there the same way, by the same rules, and replies with it as `files` lists a file: its `name`, `path`, `kind` and `size`.

`start` opens Claude Code in a new terminal session of its own in `cwd`, in Rex if it's on this Mac and otherwise in tmux, as a resumed session gets. It replies once the session's first hook arrives, and the session is in `sessions` by then. If it doesn't start within 30 seconds, `start` fails, and the terminal stays open when a dialog is waiting in it.

Claude Code asks before it works in a folder it doesn't trust yet, and runs no hooks, the helper's included, until that's answered. `trusted` reads its own rules from `~/.claude.json`. A folder is trusted when the folder, or one above it, has been accepted. Inside a git repository the search stops at the repository's top folder, and outside one it goes up to the top of the disk. The home folder is asked about every time. `start` for a folder that isn't trusted fails with `needs_trust` and starts nothing. With `trust: true`, the reader's word in the app, it answers Claude Code's question with "Yes, I trust this folder", as the keys at the Mac would. If Claude Code asks about a folder that looked trusted, `start` picks "No, exit", so nothing is left running, and fails with `needs_trust`.

Claude Code can ask something else before a session starts or is back, with a list to pick from: as it asks about Code Mode, at every start, of whoever has set `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` and not yet said yes to it at a terminal. The helper answers none of that. It reads the question off the terminal, and the reader answers it:

- **A session resumed by a message** has the question asked on it as a request of kind `question`, in the shape of one Claude asks (`toolName: "AskUserQuestion"`, `input.questions` with one question: its `question`, the question's name as its `header`, its `options`). The message that resumed it is taken, and is the first thing the session hears once the question is answered. `respond` with `answers` keyed by the question presses that option in the terminal, as someone there would. Refused with `decision: "deny"`, it stays on the terminal, and the next message to the session is refused with `dialog_open` and has it asked again. Answered at the terminal instead, the request closes with `by: "terminal"`.
- **A new session** has no session yet to ask on. `start` is refused with `needs_choice`, whose `details` are the question's `title`, `text` and `options`. Ask the reader, and send `start` for the same `cwd` with `choice` set to the option they picked: it's pressed in the terminal that's waiting, and the session starts there. Sent with no `choice`, the same question comes back, from the same terminal.

### Codex sessions

Codex has a server for its own clients, which its desktop app, its editor extension and its remote control go through, and it keeps one running on this Mac as a daemon (`codex app-server daemon`). The helper is one more client of it, over the daemon's control socket, `~/.codex/app-server-control/app-server-control.sock`: a session here is a thread there, and everything comes and goes as that server's own messages. Nothing is typed into a terminal or read off one, and no hooks are installed in Codex.

A client says it can show Codex sessions with `agents: ["codex"]` on a command, `subscribe` being the one to put it on, and it holds for the connection. Without it, a client gets no Codex session in a snapshot, `sessions` or `library`, and none of their events: an app from before them would list such a session and make little of it. `pushRegister` takes `agents` the same way, for the phone's notifications.

A Codex session is told with the events and commands a Claude Code session has, and says whose it is: `agent: "codex"` is in its entry in `sessions`, a snapshot and `join`, in its `session.discovered`, in its requests, and in its `library` item. A Claude Code session has no `agent`.

**Which threads are sessions.** Every thread the daemon has in memory is a session going on, whoever started it: the helper, Codex's remote control, or a terminal at the Mac attached to the daemon with `codex --remote unix://`. The threads Codex made for itself, as a subagent's is, aren't. When the daemon lets a thread go, 30 minutes after its last client left, the session ends with `session.ended`, and it's still in the library. Codex's stored threads come with the first page of `library`, the 100 last worked on.

**A thread open in a terminal of its own.** Plain `codex` at the Mac runs its thread in its own process, where the daemon doesn't have it. It's in the library, and `join` and `history` read it, but only one process can run a thread at a time, so `send` to it is refused with `session_elsewhere` until that terminal closes it. `codex --remote unix://` at the Mac is how a terminal and a phone share one: then both see every message, and either can answer a request.

**What each command does.**

| Command | For a Codex session |
|---|---|
| `start` | With `agent: "codex"`: a new thread in `cwd`, run as your own Codex settings say, as it would be in your terminal. Codex's server trusts the folder from then on without asking, where its terminal would ask, so a folder Codex doesn't trust yet (`[projects."…"]` in `~/.codex/config.toml`, for the folder or the repository it's in) fails with `needs_trust` until `trust: true`. It starts the daemon if it isn't running, and fails with `no_codex` when Codex isn't installed. |
| `send` | Starts a turn, or, during one, goes into it for Codex to read between its steps (`lane: "next"`, or none). `later` is held by the helper until the turn ends. A stored session is loaded by its first message. A picture goes as an image, and any other file by its path at the head of the text. A line that starts with `!` is run in your shell. See below. |
| `interrupt` | Stops the turn |
| `join`, `history` | The same replies, read from Codex's stored turns a few at a time, so a page is whole turns. `before` is a number the helper gives out, good until it restarts. |
| `capabilities` | `models` from Codex's own list, each with its `effortLevels`. `commands` are the few of its terminal's that the helper carries out, and `skills` those a `$` names: see below. |
| `configure` | `model` and `effort` take hold from the session's next turn, and `session.model` and `session.effort` say so at once |
| `setMode` | One of Codex's three choices of what it may do without asking, from the session's next turn, or `plan`, at once. See [Permission modes](#permission-modes). |
| `respond` | Answers Codex. See below. |
| `delete` | Stops a turn going on, and has Codex delete the thread for good |

Codex's slash commands are its terminal's own doing, and its server lists none. Six of them are things the server can do, so `capabilities` lists those, named and described as the terminal has them, and `send` with one as its line carries it out instead of saying it to Codex: `/compact` has Codex summarize the conversation, told as `compact.start` and `compact.end` with `trigger: "manual"`; `/review` starts a review of what has changed in the folder, or with words after it, a review of what they say, which comes as a turn Codex opens with a message of its own, told as `message.user` with the `clientId` of the send that asked for it; `/init` is a message, in the words the terminal sends for it; `/rename <name>` names the thread; `/fork` makes another chat of this one, which is a session from then, told as `session.started`; and `/archive` puts the chat away in Codex, so it leaves the list, told as `session.deleted`. `/compact`, `/rename`, `/fork` and `/archive` aren't echoed as `message.user`, and `/init` is, with the words the terminal sends. Codex keeps a chat while a fork of it is kept, and a fork nothing was said in is in none of its lists: `delete` of such a chat fails with `session_forked` and says to delete the fork first. Asked to delete, Codex closes the chat even when it refuses. The first two wait for a turn to end, as in the terminal: until then, and whenever Codex won't, `send` fails with `command_failed` and a message for the reader. Any other line that starts with a slash, as a path does, is a message like any other.

A `$` names a skill in a message to Codex, as in its terminal. `capabilities` lists the session's folder's `skills`, each `{name, description}`: the ones Codex has on there, with the short line that says what each is for. They're Codex's to list, asked for once in a few minutes. A message is sent as it's written, and each `$name` in it that is one of those skills goes to Codex with the message, by its name and where it is, as the terminal sends one. A `$` in the middle of a word, as in a shell variable or a price, names nothing, and neither does a name that's no skill's.

A Codex session has no terminal of its own, where every Claude Code session is in one. So a session the helper starts or loads is opened in Codex's terminal at the Mac, in Rex or tmux as a resumed Claude Code session is, once it has a turn: `codex --remote` on the server's socket, resuming the thread, which makes the terminal another client of the same thread. It takes the thread as it is: Codex refuses a sandbox or an approval policy given with a thread joined this way, and joining changes neither. Nothing is pressed in it: what it asks when it starts, as about an update, is for whoever is at the Mac. A session started from Codex's own app or terminal gets none, and `VENES_CODEX_TERMINAL=off` turns this off.

`statusLine` gives a `status` in the shape Claude Code's has, from what Codex's server says itself, since Codex has no status line: `model`, `effort`, `project`, `branch`, `context` after the last reply (`percent`, `used`, `size`), and the account's `fiveHour` and `sevenDay` limits, each `percent` and `resetsAt`. Past those it has what the account has past its plan: `credits` with the `balance` left, or `unlimited`, for an account that has credits; `limitResets`, the resets of its limits it has been given and hasn't used, each with Codex's own `title` for it and when it `expiresAt`; and `limits`, for any limit Codex meters apart from the plan's own, by the name Codex gives it.

`page`, `pageKey`, `pageText`, `pageClose`, `image` and `taskOutput` have nothing for a Codex session: there's no terminal.

**Events.** `session.started` has `source: "startup"` for a new thread and `"resume"` for a stored one that's loaded. `message.user` has the send's `clientId`, and none for a message typed in Codex's own terminal. `message.assistant.delta` has Codex's `phase` beside the rest, `commentary` for what it says between steps and `final_answer` for its reply, and ends with one that has `final: true` and no text. `message.thinking` is a reasoning item's summary. A turn ends with `turn.end`, `turn.interrupted`, or `turn.error`, whose `error` is Codex's message and `details` its own code for it, such as `usageLimitExceeded`.

Everything else Codex does is a `tool.start` and a `tool.end`, named after the kind of item it is in Codex's protocol: `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `webSearch`, `imageView`, `imageGeneration`, `collabAgentToolCall`, `sleep` and so on. `toolUseId` is the item's id, `input` is the item as Codex first gave it, and `response` is the item once it's done, with all it has by then: a command's `aggregatedOutput` and `exitCode`, a file change's `changes`. `isError` is set for one that `failed` or was `declined`. History's `tool` items have the stored item as both `input` and `result`. Codex's notes of a subagent starting and stopping (`subAgentActivity`) aren't sent: its calls to the subagent say as much.

A line that starts with `!` is your own command, as in Codex's terminal: `send` has Codex run it in your shell, outside its sandbox and with no approval asked. It comes back as it does for Claude Code, and so does one typed with `!` at Codex's terminal: `message.user` with `shell: true` and the line as typed, with the send's `clientId` when it came from one, then `message.output` with what it printed in `stdout`, `stderr` empty, and `replies`. Codex doesn't answer a line run by itself, so `replies` is false, the session is never `running` for it, and no `turn.end` follows. One run during a turn is taken in by that turn's reply, and has `replies: true`. In history it's a `user` item with `shell: true` and an `output` item, as for Claude Code.

`plan.updated` is Codex's plan as it stands, whole each time: `explanation`, and `plan`, a list of `{step, status}` with a status of `pending`, `inProgress` or `completed`. That's its checklist of what it's doing, which isn't Plan mode.

A plan written in Plan mode is a `tool.start` and a `tool.end` named `ExitPlanMode`, Claude Code's call for the same thing, with the plan in `input.plan`: once, when the plan is whole. History has it as a `tool` item of that name.

**Requests.** Codex asks every client of a thread, and takes the first answer. Answered somewhere else, a request closes with `by: "terminal"`.

| `request.kind` | From | To answer |
|---|---|---|
| `permission`, `toolName` `commandExecution` or `fileChange` | Codex asking to run a command or change files. `input` is what Codex sent: `command`, `cwd`, `reason`, `commandActions`, and for a file change its `changes`. `options` are its other ways of saying yes, in the words of its own terminal, such as "Yes, and don't ask again for commands that start with …". | `allow` is its plain yes, and `allow` with `option` one of those. `deny` stops the turn, as "No, and tell Codex what to do differently" does in its terminal, and a `message` with it is sent as the next message once the turn has stopped. |
| `permission`, `toolName` `permissions` | Codex asking for more room than its sandbox gives. `input.permissions` is what it wants. | `allow` grants it for the turn, and with `option: "session"` for the session. `deny` grants nothing, and the turn goes on. |
| `question` | Codex's questions, in the shape Claude Code's have: `input.questions`, each with `question`, `header`, `options` and `multiSelect: false`, and Codex's own `id`, `isOther` and `isSecret` | `allow` with `answers` by each question's text, as for Claude Code |
| `plan`, `toolName` `ExitPlanMode` | The helper, once a turn in Plan mode has ended on a plan, as Codex's terminal asks then: "Implement this plan?". `input.plan` is the plan, and `options` has the terminal's first way on, `implement`, "Yes, implement this plan". | `allow`, with that `option` or none, stops the planning and sends Codex its terminal's words for it, "Implement the plan.". `deny` goes on planning, and a `message` with it, what to change, is sent as the next message. |

A plan's request stays open while the session rests, which is `waiting` meanwhile. A client that joins then has the request in `requests`, and the turn that wrote the plan in `items`, whole, once it's history. It closes with `by: "terminal"` when a turn starts some other way, as from Codex's terminal, or when the planning is stopped. The terminal's other way on, a new thread with the plan, isn't offered.

Codex's own terminal at the Mac, which the helper opens on a session, is another client of the thread and asks about the plan by itself, and it goes on asking whatever another client does with the plan. So an answer from a client is acted on only after that question is put away there: the helper presses the question's own row for leaving things as they are, "No, stay in Plan mode", in the terminal it opened on the thread (`venes-codex-` and the start of the id). It does that only when the question is what the terminal shows, read off its screen, since a key pressed on anything else would be typed into it. With no such terminal, or with the question answered there already, nothing is pressed.

**What it doesn't do yet.** A plan carried out in a new thread, a plan's text as it's written, a subagent's own tool calls (its `collabAgentToolCall` is one tool call), and a list of commands left running.

### Antigravity sessions

Google's Antigravity has a command line, `agy`, and a session of it runs in a terminal, as a Claude Code session does: in Rex or tmux at the Mac, where you can go on with it yourself. The helper follows one the way it follows Claude Code. When it starts, it puts a plugin of its own where Antigravity looks for the plugins of every project, `~/.gemini/config/plugins/venes`, on a Mac that has `~/.gemini`. The plugin's hooks hand each event to the helper: a session's start, each call to the model, each tool's end, and the turn's end. What was said is read from the transcript Antigravity keeps of each conversation, which a hook names. So a session you start yourself with `agy` in Rex or tmux is followed too, once the plugin is there, and can be typed into from a client. One started in any other terminal is followed and only read. `venes uninstall` takes the plugin away again.

No hook is asked whether a tool may run. A hook asked that has to answer, and one that couldn't would stop every call in every session, so the helper leaves the question to Antigravity and reads the answer's prompt off the screen instead.

A client says it can show these with `agents: ["antigravity"]`, as it does for Codex's, and gets none of them otherwise. Each says whose it is, with `agent: "antigravity"`, wherever a Codex session says `codex`. `folders` says `antigravity: true` on a Mac that has `agy`.

What a session does is told in the shapes a Claude Code session's are, so that a client which shows those shows these with nothing new to learn. A call's `name` and `input` are a Claude Code call's of its kind: a file read is `Read` with its `file_path`, a command `Bash` with its `command` and `description`, a change `Edit` with `old_string` and `new_string` or `Write` with `content`, and anything else goes by Antigravity's own name for it with what it was given. A call's `toolUseId` is `step-` and the number of its step in the transcript. A reply comes whole when Antigravity has written it, as one `message.assistant.delta` and its `final`, and what it thought as `message.thinking`. The modes go by Claude Code's names: `default`, `acceptEdits`, `auto` and `plan`.

| Command | For an Antigravity session |
|---|---|
| `start` | With `agent: "antigravity"`: a new conversation in `cwd`, in a terminal of its own. A conversation has no id until its first message, so an empty one is made first through Antigravity's own protocol server (`agy acp`), which says its id and is let go, and the terminal is opened on that: `agy --conversation <id>`. Antigravity asks about a folder it doesn't trust yet, as Claude Code does: `needs_trust` unless `trust: true`, which answers its question in the terminal. |
| `page`, `pageKey`, `pageText`, `pageClose` | As for a Claude Code session: a command of the terminal's own that opens a list there, as `/model` does, is left open for a client that sent `pages: true`, whose `send` is told `page: true`, and is closed again and refused with `terminal_only` for any other. The page is from the rule it opened under to the line that says how to move in it. |
| `send` | Typed into the terminal, with any attached file named by its path at the head of the text. The terminal's box is emptied first of anything typed in it, as for a Claude Code session, and so it is before a command of the helper's own is typed there. During a turn, or while a request is open, it's held and goes when that's over. A stored session is opened in a terminal again by its first message. A session with no terminal the helper can reach fails with `no_pane`, and a dialog open in the terminal with `dialog_open`. |
| `interrupt` | Esc in the terminal: on a prompt it says no, and in a turn it stops it |
| `join`, `history` | Read from the conversation's transcript, a page being whole turns |
| `capabilities` | `models` from `agy models`, each with its `effortLevels`. `commands` are the ones Antigravity's own protocol server (`agy acp`) lists for a session in the folder, skills among them, each with its `description` and `argumentHint`: asked once for a folder and kept ten minutes, since asking makes an empty conversation, which is taken away again. None is written down in the helper. The terminal's own commands, as `/model`, aren't in that list. |
| `configure` | `/model` and `/effort` typed in the terminal, between turns. A model picked by itself keeps how hard the session thinks, or the nearest to it the model can. Antigravity keeps the choice for the sessions started after, as it does one made at the Mac. |
| `setMode` | Shift+Tab in the terminal until its bar names the mode, between turns |
| `respond` | Presses the prompt's row in the terminal. See below. |
| `delete` | Deletes the conversation as Antigravity's own picker does (F4 in `/resume`): its file in `conversations`, its folder in `brain` with the transcript and what it made, its notes in `annotations`, and its rows in Antigravity's summary and search (`conversation_summaries.db`). The files go to the Trash, in one folder named `Antigravity session` and the start of its id, and are deleted for good on a Mac with no `/usr/bin/trash`. An Antigravity that has it open in a terminal the helper can reach is told to go first, or it would write the conversation back, and one that won't go fails with `session_running` and nothing deleted. |

Three things a hook doesn't tell are read off the terminal's screen, which is looked at every 0.7 s while a turn goes on, and for a few seconds after it:

- **A prompt to allow a tool.** Antigravity draws it and waits. Once it reads the same twice it's a `permission` request, with the call it's about and, as `options`, its rows past Yes and before No, each `{id, label}` in Antigravity's words, such as always allowing commands that start the same way. `respond` presses a row as a person at the Mac would: the first for `allow`, the last for `deny`, and an option's own for `option`. One answered at the Mac closes with `by: "terminal"`.
- **A turn stopped with Esc.** Nothing is told of its end, so a turn is taken as stopped, with `turn.interrupted`, once the terminal has twice been seen waiting for a message with no hook since.
- **A plan that waits to be looked over.** In plan mode Antigravity writes its plan as a document of its own (`implementation_plan.md`, in the conversation's folder), marked as one to look over first, then ends the turn and says so in a line over its box: "1 artifact · /artifact to review". Nothing opens, and the plan is answered in the panel that command opens, with `y` or `n`. The helper tells the call that wrote it as `ExitPlanMode`, with the plan in `input.plan`, in the turn and in history. And once the session is at rest with that line showing, it asks about the last such document that nothing has been said since, as a `plan` request: `input.plan`, and `options` with Antigravity's word for yes, `approve`, "Approve". `allow` opens the panel in the terminal (`/artifact`) and presses `y` for each document that waits, which Antigravity takes as it does at the Mac: "[Approved] implementation_plan.md" is the next thing said, and it goes on, still in plan mode. `deny` with a `message` types the message, what to change, which Antigravity plans again from. `deny` with none presses `n` in the panel, "[Rejected] implementation_plan.md". The request stays open while the session rests, which is `waiting` meanwhile and looked at every half minute. It closes with `by: "terminal"` when a turn starts some other way, or the line has gone. A message can be sent past it and the mode switched, as at the Mac. A helper that starts again asks about it again.

The bar at the foot of the terminal says the session's mode, its model and how hard it thinks. A hook says the last two only once something is said, and the mode never, so a session's are read off the bar when its terminal opens and each time it's looked at between turns, and told with `session.mode`, `session.model` and `session.effort`. That's also how a change made at the Mac is told. The bar has a model's name where a hook has its id, so the model is told once the models `agy models` lists are known, which `capabilities` and `start` ask for.

A session ends, with `reason: "closed"`, when its terminal has gone, or shows something other than Antigravity and says it's running something else, which is checked every half minute while it's at rest. Another conversation in the same terminal, as after `/clear`, ends the one before it with `replaced`. One that turns up there while a turn is going on is a conversation Antigravity started itself to help with that turn, and isn't a session of its own.

A turn Antigravity goes on with by itself, as when a command it left running ends, starts with no `message.user`: nothing new was said.

In plan mode Antigravity puts its own command before what's typed, and keeps and shows the message that way: "/plan " and the words. `message.user` and history have the words, and a message sent from a client is still known for that client's, with its `clientId`.

When the helper starts again, a session whose terminal still runs Antigravity is still a session, as a Claude Code one whose terminal still runs Claude is. And a message for a conversation the helper doesn't follow goes to the terminal it opened on that conversation before, where that's still open with Antigravity in it (a window labelled `venes-agy-` and the start of its id), so that there's never a second Antigravity on one conversation.

- `library` lists the conversations Antigravity has stored that have something said in them, newest first, with the first page, from Antigravity's own summary of them (`~/.gemini/antigravity-cli/conversation_summaries.db`, read with `/usr/bin/sqlite3`, and written only to take a deleted conversation's rows out). Whether a session is Antigravity's is told by its file in `~/.gemini/antigravity-cli/conversations`, and one whose file has gone isn't listed, whatever the summary says.
- `statusLine` gives `model`, `effort`, `project`, and the account's `limits`: every one Antigravity's own `/usage` lists. Its models share limits in groups, each with a limit for the week and one for five hours, or one of the two, so each is told by its group's `name` and its `window`, with the `percent` used, where Antigravity says how much is left, and when it `resetsAt`. They're asked of the command line itself, `agy -p /usage --output-format json`, which says nothing to a model and makes no conversation. That takes several seconds, so it's asked at most every three minutes, and a first `statusLine` can come before it.
- Its pictures are told as a Claude Code session's are, in `history` and `join` and with `tool.images` and `message.images`. A call that looked at a picture, or made one, has it as a file among the conversation's own (`media` in its step, under the conversation's `logs/media`), and that's the call's picture: only a file inside Antigravity's own folders is one. A message's are the files its first lines name, where each is a picture that's there, which is how a client's attached pictures are typed, and its words are then told without those lines. `image` reads one where its step says it is, so it's `unknown_image` once the file has gone, and for one bigger than 20 MB.
- `page`, `pageKey`, `pageText`, `pageClose` and `taskOutput` have nothing for an Antigravity session.
- Antigravity's hooks are the same in its desktop app, which reads the same plugin folder, so a conversation there would be followed and read. The desktop app wasn't on the Mac this was made on, so that's untried.

### What was used

`usage` is the account's, and needs no session. The tokens are the agents' own counts: Claude Code writes what each request used with the reply in a session's transcript, a subagent's in a file of its own, Codex writes a record with each response in a thread's rollout, and Antigravity keeps a row for each response in the conversation's database, read with `sqlite3`, and the time of each in the row of its step. A request is counted once, by its last word on what it used, however many lines of a transcript repeat it. A day is a day where the client is, when it says its time zone, since the one reading may be hours from the computer, and a day where the computer is otherwise. Each zone asked for has its own count kept (`~/.venes/usage.json` for the computer's own, `usage.<zone>.json` beside it for another's), read on from where it was, and another zone's count that nobody has asked for in a month goes.

The cost is what those tokens would cost bought by the token: each request's, by its model's price for each kind of token in [LiteLLM's public list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), a request over the size from which a maker charges more charged so whole. A Codex thread set to one of its fast modes (`priority`, `ultrafast`) is charged at that tier's prices from then, as the maker charges for them. A request written over several lines of a transcript comes to the most each kind of its tokens is said to be on any of them. It's an estimate at public prices and nobody's bill, least of all a plan's. A model the list doesn't have costs nothing here, and its tokens are told as `unpriced`.

What was counted of a chat stays counted when the chat is deleted, for the days it was used on.

A chat is read once and then only where it has grown, one of Antigravity's whole again when it has changed, in a process of its own, and a read that takes longer than a few seconds answers with what it has and `scanning: true`; the next goes on from there, newest chats first. Replies within half a minute of each other are the same reply.

The limits are those each agent last said: Claude Code's asked of it as `/usage` asks, by a session that's given nothing to do, at most every few minutes, and until that's back as it last told any session's status line, with `scanning` true; Codex's from its server where it's running and otherwise as it last wrote them down with a count, and Antigravity's from `agy -p /usage`, at most every few minutes. Codex isn't started to be asked.

### Files and git

A session's folder can be looked at from afar, for a Claude Code session and a Codex one alike: a session the helper follows by where it is now, and a stored one by where it ran. Most of it is read. Three commands change what's in the folder: `fileCreate` makes something new and empty, `fileWrite` gives a text file new text, and `fileDelete` moves a file or a folder to the Trash. The four at the end change the repository: what the next commit takes, the commit, and the branch. Nothing is written over without the client saying so, and nothing is deleted for good.

`files` lists a folder: the session's own with no `path`, or one inside it, named whole or from the session's folder. A path that leads out of the session's folder is refused with `bad_path`. The reply has `root`, the session's folder, the `path` and `name` of the one listed, and `entries`: folders first, then files, each by name as Finder sorts them, up to 2,000 with `truncated` past that. An entry has its `name`, its `path`, its `kind`, `dir` or `file`, and a file's `size`. A link is what it leads to. `.git` and `.DS_Store` are left out, and other hidden files are there. Inside a git repository an entry that has changed has `change`: a file what happened to it, as in `git` below, and a folder `changed` when something inside it has.

`fileRead` gives a file's `path`, `name` and `size`, when it last changed as `modifiedAt` in milliseconds, and what's in it. A text file comes as `text`, up to 512 KB of it, cut at a line's end with `truncated` when it's longer. Anything else comes with its `mediaType`, by its name, and its bytes in base64 as `data`, for a client to show as the picture or document it is, or with `tooLarge` and no `data` past 8 MB.

A session moves about as it works, so its repository isn't only the one it's in at the moment: the helper keeps where it started and the folders it has worked in, and a git command is for one of the `repositories` found from those. Where it started is the project folder Claude Code tells its status line, when it has, since the helper may have met the session part way through; folders added to the session are counted with those it has worked in. They're listed with `git`, each `{root, name}`: the one it's in now first, then those it has been in, the latest first, then the one it started in, and for a session that started in no repository, those right inside where it started, by name. Every git command takes a `root`, one of these, and with none named is for the first. Anything else is refused with `bad_repository`. A client that shows one repository over several commands names it each time, since the first can change as the session moves.

`fileChunk` gives a file a piece at a time, for a reader that takes it whole whatever its size and whatever is in it, where `fileRead` is for showing it. A piece is `length` bytes from `offset`, in base64 as `data`, and at most 1 MB however much is asked for, so that no more than that is held at once anywhere on the way. Each piece comes with the file's `size`, its `mediaType` and `modifiedAt` in milliseconds, so a reader asks from 0 on until it has `size` bytes, and can tell a file that changed between two pieces by either having changed. A piece that starts at the file's end has nothing in it, and one past it is refused with `bad_range`.

`fileCreate` makes an empty file named `name`, or with `folder: true` a folder, in the session's folder, or in the one inside it that `path` names as `files` takes it. The reply is the new entry as `files` lists one: its `name`, `path` and `kind`, and a file's `size`, 0. A name is checked as `folderCreate` checks one, and one that's taken is refused with `name_taken`, so nothing that's there is written over. A `path` that leads out of the session's folder, by its name or through a link, is refused with `bad_path`. In a repository the session's `changes` are counted again after, as they are after a write and a delete.

`fileWrite` writes `text` as a file's whole contents, in UTF-8 and up to 1 MB, for a client that lets its reader edit a file. The file has to be there, be text as `fileRead` tells text, and be really inside the session's folder, wherever a link leads. So that nothing a session wrote in the meantime is lost, the client sends what the file was when it read it, `was: {size, modifiedAt}` from `fileRead`, and a file that's something else by now is refused with `file_changed` and left as it is. The reader can then be asked, and `overwrite: true` writes all the same. It's written where it is, so it keeps its mode and its links. The reply has its `path` and `name`, and its `size` and `modifiedAt` now, which the next write goes by. Nothing inside `.git` is written.

`files`, `fileRead`, `fileChunk`, `fileWrite` and `fileDelete` also work with no `sessionId`, for a client whose reader is choosing where a session starts and looks about the Mac as it would about a session's folder. The `path` is whole then, since there's no folder for it to be from, and anything else is refused with `bad_path`. What `files` lists is as for a session, by what git says of that folder, with two differences: entries whose names start with a dot are left out unless `hidden` is true, as Finder leaves them out, and the reply says whether Claude Code trusts the folder, as `trusted`. `.git` is left alone here too. A helper before 0.18.0 answers these with `unknown_session`.

`fileDelete` moves a file, or a folder with all that's in it, to the Trash, as Finder's Move to Trash does, so it can be put back from there. That's macOS's own `/usr/bin/trash`, which is there from macOS 15, and a Mac without it refuses with `no_trash`. A link goes as the link it is, and what it leads to stays. The session's own folder, `.git`, your home folder with all that's above it, and anything that isn't really inside the session's folder are refused with `bad_path`, something that's gone with `no_file`, and something the Trash wouldn't take with `trash_failed`.

`git` is null for a session with no repository. In one, it has the repository's `root`, the `branch`, or the start of the commit with `detached: true` when none is checked out, the `upstream` it follows with how many commits it's `ahead` and `behind`, and two lists of files: `staged`, what the next commit would take, and `changes`, what's only in the folder. Each file has its `path` from the repository's top, a `status` of `modified`, `added`, `deleted`, `renamed` (with `from`), `copied`, `untracked` or `conflicted`, and the lines it gained and lost as `added` and `removed`, or `binary`. A file can be in both lists. Each lists up to 500, with `truncated` past that. The helper asks git without taking the index's lock, so it never gets in the way of the session's own git.

How much has changed in a session's repository comes with the session, for a client to say in a line without opening the status: `changes` in `sessions`, a snapshot and `join`, as `{files, added, removed}`, or `null` when nothing has changed or the session has no repository. The key is always there, so that a client that joins again drops what it showed before. It's counted from what `git` lists, staged and not, so the two agree: each file once, and the lines they all gained and lost, a file that isn't text counting as a file with none. It's for the first of the session's `repositories`, the one `git` tells of when none is named. A `session.changes` event has the same three numbers whenever they change, with `files: 0` when nothing is left: the helper counts again a moment after a tool ends, a turn ends, a line for the shell prints, and one of the commands here that change the repository, and `join` counts before it answers, waiting at most a second and a half for git.

`gitDiff` gives one file's change as `diff`: what `git diff` prints from the first `@@` line on, without git's own header. With `staged` it's what's staged, with `commit` what that commit did to the file, and otherwise what's only in the folder, which for a file git doesn't follow yet is all of it. A file that isn't text has `binary` and an empty `diff`. Past 512 KB it's cut at a line's end, with `truncated`.

`gitLog` lists the commits that lead to where the folder is: each `hash`, its `short` form, `subject`, `author`, `at`, its `parents`, which are two or more for a merge, and its `refs`, the names that point at it. A ref is `{name, kind}`, where `kind` is `head` for the branch the folder is on (named `HEAD` when none is checked out), `branch` for another of the repository's, `remote` for a remote's, and `tag`. With `all: true` the commits of every branch, remote branch and tag are listed too. No commit comes before one that came from it, and a line of history stays together, so a graph can be drawn from the list as it comes. `limit` is 30 unless given, up to 200, and `skip` and `hasMore` page through them. `gitCommit` gives one, by its hash or the start of it: the same with its `body`, the author's `email` and its `parents`, and the `files` it changed, as `git` lists them. A merge is told against its first parent. `gitBranches` lists the local `branches`: each `name`, whether it's the `current` one, its `upstream` with `ahead` and `behind`, and the `at` and `subject` of its last commit.

`gitStage` puts changes in the next commit and `gitUnstage` takes them back out, leaving the folder as it is: the files in `paths`, each from the repository's top as `git` lists them, or everything with `all: true`. A file that's gone from the folder is staged as gone. A renamed file is two paths to git, the one it had and the one it has, so both are named to unstage it. Names are taken as they are, with none of git's patterns read into them. `gitCommitStaged` commits what's staged with `message`, as whoever git is set up for on the Mac, and runs the repository's hooks. With nothing staged it fails with `nothing_staged`. `gitSwitch` moves the folder to `branch`, one of the local branches. When git won't do one of these, such as a hook that refuses a commit or a switch that would write over changes in the folder, the command fails with `git_failed` and the message is what git said.

### Notifications

A phone that isn't connected hears when a session asks for something (`request.opened`) and when a turn ends (`turn.end`). A phone that's connected is left to show its own. The phone sends `pushRegister` with its own `deviceId`, its push `token` in hex, a `key` of 32 bytes in base64, `sandbox` for a development build, and `mac`, its own name for this Mac, which comes back in each notification. The connection it sends that on counts as that phone's, so while the connection is open, nothing is pushed to it. Phones are kept in `push.json` in the helper's folder, readable only by you.

What a notification says is sealed with the phone's key, with AES-256-GCM: the JSON `{kind, session, title, body, mac}`, where `kind` is `needsInput` or `finished`, `title` is the session's name as the app lists it, and `body` is the start of what Claude said last, or empty, for the phone to say in its own words. It goes to the relay at `venes-push.kirass1230.workers.dev`, or `VENES_PUSH_URL`, as `{token, sandbox, collapseId, payload}`. The relay holds the key Apple's push service wants and passes the notification on, and can't read it. The payload's `aps` has `mutable-content`, so the app opens the seal before the notification shows, and a localized line in case it can't. A token Apple no longer takes is forgotten.

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

Images stay out of pages and events, because a page can have dozens of them. `history` and `join` items with the role `user` or `tool` can have `images`, each `{id, mediaType, bytes}` and its `width` and `height` in pixels as it shows, where its PNG, JPEG, GIF or WebP header tells, and `image` fetches one when given that `id` as `imageId`, with `unknown_image` if the transcript no longer has it. An image's `id` only means something to `image`, and calls made by a subagent have none.

During a turn, `tool.images` and `message.images` say the same. They come from the transcript, so they can arrive after what they belong to. `tool.end.response` doesn't carry the image itself: its base64 is left out, and the rest stays.

An Antigravity session's are told the same way too: see [Antigravity sessions](#antigravity-sessions).

A Codex session's pictures are told the same way: those a message came with, the one Codex looked at (`imageView`) or made (`imageGeneration`), and those an MCP or a dynamic tool gave back. One that's a file on this Mac is read where it is when it's asked for, so it's left out once the file has gone, as is one bigger than 20 MB, and a picture named by an address on the web isn't fetched. The helper keeps where the latest 200 pictures of a session are, from the pages and events that told of them, and `image` answers `unknown_image` for any other.

### Published pages

A page a session publishes with Claude Code's Artifact tool is private on claude.ai to the account that published it, so a client that isn't signed in there has only a link. The page is made from a file on this Mac, and `artifact` gives that file: `{sessionId, toolUseId}`, the id of the Artifact call, answers `{text}`, the file's text. The helper finds the file from the call in the session's transcript, the path Claude Code kept with the call's result or else the one the call was given, and takes no path from the client, so a client can have only what a session published. A call of any other tool, or an id the transcript doesn't have, is `unknown_artifact`. A file that's gone is `artifact_gone`, one that isn't UTF-8 text `artifact_not_text`, and one over 16 MB, which is the most claude.ai takes for a page, `artifact_too_big`.

In `history`, an Artifact call's item has `page`: the `url` on claude.ai, the `path` of the file and the `title`, as Claude Code kept them with the result, whose printed text has no title. A live call has the same in `tool.end`'s `response`.

### Attachments

A message can come with pictures, videos and files: `upload` each one, then `send` their `uploadId`s as `attachments`, in the order they should go. `text` can then be empty. An upload is kept for its session, so `send` has to name the same `sessionId`.

Uploads go in the Mac's Downloads folder, as anything else it's sent does, numbered the way Finder numbers a copy when the name is taken. They stay there when their session is deleted: what the helper forgets is which session they were for, then and after 30 days. A Mac that won't let the helper write in Downloads gets them in `~/.venes/uploads` instead.

A file taken back out of the composer before its message went is no one's yet, so `discard` it: its file goes from Downloads too, and `discarded` says so. A file a message has, or one moved or changed since it came, stays, and so does one the helper got before 0.3.44, which it can't tell from one changed since. A message taken back with `cancel` before it went gives its files back to the composer, to take out the same way.

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

#### The screen

A client can show this Mac's screen through macOS's own Screen Sharing, a VNC server on port 5900, which the reader turns on in System Settings › General › Sharing. `screen` says where it is: `hosts` holds this Mac's own address on its tailnet while its Tailscale is on, which the client reaches straight, with no SSH and so with Remote Login off too; `on` is whether Screen Sharing answers; `user` is the account it signs in, with that account's password. With `hosts` empty, or an older helper, a client goes through SSH as files do, to port 5900 on this Mac's loopback. Rex's built-in Tailscale is no use here either, as only Rex answers there.

Screen Sharing sends all of this Mac's displays as one picture, laid out as they are in System Settings › Displays. `displays` says where each one is: `x`, `y`, `width` and `height` in points, from the top left of the rectangle around them all, left to right, and `id`, its CGDirectDisplayID. The picture has each display at its own pixels, so a client that shows one at a time asks Screen Sharing for that one with Apple's SetDisplay message (type 13: a byte to combine all displays, two of padding, and the `id` as a big-endian 32-bit number). It's empty when AppKit can't be asked, as when no one is logged in at the Mac.

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

`decision` is `allow` or `deny`. A deny reaches Claude in the words Claude Code's terminal uses. With a `message`, that's what to do instead, and Claude carries on from it. Without one, Claude is told to stop and wait, and the turn stops, as it does for Esc in the terminal. A subagent is told the way the terminal tells one, and its turn goes on.

| `request.kind` | What to show | To approve |
|---|---|---|
| `permission` | `toolName`, `input`, `permissionSuggestions`, `options` | `allow`, with `always: true` to not be asked again, or with `option` set to the `id` of one of its `options` |
| `question` | `input.questions` | `allow` with `answers`, mapping each question's text to the chosen label (join multi-select labels with commas) |
| `plan` | `input.plan`, `options` | `allow`, with `option` set to the `id` of the one picked |

The same prompt is open in the terminal at the same time, and the first answer wins. `request_closed` means the terminal got there first.

A `permission`'s `options` are the rows its prompt shows in the terminal between Yes and No, such as switching to auto mode, in the terminal's words: each an `id` and a `label`. They depend on the tool, the mode and the account, and Claude Code doesn't tell a hook them, so they're read off the screen once the prompt shows there, and a `request.updated` brings them. A request on its own in a session in Rex or tmux gets them. Picking one presses that row in the terminal, so Claude Code does what it does for that row there. `prompt_changed` means the terminal no longer shows it. Without `options`, `always: true` is the way not to be asked again.

A `plan`'s `options` are the ways on that Claude Code's terminal offers under a plan, in its order and its words: each an `id`, the mode the session switches to, and a `label`. The first is `bypassPermissions` if the session has been seen bypassing permissions, else `auto` if it has been seen in auto mode, else `acceptEdits`. Then comes `default`, asking for each edit. Claude Code doesn't tell a hook which modes it offers, so a mode the session hasn't been in isn't offered. The terminal's rows that clear the context or go to Ultraplan aren't there, because a hook can't do either. To keep planning, deny with what to change as the `message`.

Approving a `plan` with an `option` switches to that mode. Approving it without one leaves plan mode for the mode the session was last seen in before it started planning. Left to itself, Claude Code can switch to `acceptEdits`, which `Shift+Tab` passes through on the way to plan mode. For a session that was planning from its first hook, Claude Code picks the mode.

`always` saves the rules in `permissionSuggestions`, usually to the project's `.claude/settings.local.json`. Show them before offering it. The list holds only rules: Claude Code also suggests switching the whole session to `acceptEdits`, which is more than "don't ask again for this", so those suggestions aren't passed on. If the list is empty, `always` is refused with `nothing_to_remember`.

### Events

Each one looks like `{"type":"event","event":{"seq":…,"at":…,"sessionId":…,"kind":…}}`.

| `kind` | Fields |
|---|---|
| `session.discovered` | `cwd`, and `agent` for a session that isn't Claude Code's: `codex` |
| `session.started` | `source`, `model`, `cwd` |
| `session.attached` | `pane` |
| `session.status` | `status`: `idle`, `running`, `waiting` or `ended` |
| `session.mode` | `permissionMode`, `permissionModes` |
| `session.changes` | `files`, `added`, `removed`: how much has changed in its repository, `files: 0` for nothing |
| `session.model` | `model` |
| `session.effort` | `effort` |
| `session.ended` | `reason` (`replaced` after `/clear` or `/resume`) |
| `session.deleted` | |
| `message.user` | `text`, `clientId`, `attachments` (only when it has files), `shell` (only for a line run with `!`) |
| `message.output` | `stdout`, `stderr`, `replies`, `clientId`: what the line run with `!` before it printed |
| `message.assistant.delta` | `messageId`, `index`, `text`, `final`, `agentId`, and `phase` for a Codex session |
| `message.thinking` | `text`, `durationMs` |
| `tool.start` | `toolUseId`, `name`, `input`, `agentId`, `parentToolUseId` |
| `tool.end` | `toolUseId`, `name`, `response`, `durationMs`, `isError`, `interrupted`, `parentToolUseId` |
| `tool.images` | `toolUseId`, `images` |
| `message.images` | `images`, for the latest `message.user` |
| `request.opened` | `request` |
| `request.updated` | `request`, as it is now: so far, a `permission` with the `options` its prompt shows |
| `request.closed` | `requestId`, `decision`, `by` (`client`, `terminal`, `turn_end`, `session_end`) |
| `turn.end` | `lastMessage`, `backgroundTasks` (a count), `tasks` (those running) |
| `turn.interrupted`, `turn.error` | `error`, `details` |
| `agent.start`, `agent.stop` | `agentId`, `agentType`, `parentToolUseId` (on start) |
| `task.created`, `task.completed` | `taskId`, `subject`: items on Claude's task list |
| `plan.updated` | `explanation`, `plan`: a Codex session's plan as it stands |
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
| `request_pending`, `dialog_open` | `send` or `configure` was refused because Enter would have answered an open prompt, or `start` found a dialog waiting in the new terminal for someone at the Mac |
| `box_not_empty` | `send` found something typed in a Claude Code session's input box that its keys wouldn't clear, so nothing was typed after it |
| `request_closed` | That request was already answered |
| `no_pane` | The session isn't in Rex or tmux, or started before the plugin was installed, so it can't be typed into until it's restarted |
| `resume_failed` | Claude Code quit, or took too long, resuming a stored session |
| `sdk_unavailable` | The Agent SDK couldn't be installed, so `library` has nothing to list. The next request tries again. |
| `no_tmux` | Neither Rex nor tmux is installed, so a stored session can't be resumed, or a new one started |
| `needs_choice` | Claude Code asks something with a list to pick from before a new session starts. `details` has its `title`, `text` and `options`. Ask the reader, and send `start` again with `choice` |
| `needs_trust` | Claude Code or Antigravity asks first whether to trust the folder, or Codex would trust it without asking. Ask the reader, and send `start` again with `trust: true`. |
| `no_codex` | Codex isn't installed, or its server wouldn't start, so a Codex session can't be started or opened |
| `no_antigravity` | Antigravity's `agy` isn't on the PATH, so an Antigravity session can't be started |
| `session_busy` | An Antigravity session's model, effort or mode was to change during a turn. They're changed in its terminal, between turns. |
| `session_elsewhere` | The Codex session is open in a terminal of its own at the Mac, which has to close it first |
| `send_failed` | Codex didn't take a message |
| `bad_agent` | `start` was asked for something other than Claude Code or Codex |
| `bad_path` | `files`, `fileRead`, `fileChunk`, `fileCreate`, `fileWrite`, `fileDelete`, `gitDiff`, `gitStage` or `gitUnstage` was given a path that leads out of the session's folder, or out of its repository, or no path at all |
| `no_file`, `unreadable_file` | `fileRead` or `fileChunk` was asked for a file that has gone, or one that can't be read. `fileWrite` and `fileDelete` say `no_file` too. |
| `file_changed` | `fileWrite` was given a file that isn't what it was when it was read, and wasn't told to write over it |
| `not_text`, `bad_text`, `too_big`, `unwritable_file` | `fileWrite` was given a file that isn't text, something other than text to write, more than 1 MB, or a file that can't be written |
| `no_trash`, `trash_failed` | `fileDelete` is on a Mac before macOS 15, or the Trash wouldn't take it |
| `bad_range` | `fileChunk` was asked for a piece that isn't part of the file |
| `unknown_artifact` | `artifact` was asked for a call that isn't an Artifact call in that session |
| `artifact_gone`, `artifact_not_text`, `artifact_too_big` | The file a page was published from has gone, isn't UTF-8 text, or is over 16 MB |
| `no_repository` | A git command was sent for a session that has no repository |
| `bad_repository` | A git command named a `root` that isn't one of the session's repositories |
| `bad_commit` | `gitCommit` or `gitDiff` was given something that isn't a commit of the repository |
| `git_failed` | Git wouldn't stage, unstage, commit or switch. The message is what it said. |
| `nothing_staged`, `bad_message` | `gitCommitStaged` was sent with nothing staged, or with no message |
| `no_branch` | `gitSwitch` was given something other than one of the repository's local branches |
| `start_failed` | Claude Code quit, or took too long, starting a new session |
| `bad_device` | `pushRegister` was given something other than a device id, a device token in hex, a 32-byte key or a Mac's name |
| `bad_folder`, `no_folder` | `folders`, `folderCreate`, `folderFileCreate` or `start` was given something other than an absolute path, or a folder that isn't on this Mac |
| `unreadable_folder` | `folders` couldn't read what's in that folder |
| `bad_name` | `folderCreate`, `folderFileCreate` or `fileCreate` was given a name a file or a folder can't have |
| `name_taken` | `folderCreate`, `folderFileCreate` or `fileCreate` was given a name that something there already has |
| `unwritable_folder` | `folderCreate`, `folderFileCreate` or `fileCreate` couldn't make anything in that folder |
| `no_claude` | Claude Code isn't on the PATH, so `capabilities` has nothing to ask |
| `session_running` | The session wouldn't stop, so `delete` left it alone |
| `background_session` | `delete` doesn't handle background sessions. Use `claude rm`, which has its own rules about their worktrees. |
| `bad_model`, `bad_effort` | `configure` was given something that isn't a model on offer or an effort level |
| `bad_mode` | `setMode` was given something other than a mode a session of its kind can be switched to |
| `mode_unavailable` | The session went all the way round its modes without coming to the one asked for, and is in the mode it was in. For a Codex session, Codex wouldn't start or stop planning |
| `command_failed` | A Codex session wouldn't carry out a slash command: the message says why, as that a turn is going on |
| `mode_failed` | The terminal didn't show the session's mode as expected, so it was left as it is. Claude Code's status bar may have changed. |
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
| `bad_option` | `option` isn't one of that request's `options` |
| `prompt_changed` | The terminal no longer shows the row `option` picked, so nothing was pressed |
| `unknown_task` | The helper hasn't seen that background task |

## Behaviour worth knowing

- **Permission mode is respected.** Prompts appear only when Claude Code would ask, so `bypassPermissions` shows no approvals. Questions and plans still appear.
- **What Claude Code asks is the reader's to answer.** A question it puts up in the terminal before a session starts or is back is shown to the reader, and nothing is pressed for them: see [Starting a session](#starting-a-session).
- **Models past the first five are under More models.** Claude Code's picker keeps them under a row of that name since 2.1.325, which the helper unfolds to reach one.
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
