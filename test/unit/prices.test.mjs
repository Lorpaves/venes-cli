import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Prices, costOf, mayFetchPrices, priceFor, reduced, savingsOf } from '../../src/prices.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-prices-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The public list's shape, with what the helper has no use for among it.
const LIST = {
  sample_spec: { input_cost_per_token: 0, litellm_provider: 'one of many', mode: 'chat' },
  'claude-opus-5-5': {
    litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 4e-6, output_cost_per_token: 2e-5,
    cache_creation_input_token_cost: 5e-6, cache_creation_input_token_cost_above_1hr: 8e-6, cache_read_input_token_cost: 2e-7,
    input_cost_per_token_batches: 2e-6,
  },
  'gpt-6-astra': {
    litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-5, output_cost_per_token: 5e-5, cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5, cache_creation_input_token_cost_above_12hr: 2.5e-5,
    input_cost_per_token_above_272k_tokens: 2e-5, output_cost_per_token_above_272k_tokens: 7.5e-5, cache_read_input_token_cost_above_272k_tokens: 2e-6,
    cache_creation_input_token_cost_above_272k_tokens: 2.5e-5, cache_creation_input_token_cost_above_12hr_above_272k_tokens: 5e-5,
    input_cost_per_token_priority: 2e-5, output_cost_per_token_priority: 1e-4, cache_read_input_token_cost_priority: 2e-6,
    input_cost_per_token_above_272k_tokens_priority: 4e-5, output_cost_per_token_above_272k_tokens_priority: 1.5e-4,
    input_cost_per_token_ultrafast: 6e-5, output_cost_per_token_ultrafast: 3e-4, cache_creation_input_token_cost_above_12hr_ultrafast: 1.5e-4,
  },
  'gemini/gemini-4-carbon': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7 },
  'gemini-4-carbon': { litellm_provider: 'vertex_ai-language-models', mode: 'chat', input_cost_per_token: 3e-6, output_cost_per_token: 1e-5 },
  'gemini/gemini-4-argon': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 4e-6, output_cost_per_reasoning_token: 3e-6 },
  'dall-e-9': { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  'bedrock/claude-opus-5-5': { litellm_provider: 'bedrock', mode: 'chat', input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
  'text-embedding-9': { litellm_provider: 'openai', mode: 'embedding', input_cost_per_token: 1e-8 },
};

test('the list is kept as each model\'s price for each kind of token, for the makers the agents run', () => {
  const prices = reduced(LIST);
  assert.deepEqual(Object.keys(prices).sort(), ['claude-opus-5-5', 'gemini-4-argon', 'gemini-4-carbon', 'gpt-6-astra']);
  assert.deepEqual(prices['claude-opus-5-5'], { input: 4e-6, output: 2e-5, cacheRead: 2e-7, cacheWrite: 5e-6, cacheWriteLong: 8e-6 });
  // A request over the size a maker charges more from has every price of its own.
  assert.deepEqual(prices['gpt-6-astra'].over, { tokens: 272000, input: 2e-5, output: 7.5e-5, cacheRead: 2e-6, cacheWrite: 2.5e-5, cacheWriteLong: 5e-5 });
  assert.equal(prices['gpt-6-astra'].cacheWriteLong, 2.5e-5);
  // A service tier's prices are its own, over the same size where the maker charges more from it.
  assert.deepEqual(prices['gpt-6-astra'].tiers, {
    priority: { input: 2e-5, output: 1e-4, cacheRead: 2e-6, over: { tokens: 272000, input: 4e-5, output: 1.5e-4 } },
    ultrafast: { input: 6e-5, output: 3e-4, cacheWriteLong: 1.5e-4 },
  });
  assert.equal(prices['claude-opus-5-5'].tiers, undefined);
  // A name listed bare stands, whatever comes with its maker before it. One listed only so is found bare.
  assert.equal(prices['gemini-4-carbon'].input, 3e-6);
  assert.equal(prices['gemini-4-argon'].input, 1e-6);
  assert.deepEqual(reduced(undefined), {});
});

test('a model is found by the name an agent wrote down for it', () => {
  const prices = reduced(LIST);
  for (const name of ['claude-opus-5-5', 'Claude-Opus-5-5', 'claude-opus-5-5[1m]', 'claude-opus-5-5-20261001', 'anthropic/claude-opus-5-5', 'claude-opus-5-5-fast']) {
    assert.equal(priceFor(prices, name), prices['claude-opus-5-5'], name);
  }
  for (const name of ['claude-opus-5', 'codex-auto-review', '<synthetic>', '', undefined]) assert.equal(priceFor(prices, name), undefined, `${name}`);
  assert.equal(priceFor(undefined, 'claude-opus-5-5'), undefined);
});

test('a request costs what each kind of its tokens does, and more whole once it is over a maker\'s size', () => {
  const prices = reduced(LIST);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  near(costOf(prices['claude-opus-5-5'], { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWriteLong: 1e6 }), 4 + 20 + 0.2 + 5 + 8);
  near(costOf(prices['gpt-6-astra'], { input: 100_000, output: 1000 }), 1 + 0.05);
  near(costOf(prices['gpt-6-astra'], { input: 200_000, cacheRead: 100_000, output: 1000 }), 4 + 0.2 + 0.075);
  // A maker that lists no price for a cache charges as for any input.
  near(costOf(prices['gemini-4-argon'], { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWriteLong: 1e6 }), 4);
  near(costOf(prices['claude-opus-5-5']), 0);
  // A request at a service tier is charged at the tier's prices, and over the size at the tier's prices for that.
  near(costOf(prices['gpt-6-astra'], { input: 100_000, cacheRead: 100_000, output: 1000 }, 'priority'), 2 + 0.2 + 0.1);
  near(costOf(prices['gpt-6-astra'], { input: 300_000, output: 1000 }, 'priority'), 12 + 0.15);
  near(costOf(prices['gpt-6-astra'], { input: 100_000, output: 1000 }, 'ultrafast'), 6 + 0.3);
  // One the maker lists no prices for, as the usual tier, is charged as usual.
  for (const tier of ['default', 'flex', undefined]) near(costOf(prices['gpt-6-astra'], { input: 100_000, output: 1000 }, tier), 1 + 0.05);
  near(costOf(prices['claude-opus-5-5'], { input: 1e6 }, 'priority'), 4);
  // Reasoning counted apart from what was said is charged as it, unless the maker has a price for it.
  near(costOf(prices['claude-opus-5-5'], { output: 1e6, reasoning: 1e6 }), 40);
  near(costOf(prices['gemini-4-argon'], { output: 1e6, reasoning: 1e6 }), 4 + 3);
  assert.equal(costOf(undefined, { input: 5 }), undefined);
});

test('what a cache saved is its reads at the input\'s price, less what they cost', () => {
  const prices = reduced(LIST);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  near(savingsOf(prices['claude-opus-5-5'], { input: 10, cacheRead: 1e6, output: 5 }), 4 - 0.2);
  // At a tier, and over the size a maker charges more from, at the prices the request was charged at.
  near(savingsOf(prices['gpt-6-astra'], { input: 100_000, cacheRead: 100_000 }, 'priority'), 100_000 * (2e-5 - 2e-6));
  near(savingsOf(prices['gpt-6-astra'], { input: 200_000, cacheRead: 100_000 }), 100_000 * (2e-5 - 2e-6));
  // Nothing with no cache read, with no price for reading one, or with no price at all.
  for (const [price, tokens] of [[prices['claude-opus-5-5'], { input: 1e6 }], [prices['gemini-4-argon'], { cacheRead: 1e6 }], [undefined, { cacheRead: 1e6 }]]) {
    assert.equal(savingsOf(price, tokens), 0);
  }
});

test('the prices in hand are the last read of the list, or the copy the helper came with', t => {
  const dir = tempDir(t);
  const bundled = path.join(dir, 'bundled.json');
  const file = path.join(dir, 'kept', 'prices.json');
  fs.writeFileSync(bundled, JSON.stringify({ at: 1000, prices: { a: { input: 1, output: 1 } } }));
  const prices = new Prices({ file, bundled });
  assert.deepEqual(prices.current(), { at: 1000, prices: { a: { input: 1, output: 1 } } });
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ at: 2000, prices: { b: { input: 2, output: 2 } } }));
  assert.deepEqual(Object.keys(prices.current().prices), ['b']);
  // A helper newer than what was kept came with newer prices than it.
  fs.writeFileSync(file, JSON.stringify({ at: 500, prices: { b: { input: 2, output: 2 } } }));
  assert.deepEqual(Object.keys(prices.current().prices), ['a']);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(Object.keys(prices.current().prices), ['a']);
  assert.deepEqual(new Prices({ bundled: path.join(dir, 'none.json') }).current(), { at: 0, prices: {} });
  assert.ok(Object.keys(new Prices().current().prices).length > 50, 'the helper comes with a copy');
});

