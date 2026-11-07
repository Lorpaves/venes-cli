#!/bin/sh
# Forwards one Claude Code hook event to the Venes helper. When the helper isn't
# running this prints nothing and exits 0, so Claude Code carries on as normal.

home="${VENES_HOME:-$HOME/.venes}"
root="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"

find_node() {
  command -v node && return
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
}

limit=4
case "$1" in
  hold) limit=86400 ;; # the terminal dialog stays usable while this waits
  session-start)
    # The plugin's path changes with each version, so the launcher is refreshed
    # here. Stdin is left alone: it holds the event that curl forwards below.
    node=$(find_node)
    if [ -n "$node" ]; then "$node" "$root/cli/venes.mjs" setup </dev/null >/dev/null 2>&1; fi
    ;;
esac

/usr/bin/curl -s --fail --max-time "$limit" --unix-socket "$home/hook.sock" \
  -H 'Content-Type: application/json' \
  -H "X-Venes-Pane: ${TMUX_PANE:-}" -H "X-Venes-Tmux: ${TMUX:-}" \
  -H "X-Venes-Rex-Block: ${REX_BLOCK:-}" -H "X-Venes-Rex-Session: ${REX_SESSION:-}" -H "X-Venes-Rex-Server: ${REX_SERVER:-}" \
  --data-binary @- http://venes/hook 2>/dev/null
exit 0
