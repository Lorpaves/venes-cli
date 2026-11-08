// A choice made in the terminal with the arrow keys and Enter, as a list of options with one marked.

import readline from 'node:readline';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
const bold = text => `\x1b[1m${text}\x1b[22m`;
const dim = text => `\x1b[2m${text}\x1b[22m`;
const cyan = text => `\x1b[36m${text}\x1b[39m`;

export function optionLines(options, index) {
  return options.map((option, at) => {
    const note = option.note ? ` ${dim(`(${option.note})`)}` : '';
    return at === index ? `${cyan('❯')} ${bold(option.label)}${note}` : `  ${option.label}${note}`;
  });
}

// Lets someone pick one of `options`, each `{label, note}`, starting on `start`. Resolves to the index
// picked, or undefined when they stop with Esc or Ctrl+C. A number picks that option too.
export function choose({ options, start = 0, input = process.stdin, output = process.stdout }) {
  let index = start;
  const draw = () => optionLines(options, index).map(line => `${CLEAR_LINE}${line}\n`).join('');
  output.write(`${HIDE_CURSOR}${draw()}`);
  readline.emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  return new Promise(resolve => {
    const finish = picked => {
      input.off('keypress', onKey);
      input.setRawMode?.(false);
      input.pause();
      output.write(SHOW_CURSOR);
      resolve(picked);
    };
    const onKey = (text, key = {}) => {
      if (key.name === 'return' || key.name === 'enter') return finish(index);
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(undefined);
      if (key.name === 'up' || key.name === 'k') index = (index + options.length - 1) % options.length;
      else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') index = (index + 1) % options.length;
      else if (/^[1-9]$/.test(text ?? '') && Number(text) <= options.length) index = Number(text) - 1;
      else return undefined;
      output.write(`\x1b[${options.length}A${draw()}`);
      return undefined;
    };
    input.on('keypress', onKey);
  });
}
