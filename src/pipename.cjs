// The helper's two meeting places on Windows, where a socket can't be a file in the helper's folder: named
// pipes, which all share one space of names, so each is named for the folder it stands in for. This is
// written for `require`, since the hook's own script is, to start as fast as Node can.
const { createHash } = require('node:crypto');
const path = require('node:path');

// `kind` is `hook` or `client`. Two helpers with different folders, as a test's and the person's own, get
// different pipes.
exports.pipeName = (home, kind) => {
  const folder = createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 16);
  return `\\\\.\\pipe\\venes-${kind}-${folder}`;
};
