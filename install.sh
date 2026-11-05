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

echo
echo "Venes is installed. Start a new Claude Code session, or run /reload-plugins in an open one."
command -v tmux >/dev/null 2>&1 || echo "Install tmux too: without it sessions can be watched and answered, but not typed into."
