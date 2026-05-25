import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winLoss } from './stats';

test('empty set yields zero rates and counts', () => {
  assert.deepEqual(winLoss([]), { win_count: 0, loss_count: 0, win_rate: 0, loss_rate: 0 });
});

test('win_rate and loss_rate sum to 1 over a non-empty set', () => {
  const wl = winLoss([5, -2, 3, -1]);
  assert.equal(wl.win_count, 2);
  assert.equal(wl.loss_count, 2);
  assert.equal(wl.win_rate, 0.5);
  assert.equal(wl.loss_rate, 0.5);
  assert.equal(round3(wl.win_rate + wl.loss_rate), 1);
});

test('break-even (pnl === 0) counts as a loss', () => {
  const wl = winLoss([0, 4]);
  assert.equal(wl.win_count, 1);
  assert.equal(wl.loss_count, 1);
  assert.equal(wl.win_rate, 0.5);
  assert.equal(wl.loss_rate, 0.5);
});

test('all wins / all losses', () => {
  assert.deepEqual(winLoss([1, 2, 3]), {
    win_count: 3,
    loss_count: 0,
    win_rate: 1,
    loss_rate: 0,
  });
  assert.deepEqual(winLoss([-1, -2]), {
    win_count: 0,
    loss_count: 2,
    win_rate: 0,
    loss_rate: 1,
  });
});

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
