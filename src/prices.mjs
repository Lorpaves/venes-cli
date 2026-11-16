// What a model's tokens cost. The prices are a public list's, LiteLLM's, which is kept current where
// it's published, so that a new model or a changed price needs no new helper. It's read from there
// once a day at most, nothing is sent with the request, and what's kept of it are the makers whose
// models the agents here run. A copy from the day this helper was released stands in where the list
// can't be reached.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const BUNDLED = fileURLToPath(new URL('../data/prices.json', import.meta.url));
const MAKERS = new Set(['anthropic', 'openai', 'gemini', 'vertex_ai-language-models']);
const MODES = new Set(['chat', 'responses']);
const LIFETIME_MS = 24 * 60 * 60_000;
// After a read that failed, which offline is every one.
const RETRY_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

// The list's names for a kind of token's price, by this helper's name for the kind.
const FIELDS = {
  input: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cacheRead: 'cache_read_input_token_cost',
  cacheWrite: 'cache_creation_input_token_cost',
  // Where a maker charges for a model's reasoning apart from what it says.
  reasoning: 'output_cost_per_reasoning_token',
};
// Written to a cache to stay an hour or longer, where a maker charges more for that: `_above_1hr`, `_above_12hr`.
const LONG_WRITE = /^cache_creation_input_token_cost_above_\d+hr$/;
const OVER = /^input_cost_per_token_above_(\d+)k_tokens$/;
// The service tiers a maker charges apart for, by the name an agent writes down: Codex's fast modes are
// `priority` and `ultrafast`.
const TIERS = ['priority', 'flex', 'ultrafast'];

// `suffix` is what the list ends a price's name with for requests over a size.
function ratesOf(entry, suffix = '') {
  const rates = {};
  for (const [kind, field] of Object.entries(FIELDS)) {
    if (Number.isFinite(entry[`${field}${suffix}`])) rates[kind] = entry[`${field}${suffix}`];
  }
  const long = Object.keys(entry).find(key => key.endsWith(suffix) && LONG_WRITE.test(key.slice(0, key.length - suffix.length)));
  if (long && Number.isFinite(entry[long])) rates.cacheWriteLong = entry[long];
  return rates;
}

// The list as the helper keeps it: each model's dollars per token of each kind, and `over`, the size
// of request from which a maker charges more, with what it charges then.
export function reduced(list) {
  const prices = {};
  for (const [listed, entry] of Object.entries(list ?? {})) {
    if (!entry || typeof entry !== 'object' || !MAKERS.has(entry.litellm_provider)) continue;
    if (entry.mode && !MODES.has(entry.mode)) continue;
    const rates = ratesOf(entry);
    if (!(rates.input >= 0) || !(rates.output >= 0)) continue;
    const size = Object.keys(entry).map(key => OVER.exec(key)?.[1]).find(Boolean);
    if (size) rates.over = { tokens: Number(size) * 1000, ...ratesOf(entry, `_above_${size}k_tokens`) };
    // A tier's prices, each over the same size where the maker charges more from it.
    const tiers = {};
    for (const tier of TIERS) {
      const own = ratesOf(entry, `_${tier}`);
      if (!(own.input >= 0) && !(own.output >= 0)) continue;
      const over = size ? ratesOf(entry, `_above_${size}k_tokens_${tier}`) : {};
      tiers[tier] = Object.keys(over).length ? { ...own, over: { tokens: Number(size) * 1000, ...over } } : own;
    }
    if (Object.keys(tiers).length) rates.tiers = tiers;
    // A name with its maker before it is the model's own for the lookup, unless the list has that too.
    const name = listed.includes('/') ? listed.slice(listed.lastIndexOf('/') + 1) : listed;
    if (name === listed || !(name in prices)) prices[name.toLowerCase()] = rates;
  }
  return prices;
}

