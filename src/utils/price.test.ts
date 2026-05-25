import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtPrice } from './price';

test('documented case: keeps significant figures for tiny prices', () => {
  assert.equal(fmtPrice(0.00001234), '0.000012340');
});

test('low-priced tokens no longer collapse to zero', () => {
  // The exact bug FINDING 4 describes: toFixed(4) would give "0.0000".
  assert.equal(fmtPrice(0.0000123), '0.000012300');
  assert.notEqual(fmtPrice(0.0000123), '0.0000');
});

test('values >= 1 use the `big` fixed decimals (default 2)', () => {
  assert.equal(fmtPrice(76667.6), '76667.60');
  assert.equal(fmtPrice(1), '1.00');
  assert.equal(fmtPrice(0.1032), '0.10320');
});

test('exact zero renders as "0"', () => {
  assert.equal(fmtPrice(0), '0');
});

test('negatives keep their sign', () => {
  assert.equal(fmtPrice(-0.00001234), '-0.000012340');
  assert.equal(fmtPrice(-25.5), '-25.50');
});

test('decimals are clamped at `mx`', () => {
  // 1e-15 would need 19 decimals for 5 sig figs; mx=12 caps it.
  assert.equal(fmtPrice(1e-15), '0.000000000000');
  assert.equal(fmtPrice(1e-15).split('.')[1].length, 12);
});

test('non-finite values pass through as strings', () => {
  assert.equal(fmtPrice(NaN), 'NaN');
  assert.equal(fmtPrice(Infinity), 'Infinity');
  assert.equal(fmtPrice(-Infinity), '-Infinity');
});

test('respects custom sig/big/mx arguments', () => {
  assert.equal(fmtPrice(0.0000123, 3), '0.0000123');
  assert.equal(fmtPrice(123.456, 5, 4), '123.4560');
});