test('the list is read again once a day, and after a read that failed not for an hour', async t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'prices.json');
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`claude-test-${i}`, LIST['claude-opus-5-5']]));
  let now = 10_000_000;
  let fails = true;
  const asked = [];
  const fetch = async (url, options) => {
    asked.push(url);
    assert.ok(options.signal, 'with a limit on how long it may take');
    if (fails) throw new Error('offline');
    return { ok: true, json: async () => ({ ...LIST, ...many }) };
  };
  const prices = new Prices({ file, bundled: path.join(dir, 'none.json'), fetch, now: () => now, env: {} });
  const errors = t.mock.method(console, 'error', () => {});
  assert.equal(await prices.refresh(), false);
  assert.equal(await prices.refresh(), false);
  assert.equal(asked.length, 1, 'not asked again so soon after failing');
  assert.equal(errors.mock.callCount(), 1);
  now += 61 * 60_000;
  fails = false;
  assert.equal(await prices.refresh(), true);
  assert.match(asked[1], /^https:\/\/raw\.githubusercontent\.com\/BerriAI\/litellm\//);
  assert.equal(prices.current().prices['claude-test-3'].input, 4e-6);
  assert.equal(prices.current().prices['dall-e-9'], undefined, 'only what the helper has a use for is kept');
  assert.equal(fs.statSync(file).mode & 0o777, process.platform === 'win32' ? fs.statSync(file).mode & 0o777 : 0o600);
  now += 23 * 60 * 60_000;
  assert.equal(await prices.refresh(), false);
  now += 2 * 60 * 60_000;
  assert.equal(await prices.refresh(), true);
  assert.equal(asked.length, 3);

  // A list with next to nothing in it isn't the list, and what was kept stays.
  now += 25 * 60 * 60_000;
  const short = new Prices({ file, bundled: path.join(dir, 'none.json'), fetch: async () => ({ ok: true, json: async () => LIST }), now: () => now, env: {} });
  assert.equal(await short.refresh(), false);
  assert.equal(short.current().prices['claude-test-3'].input, 4e-6);
  now += 2 * 60 * 60_000;
  const refused = new Prices({ file, bundled: path.join(dir, 'none.json'), fetch: async () => ({ ok: false, status: 503 }), now: () => now, env: {} });
  assert.equal(await refused.refresh(), false);

  // Someone who has turned off what needn't be sent isn't asked for.
  assert.equal(mayFetchPrices({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }), false);
  assert.equal(mayFetchPrices({ VENES_NO_PRICES: '1' }), false);
  assert.equal(mayFetchPrices({}), true);
  now += 48 * 60 * 60_000;
  const quiet = new Prices({ file, fetch: async () => { throw new Error('asked'); }, now: () => now, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
  assert.equal(await quiet.refresh(), false);
  assert.equal(await new Prices({ fetch }).refresh(), false, 'with nowhere to keep it, it is not asked for');
});
