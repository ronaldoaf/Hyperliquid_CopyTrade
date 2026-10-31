import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { traderTargets, applyCaps, applyFill, evaluate, shouldTrade, migratePaper, paperTick, PAPER } from '../src/paper.js';

const prices = { BTC: { mid: 100, mark: 100, bid: 99.9, ask: 100.1, funding: 0 }, ETH: { mid: 10, mark: 10, bid: 10, ask: 10, funding: 0 } };
const cfg = { ...PAPER, traderLeverage: 3, assetCap: 0.5, totalLeverage: 2 };

test('copia proporcional à conta do trader e ignora o que ele já tinha', () => {
  const baseline = { ETH: 1 };
  const t = traderTargets({ status: 'active', alloc: 1000, accountValue: 10_000, positions: { BTC: 5, ETH: 100 },
    legs: {}, baseline, prices, cfg });
  assert.equal(t.BTC, 0.5);
  assert.equal(t.ETH, 0);
  // Ele fecha o ETH antigo e abre de novo: agora copia.
  traderTargets({ status: 'active', alloc: 1000, accountValue: 10_000, positions: {}, legs: {}, baseline, prices, cfg });
  assert.deepEqual(baseline, {});
  const t2 = traderTargets({ status: 'active', alloc: 1000, accountValue: 10_000, positions: { ETH: 100 }, legs: {}, baseline, prices, cfg });
  assert.equal(t2.ETH, 10);
});

test('teto de alavancagem por trader', () => {
  const t = traderTargets({ status: 'active', alloc: 1000, accountValue: 1000, positions: { BTC: 100 }, legs: {}, baseline: {}, prices, cfg });
  assert.equal(t.BTC * 100, 3000);
});

test('run-off só reduz', () => {
  const base = { status: 'runoff', alloc: 1000, accountValue: 10_000, legs: { BTC: 0.5 }, baseline: {}, prices, cfg };
  assert.equal(traderTargets({ ...base, positions: { BTC: 10 } }).BTC, 0.5);
  assert.equal(traderTargets({ ...base, positions: { BTC: 2 } }).BTC, 0.2);
  assert.equal(traderTargets({ ...base, positions: { BTC: -2 } }).BTC, 0);
  assert.equal(traderTargets({ ...base, positions: { BTC: 2, ETH: 50 } }).ETH, 0);
});

test('tetos por ativo e total', () => {
  const t = applyCaps({ a: { BTC: 4 }, b: { BTC: 4, ETH: 100 } }, prices, 1000, cfg);
  assert.ok(Math.abs((t.a.BTC + t.b.BTC) * 100 - 500) < 1e-9);
  const gross = (t.a.BTC + t.b.BTC) * 100 + t.b.ETH * 10;
  assert.ok(gross <= 2000 + 1e-9);
});

test('execução com PnL realizado e taxa', () => {
  const c = { ...cfg, feeBps: 10 };
  let r = applyFill({ size: 0, entryPx: null }, 1, 100, c);
  assert.deepEqual([r.size, r.entryPx, r.fee], [1, 100, 0.1]);
  r = applyFill({ size: 1, entryPx: 100 }, -2, 110, c);
  assert.equal(r.realized, 10);
  assert.equal(r.size, -1);
  assert.equal(r.entryPx, 110);
  assert.equal(shouldTrade(1, 1.01, 100, cfg), false);
  assert.equal(shouldTrade(1, 0, 100, cfg), true);
});

test('histerese da seleção', () => {
  const c = { ...cfg, maxTraders: 2, enterScore: 85, exitScore: 75, riskScore: 45, maxMisses: 3 };
  const followers = [
    { address: 'a', status: 'active', misses: 0 }, { address: 'b', status: 'active', misses: 2 },
  ];
  const acts = evaluate([{ address: 'a', score: 80 }, { address: 'x', score: 90 }, { address: 'y', score: 84 }], followers, c);
  const by = Object.fromEntries(acts.map((x) => [x.address, x.action]));
  assert.equal(by.a, 'keep'); // 80 está entre a saída e a entrada: fica
  assert.equal(by.b, 'runoff'); // 3ª avaliação fora
  assert.equal(by.x, 'enter');
  assert.equal(by.y, undefined);
  assert.equal(evaluate([{ address: 'a', score: 40 }], followers, c)[0].action, 'close');
});

test('ciclo completo com banco em memória', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE traders (address TEXT PRIMARY KEY, display_name TEXT)');
  migratePaper(db);
  db.prepare("INSERT INTO paper_followers (address, status, alloc, entered_at) VALUES ('t', 'active', 10000, 0)").run();
  let pos = [{ position: { coin: 'BTC', szi: '1' } }];
  const fetchState = async () => ({ marginSummary: { accountValue: '100000' }, assetPositions: pos });
  await paperTick(db, { now: 1, prices, fetchState }); // baseline: BTC antigo não é copiado
  assert.equal(db.prepare('SELECT COUNT(*) n FROM paper_trades').get().n, 0);
  pos = [{ position: { coin: 'BTC', szi: '1' } }, { position: { coin: 'ETH', szi: '200' } }];
  await paperTick(db, { now: 2, prices, fetchState });
  const leg = db.prepare("SELECT * FROM paper_legs WHERE coin = 'ETH'").get();
  assert.equal(leg.size, 20);
  db.prepare("UPDATE paper_followers SET status = 'closing'").run();
  await paperTick(db, { now: 3, prices, fetchState });
  assert.equal(db.prepare("SELECT status FROM paper_followers").get().status, 'closed');
  const cash = JSON.parse(db.prepare("SELECT value FROM paper_state WHERE key = 'cash'").get().value);
  assert.ok(cash < PAPER.capital); // pagou taxas e slippage
});
