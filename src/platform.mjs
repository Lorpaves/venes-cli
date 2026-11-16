// What the helper runs on. It was written on a Mac, and on Linux the same things are done with what a
// Linux system has. What it calls the computer, in what it says to a person, follows from that.
export const isMac = process.platform === 'darwin';
export const computer = isMac ? 'Mac' : 'computer';
