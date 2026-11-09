#!/bin/sh
# Installs the Venes plugin into Claude Code, and starts it. Homebrew's cask runs it too.
#
#   curl -fsSL https://raw.githubusercontent.com/Lorpaves/venes-cli/main/install.sh | sh

set -eu

REPO="Lorpaves/venes-cli"
MIN_NODE=22

fail() {
  echo "venes: $1" >&2
  exit 1
}

# Homebrew runs this with a PATH of its own, and keeps the one you have in HOMEBREW_PATH. Claude
# Code's own installer puts it in ~/.local/bin.
PATH="$PATH:${HOMEBREW_PATH:-}:$HOME/.local/bin:$HOME/.claude/local"
export PATH

command -v claude >/dev/null 2>&1 || fail "Claude Code is not installed. See https://code.claude.com/docs"
command -v node >/dev/null 2>&1 || fail "Node.js $MIN_NODE or later is required."

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge "$MIN_NODE" ] || fail "Node.js $MIN_NODE or later is required (found $(node -v))."

installed() {
  claude plugin list --json 2>/dev/null | node -e '
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; }).on("end", () => {
      try { console.log(JSON.parse(text).find(p => p.id === "venes@venes")?.installPath ?? ""); } catch {}
    });
  ' || true
}

# Installed already, as on a reinstall, it's only started.
if [ -z "$(installed)" ]; then
  claude plugin install venes --marketplace "$REPO"
fi

# The plugin sets itself up, with the launcher at ~/.venes/venes, as a session starts. That's done
# now too, so the app can be paired straight away.
plugin=$(installed)
# Homebrew puts `venes` on the PATH; otherwise it's the launcher.
command="~/.venes/venes"
if [ -n "${HOMEBREW_PATH:-}" ]; then command="venes"; fi
if [ -n "$plugin" ] && [ -f "$plugin/cli/venes.mjs" ] && node "$plugin/cli/venes.mjs" setup; then
  ready="Pair the app: $command pair"
else
  ready="The helper starts with your next Claude Code session. Then pair the app: $command pair"
fi

echo
echo "Venes is installed. $ready"
echo "Sessions that are open already need a restart, or /reload-plugins, to be seen."
command -v tmux >/dev/null 2>&1 || echo "Install tmux too: without it sessions can be watched and answered, but not typed into."
