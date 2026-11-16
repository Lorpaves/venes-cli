// Reads what the agents here have used, for the helper, in a process of its own: the chats it goes
// through can be gigabytes. Prints what it found. See usage.mjs.

import { Prices } from './prices.mjs';
import { readUsage } from './usage.mjs';

let reply;
try {
  const { file, pricesFile, budgetMs } = JSON.parse(process.argv[2]);
  reply = readUsage({ file, prices: new Prices({ file: pricesFile }).current().prices, budgetMs });
} catch (error) {
  reply = { error: { code: error.code ?? 'internal', message: error.message } };
}
process.stdout.write(JSON.stringify(reply), () => process.exit(0));