// A model's prices by the name an agent wrote down for it: as listed, or the listed name it's a dated
// or otherwise marked form of, as `claude-opus-5-5-20261001` and `claude-opus-5-5[1m]` are.
export function priceFor(prices, model) {
  if (!model || !prices) return undefined;
  const name = `${model}`.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^.*\//, '').trim();
  if (!name) return undefined;
  for (const tried of [name, name.replace(/-\d{8}$/, ''), name.replace(/@.*$/, '')]) {
    if (prices[tried]) return prices[tried];
  }
  let best;
  for (const listed of Object.keys(prices)) {
    if (name.startsWith(`${listed}-`) && (!best || listed.length > best.length)) best = listed;
  }
  return best && prices[best];
}

// What one request cost, in dollars: `input` that came from no cache, `cacheRead` that was read from
// one, `cacheWrite` written to one for minutes and `cacheWriteLong` for an hour or more, and `output`
// with the reasoning in it, or beside it as `reasoning` where an agent counts that apart. A request of
// the size at which a maker charges more is charged so whole. One run at a service `tier` the maker
// charges apart for is charged at that tier's prices, and at the usual ones where it lists none.
export function costOf(price, { input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, cacheWriteLong = 0 } = {}, tier = undefined) {
  if (!price) return undefined;
  const own = tier ? price.tiers?.[tier] : undefined;
  const base = own ? { ...price, ...own, over: own.over } : price;
  const isOver = base.over && input + cacheRead + cacheWrite + cacheWriteLong > base.over.tokens;
  const rates = isOver ? { ...base, ...base.over } : base;
  const write = rates.cacheWrite ?? rates.input;
  return input * rates.input + output * rates.output + reasoning * (rates.reasoning ?? rates.output) + cacheRead * (rates.cacheRead ?? rates.input)
    + cacheWrite * write + cacheWriteLong * (rates.cacheWriteLong ?? write);
}

// Whether the helper may ask for the list, which someone who has turned off what Claude Code needn't
// send has turned off too.
export function mayFetchPrices(env = process.env) {
  return !(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC || env.VENES_NO_PRICES);
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// The prices in hand: what was last read of the list and kept in `file`, or the copy this helper came
// with. `refresh` reads the list again when what's kept is a day old.
export class Prices {
  #file;
  #bundled;
  #fetch;
  #now;
  #env;

  constructor({ file, bundled = BUNDLED, fetch = globalThis.fetch, now = Date.now, env = process.env } = {}) {
    this.#file = file;
    this.#bundled = bundled;
    this.#fetch = fetch;
    this.#now = now;
    this.#env = env;
  }

  // `prices` by model, and `at`, when they were read: the release's day for the copy it came with.
  current() {
    const kept = this.#file ? readJSON(this.#file) : undefined;
    const bundled = readJSON(this.#bundled);
    if (kept?.prices && Object.keys(kept.prices).length && kept.at >= (bundled?.at ?? 0)) return { prices: kept.prices, at: kept.at };
    return { prices: bundled?.prices ?? {}, at: bundled?.at ?? 0 };
  }

  // True when the list was read and kept. It isn't asked for more than once a day, nor again for an
  // hour after a read that failed.
  async refresh() {
    if (!this.#file || !mayFetchPrices(this.#env)) return false;
    const kept = readJSON(this.#file);
    const now = this.#now();
    if (kept?.at && now - kept.at < LIFETIME_MS) return false;
    if (kept?.triedAt && now - kept.triedAt < RETRY_MS) return false;
    let prices;
    try {
      const response = await this.#fetch(SOURCE, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      prices = reduced(await response.json());
      if (Object.keys(prices).length < 10) throw new Error('the list has too little in it');
    } catch (error) {
      console.error(`prices: ${error.message}`);
      this.#keep({ ...(kept ?? {}), triedAt: now });
      return false;
    }
    this.#keep({ at: now, prices });
    return true;
  }

  #keep(kept) {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(kept), { mode: 0o600 });
      fs.renameSync(temporary, this.#file);
    } catch (error) {
      console.error(`prices: ${error.message}`);
    }
  }
}
