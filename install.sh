#!/bin/sh
# Installs the Venes plugin into Claude Code.
#
#   curl -fsSL https://raw.githubusercontent.com/Lorpaves/venes-helper/main/install.sh | sh

set -eu

REPO="Lorpaves/venes-helper"
MIN_NODE=22

fail() {
  echo "venes: $1" >&2
  exit 1
}

command -v claude >/dev/null 2>&1 || fail "Claude Code is not installed. See https://code.claude.com/docs"
command -v node >/dev/null 2>&1 || fail "Node.js $MIN_NODE or later is required."

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge "$MIN_NODE" ] || fail "Node.js $MIN_NODE or later is required (found $(node -v))."

claude plugin install venes --marketplace "$REPO"

# The plugin sets itself up, with the launcher at ~/.venes/venes, as a session starts. That's done
# now too, so the app can be paired straight away.
plugin=$(claude plugin list --json 2>/dev/null | node -e '
  let text = "";
  process.stdin.on("data", chunk => { text += chunk; }).on("end", () => {
    try { console.log(JSON.parse(text).find(p => p.id === "venes@venes")?.installPath ?? ""); } catch {}
  });
' || true)
if [ -n "$plugin" ] && [ -f "$plugin/cli/venes.mjs" ] && node "$plugin/cli/venes.mjs" setup; then
  ready="Pair the app: ~/.venes/venes pair"
else
  ready="The helper starts with your next Claude Code session. Then pair the app: ~/.venes/venes pair"
fi

echo
echo "Venes is installed. $ready"
echo "Sessions that are open already need a restart, or /reload-plugins, to be seen."
command -v tmux >/dev/null 2>&1 || echo "Install tmux too: without it sessions can be watched and answered, but not typed into."
