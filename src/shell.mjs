// What a terminal session's shell runs on top of the reader's own setup. zsh reads its startup files
// from ZDOTDIR, so the helper points that at a folder of its own, whose files read the reader's from
// where they'd otherwise be and then add Venes's hooks, as editors with terminals of their own do.
// The hooks clear the terminal before each command and say when it's done, so that what a command
// printed is the screen between its own line and the next prompt, and the prompt is a plain one the
// helper can find.

import fs from 'node:fs';
import path from 'node:path';

// Each reads the reader's own file of the same name, in the folder it'd come from. A .zshenv there can
// move that folder, and the files after it then come from the new one, as they would.
const readOwn = name => `VENES_ZDOTDIR=$ZDOTDIR
ZDOTDIR=\${VENES_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/${name} ]] && source $ZDOTDIR/${name}
VENES_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$VENES_ZDOTDIR
`;

// The prompt is the helper's, so that it can be found again: a theme's own is put back before each one.
// $? goes first, before any other hook's work changes it, and the prompt last, after a theme has set its
// own. The command's line is drawn again after the screen is cleared, on one line, as typed.
const HOOKS = `[[ -n $VENES_TERMINAL_DIR && -z $_venes_hooked ]] || return 0
typeset -g _venes_hooked=1 _venes_code=0
typeset -gi _venes_seq=0
_venes_write() { print -rn -- "$2" >| "$VENES_TERMINAL_DIR/$1" 2>/dev/null; }
_venes_status() { _venes_code=$?; }
_venes_precmd() {
  PROMPT='%~ %# '
  RPROMPT=''
  PROMPT_EOL_MARK=''
  _venes_write cwd "$PWD"
  _venes_write prompt "\${(%)PROMPT}"
  _venes_write state "idle $$ $_venes_seq $_venes_code"
}
_venes_preexec() {
  (( _venes_seq++ ))
  print -rn -- $'\\e[H\\e[2J\\e[3J'
  print -r -- "\${(%)PROMPT}\${1//$'\\n'/ }"
  _venes_write command "$1"
  _venes_write state "running $$ $_venes_seq"
}
_venes_order() {
  precmd_functions=(_venes_status \${precmd_functions:#_venes_(status|precmd)} _venes_precmd)
  preexec_functions=(\${preexec_functions:#_venes_preexec} _venes_preexec)
}
_venes_order
`;

export const ZSH_FILES = {
  '.zshenv': readOwn('.zshenv'),
  '.zprofile': readOwn('.zprofile'),
  // macOS's /etc/zshrc names the history file after ZDOTDIR, which is the helper's by then, and a
  // command typed from the phone belongs in the reader's own history.
  '.zshrc': `HISTFILE=\${VENES_USER_ZDOTDIR:-$HOME}/.zsh_history\n${readOwn('.zshrc')}source "$ZDOTDIR/venes.zsh"\n`,
  // Last of all, so that the hooks still come in their places after anything this adds.
  '.zlogin': `${readOwn('.zlogin')}(( $+functions[_venes_order] )) && _venes_order\n`,
  'venes.zsh': HOOKS,
};

// Written each time a terminal starts, so that a new version's hooks are the ones it gets.
export function installShellFiles(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(ZSH_FILES)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  return dir;
}

// A login shell, so that it has what the reader's own Terminal would: Homebrew's PATH comes from a
// .zprofile. It's zsh whatever the reader's own shell is, as the hooks are written for it.
export function shellCommand({ shellDir, terminalDir, env = process.env }) {
  return {
    command: ['/bin/zsh', '-l', '-i'],
    env: {
      ZDOTDIR: shellDir,
      VENES_USER_ZDOTDIR: env.ZDOTDIR || env.HOME,
      VENES_TERMINAL_DIR: terminalDir,
      // A helper started over SSH may have none, and the shell would read UTF-8 as bytes.
      LANG: env.LANG || 'en_US.UTF-8',
      ...(env.LC_ALL && { LC_ALL: env.LC_ALL }),
      ...(env.PATH && { PATH: env.PATH }),
    },
  };
}
