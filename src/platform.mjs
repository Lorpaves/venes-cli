// What the helper runs on. It was written on a Mac, and on Linux the same things are done with what a
// Linux system has. What it calls the computer, in what it says to a person, follows from that.
export const isMac = process.platform === 'darwin';
// Windows itself, not Linux inside it: there the helper's sockets are named pipes, and a hook's script is Node's.
export const isWindows = process.platform === 'win32';
export const computer = isMac ? 'Mac' : 'computer';
