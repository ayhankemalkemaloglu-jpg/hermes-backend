import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSubscriptions, miniTickerStream } from './subscriptions';

test('adds desired symbols not yet subscribed', () => {
  const diff = diffSubscriptions(new Set(['BTCUSDT']), new Set(['BTCUSDT', 'ETHUSDT']));
  assert.deepEqual(diff.add, ['ETHUSDT']);
  assert.deepEqual(diff.remove, []);
});

test('removes subscribed symbols no longer desired', () => {
  const diff = diffSubscriptions(new Set(['BTCUSDT', 'ETHUSDT']), new Set(['BTCUSDT']));
  assert.deepEqual(diff.add, []);
  assert.deepEqual(diff.remove, ['ETHUSDT']);
});

test('no-op when sets already match', () => {
  const diff = diffSubscriptions(new Set(['BTCUSDT']), new Set(['BTCUSDT']));
  assert.deepEqual(diff.add, []);
  assert.deepEqual(diff.remove, []);
});

test('handles add and remove together', () => {
  const diff = diffSubscriptions(new Set(['BTCUSDT', 'XRPUSDT']), new Set(['BTCUSDT', 'SOLUSDT']));
  assert.deepEqual(diff.add.sort(), ['SOLUSDT']);
  assert.deepEqual(diff.remove.sort(), ['XRPUSDT']);
});

test('miniTickerStream lowercases and suffixes', () => {
  assert.equal(miniTickerStream('BTCUSDT'), 'btcusdt@miniTicker');
});
