import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedAgent,
  isBotCommand,
  isPm2Action,
  isReadOnlyCommand,
  parsePm2List,
} from './agentCommands';

test('bot command allowlist', () => {
  assert.ok(isBotCommand('STOP_BOT'));
  assert.ok(isBotCommand('GET_STATUS'));
  assert.ok(isBotCommand('CLOSE_ALL_POSITIONS'));
  assert.equal(isBotCommand('rm -rf /'), false);
  assert.equal(isBotCommand(42), false);
  assert.ok(isReadOnlyCommand('GET_STATUS'));
  assert.equal(isReadOnlyCommand('STOP_BOT'), false);
});

test('pm2 action allowlist', () => {
  assert.ok(isPm2Action('restart'));
  assert.ok(isPm2Action('stop'));
  assert.ok(isPm2Action('start'));
  assert.equal(isPm2Action('delete'), false);
  assert.equal(isPm2Action('kill; rm -rf /'), false);
});

test('agent name validation blocks injection + honours allowlist', () => {
  // empty allowlist → any plain name allowed
  assert.ok(isAllowedAgent('quant-bot', []));
  assert.ok(isAllowedAgent('hermes-backend', []));
  // shell-ish / spaced names rejected regardless of allowlist
  assert.equal(isAllowedAgent('quant-bot; rm -rf /', []), false);
  assert.equal(isAllowedAgent('a b', []), false);
  assert.equal(isAllowedAgent('', []), false);
  // non-empty allowlist restricts
  assert.ok(isAllowedAgent('quant-bot', ['quant-bot', 'uniswap-bot']));
  assert.equal(isAllowedAgent('sepolia-receiver', ['quant-bot', 'uniswap-bot']), false);
});

test('parsePm2List trims fields and filters by allowlist', () => {
  const raw = JSON.stringify([
    {
      name: 'quant-bot',
      pid: 123,
      pm2_env: { status: 'online', restart_time: 2, pm_uptime: Date.now() - 60_000 },
      monit: { cpu: 5, memory: 1024 },
    },
    { name: 'uniswap-bot', pid: 0, pm2_env: { status: 'stopped' }, monit: {} },
  ]);
  const all = parsePm2List(raw);
  assert.equal(all.length, 2);
  const qb = all.find((a) => a.name === 'quant-bot')!;
  assert.equal(qb.status, 'online');
  assert.equal(qb.cpu, 5);
  assert.equal(qb.restarts, 2);
  assert.ok((qb.uptime_ms ?? 0) >= 60_000);

  const filtered = parsePm2List(raw, ['uniswap-bot']);
  assert.deepEqual(
    filtered.map((a) => a.name),
    ['uniswap-bot']
  );
});

test('parsePm2List tolerates garbage', () => {
  assert.deepEqual(parsePm2List('not json'), []);
  assert.deepEqual(parsePm2List('{}'), []);
  assert.deepEqual(parsePm2List('[{"no":"name"}]'), []);
});
