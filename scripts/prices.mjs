#!/usr/bin/env node
// Writes the copy of the price list this helper is released with, `data/prices.json`, from the list
// as it's published today, or from a file of it given by name. Run before a release.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCE, reduced } from '../src/prices.mjs';

const [file] = process.argv.slice(2);
const list = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : await (await fetch(SOURCE)).json();
const prices = reduced(list);
const sorted = Object.fromEntries(Object.keys(prices).sort().map(name => [name, prices[name]]));
const out = fileURLToPath(new URL('../data/prices.json', import.meta.url));
fs.writeFileSync(out, `${JSON.stringify({ at: Date.now(), prices: sorted })}\n`);
console.log(`${Object.keys(sorted).length} models' prices written to ${out}`);
