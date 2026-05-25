import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarket } from './marketClassifier';

test('crypto pairs (quote suffix) route to CRYPTO', () => {
  assert.equal(classifyMarket('BTCUSDT'), 'CRYPTO');
  assert.equal(classifyMarket('dogeusdt'), 'CRYPTO');
  assert.equal(classifyMarket('ETHUSDC'), 'CRYPTO');
  assert.equal(classifyMarket('SOLFDUSD'), 'CRYPTO');
  assert.equal(classifyMarket('BTCTRY'), 'CRYPTO');
});

test('bare BIST tickers route to BIST', () => {
  assert.equal(classifyMarket('THYAO'), 'BIST');
  assert.equal(classifyMarket('GARAN'), 'BIST');
  assert.equal(classifyMarket('aselS'), 'BIST');
  assert.equal(classifyMarket('PGSUS'), 'BIST'); // ends in "US", not a quote asset
});

test('explicit allowlist forces BIST even with a crypto-looking suffix', () => {
  const set = new Set(['WEIRDUSD']);
  assert.equal(classifyMarket('WEIRDUSD', set), 'BIST');
  // not in the set -> heuristic still applies
  assert.equal(classifyMarket('BTCUSDT', set), 'CRYPTO');
});

test('classification is case-insensitive', () => {
  assert.equal(classifyMarket('thyao'), 'BIST');
  assert.equal(classifyMarket('BtCuSdT'), 'CRYPTO');
});
