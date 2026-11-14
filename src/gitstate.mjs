// What git says of a folder, as a shell's prompt would: the branch, how far it is from the one it
// follows, and how many files have changed. One call to `git status`, in the form git keeps stable for
// programs to read.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// A big repository's status can take seconds. A reader waiting on a sheet shouldn't.
const GIT_TIMEOUT_MS = 3000;
const OUTPUT_BYTES = 16 * 1024 * 1024;
const SHORT_COMMIT = 7;

// `git status --porcelain=v2 --branch`: headers that start with "#", then a line for each path, whose
// first letter says what it is and whose XY says what changed in the index and in the folder.
export function parseStatus(text) {
  const state = { ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  let commit;
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) commit = line.slice('# branch.oid '.length);
    else if (line.startsWith('# branch.head ')) state.branch = line.slice('# branch.head '.length);
    else if (line.startsWith('# branch.upstream ')) state.upstream = line.slice('# branch.upstream '.length);
    else if (line.startsWith('# branch.ab ')) {
      const [, ahead, behind] = /\+(\d+) -(\d+)/.exec(line) ?? [];
      state.ahead = Number(ahead) || 0;
      state.behind = Number(behind) || 0;
    } else if (line.startsWith('? ')) state.untracked += 1;
    else if (line.startsWith('u ')) state.conflicted += 1;
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const [index, tree] = line.slice(2, 4);
      if (index !== '.') state.staged += 1;
      if (tree !== '.') state.modified += 1;
    }
  }
  // With no branch checked out, the commit it's at stands in, as git's own prompt has it.
  if (state.branch === '(detached)') {
    state.branch = commit && commit !== '(initial)' ? commit.slice(0, SHORT_COMMIT) : undefined;
    state.detached = true;
  }
  return state;
}

// Undefined for a folder that's in no repository, with no git on this Mac, or whose status took too long.
export async function gitState(cwd) {
  if (!cwd) return undefined;
  const git = args => exec('git', ['--no-optional-locks', '-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES });
  try {
    const [{ stdout: root }, { stdout: status }] = await Promise.all([
      git(['rev-parse', '--show-toplevel']), git(['status', '--porcelain=v2', '--branch']),
    ]);
    return { root: root.trim(), ...parseStatus(status) };
  } catch {
    return undefined;
  }
}
