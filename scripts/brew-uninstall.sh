#!/bin/sh
# Run by Homebrew as the cask goes. An upgrade or a reinstall runs it too, then installs Venes again
# straight away, so for those the helper only stops and paired phones stay paired.
launcher="${VENES_HOME:-$HOME/.venes}/venes"
# Homebrew runs this with a PATH of its own, without Claude Code, and keeps yours in HOMEBREW_PATH.
PATH="$PATH:${HOMEBREW_PATH:-}:$HOME/.local/bin:$HOME/.claude/local"
export PATH

# The brew command this runs under, from the processes above it.
pid=$PPID
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  case "$(ps -o args= -p "$pid" 2>/dev/null)" in
    *brew.rb\ upgrade*|*brew.rb\ reinstall*)
      if [ -x "$launcher" ]; then "$launcher" stop; fi
      exit 0
      ;;
  esac
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
done

if [ -x "$launcher" ]; then
  exec "$launcher" uninstall --yes
fi
# Never set up, so the plugin is all there is.
claude plugin uninstall venes@venes || true
claude plugin marketplace remove venes || true
