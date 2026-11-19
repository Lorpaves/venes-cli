# Venes: the marks a terminal session's shell writes. See src/shellmarks.mjs.
#
# One before each command runs, with the command, and one before each prompt, with how the command ended
# and where the shell is. The mark before a prompt goes first of what runs then, so that anything else
# the reader's setup prints before a prompt isn't taken for the command's output, and the one before a
# command goes last. Only this shell writes marks: what it starts isn't told how, and a shell started
# inside it is a program like any other.
[[ -n $VENES_TERMINAL_MARK && -z $_venes_hooked ]] || return 0
typeset -g _venes_hooked=1 _venes_mark=$VENES_TERMINAL_MARK _venes_tty=$TTY
typeset -gi _venes_seq=0
unset VENES_TERMINAL_MARK
# zsh marks a command that ended without a newline with a % before the prompt, which would read as the
# last thing the command printed.
PROMPT_EOL_MARK=''
# What a mark's words are written as: nothing in them may end the mark early, or be read by a terminal as
# anything else.
_venes_enc() {
  local s=${1//\%/%25}
  s=${s//$'\n'/%0A}; s=${s//$'\r'/%0D}; s=${s//$'\e'/%1B}; s=${s//$'\a'/%07}; s=${s//$'\t'/%09}
  REPLY=${s//[[:cntrl:]]/}
}
_venes_say() { print -rn -- $'\e]7773;'"$_venes_mark;$1"$'\a' >$_venes_tty 2>/dev/null }
_venes_precmd() {
  local code=$?
  _venes_enc "$PWD"
  _venes_say "P;$_venes_seq;$code;$REPLY"
}
_venes_preexec() {
  (( _venes_seq++ ))
  local line=${1:-$2}
  _venes_enc "${line[1,8192]}"
  _venes_say "C;$_venes_seq;$REPLY"
}
_venes_order() {
  precmd_functions=(_venes_precmd ${precmd_functions:#_venes_precmd})
  preexec_functions=(${preexec_functions:#_venes_preexec} _venes_preexec)
}
_venes_order
_venes_enc "$TTY"
_venes_say "S;$$;$REPLY;zsh"
