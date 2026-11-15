import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

const NOV = new Date(2026, 10, 15, 12);
const amounts = (state, alloc) =>
  Object.fromEntries(alloc.map((a) => [state.envelopes.find((e) => e.id === a.env).name, a.amount]));
const named = (state) => {
  const b = L.balances(state);
  return Object.fromEntries(state.envelopes.map((e) => [e.name, b[e.id]]));
};
const income = (state, amount, when = NOV) =>
  L.applyTxn(state, L.makeIncome(state, amount, L.allocate(state, amount, when), '', when));
const id = (state, name) => state.envelopes.find((e) => e.name === name).id;

test('parseAmount', () => {
  assert.equal(L.parseAmount('30000'), 30000);
  assert.equal(L.parseAmount('30,000'), 30000);
  assert.equal(L.parseAmount('30k'), 30000);
  assert.equal(L.parseAmount('1.5m'), 1500000);
  assert.equal(L.parseAmount('abc'), 0);
  assert.equal(L.parseAmount(''), 0);
  assert.equal(L.parseAmount('-5'), 0);
});

test('periodKey respects the start day', () => {
  assert.equal(L.periodKey(new Date(2026, 10, 15), 1), '2026-11');
  assert.equal(L.periodKey(new Date(2026, 10, 15), 25), '2026-10');
  assert.equal(L.periodKey(new Date(2026, 10, 25), 25), '2026-11');
  assert.equal(L.periodKey(new Date(2026, 0, 10), 25), '2025-12');
});

test('30k fills every target exactly', () => {
  const s = L.defaultState(NOV);
  assert.deepEqual(amounts(s, L.allocate(s, 30000, NOV)),
    { Data: 15000, Food: 5000, Transport: 5000, Personal: 5000, Buffer: 0, Savings: 0 });
});

test('a short month fills in priority order', () => {
  const s = L.defaultState(NOV);
  assert.deepEqual(amounts(s, L.allocate(s, 12000, NOV)),
    { Data: 12000, Food: 0, Transport: 0, Personal: 0, Buffer: 0, Savings: 0 });
  assert.deepEqual(amounts(s, L.allocate(s, 22000, NOV)),
    { Data: 15000, Food: 5000, Transport: 2000, Personal: 0, Buffer: 0, Savings: 0 });
});

test('extra income goes 30% to Buffer and 70% to Savings', () => {
  const s = L.defaultState(NOV);
  assert.deepEqual(amounts(s, L.allocate(s, 50000, NOV)),
    { Data: 15000, Food: 5000, Transport: 5000, Personal: 5000, Buffer: 6000, Savings: 14000 });
});

test('a second income in the same month only tops up what is short', () => {
  const s = L.defaultState(NOV);
  income(s, 18000);
  assert.deepEqual(amounts(s, L.allocate(s, 20000, NOV)),
    { Data: 0, Food: 2000, Transport: 5000, Personal: 5000, Buffer: 2400, Savings: 5600 });
});

test('spending does not cause an envelope to be refilled', () => {
  const s = L.defaultState(NOV);
  income(s, 30000);
  L.applyTxn(s, L.makeExpense(s, id(s, 'Data'), 10000, '', NOV));
  assert.deepEqual(amounts(s, L.allocate(s, 10000, NOV)),
    { Data: 0, Food: 0, Transport: 0, Personal: 0, Buffer: 3000, Savings: 7000 });
});

test('buffer cap diverts the excess to Savings', () => {
  const s = L.defaultState(NOV);
  s.settings.bufferCap = 4000;
  assert.deepEqual(amounts(s, L.allocate(s, 50000, NOV)).Buffer, 4000);
  assert.deepEqual(amounts(s, L.allocate(s, 50000, NOV)).Savings, 16000);
});

test('allocation always adds up to the amount', () => {
  const s = L.defaultState(NOV);
  for (const amt of [1, 7, 333, 14999, 30001, 99999]) {
    assert.equal(L.allocate(s, amt, NOV).reduce((t, a) => t + a.amount, 0), amt);
  }
});

test('income split must match the amount', () => {
  const s = L.defaultState(NOV);
  const alloc = L.allocate(s, 30000, NOV);
  alloc[0].amount -= 1;
  assert.throws(() => L.makeIncome(s, 30000, alloc, '', NOV), /add up/);
});

test('overspending is covered from Buffer, or refused', () => {
  const s = L.defaultState(NOV);
  income(s, 50000);
  L.applyTxn(s, L.makeExpense(s, id(s, 'Food'), 7000, '', NOV));
  assert.equal(named(s).Food, 0);
  assert.equal(named(s).Buffer, 4000);
  assert.throws(() => L.makeExpense(s, id(s, 'Food'), 4001, '', NOV), /Not enough/);
});

test('transfers cannot overdraw', () => {
  const s = L.defaultState(NOV);
  income(s, 30000);
  assert.throws(() => L.applyTxn(s, L.makeTransfer(s, id(s, 'Food'), id(s, 'Data'), 5001)), /below zero/);
  L.applyTxn(s, L.makeTransfer(s, id(s, 'Food'), id(s, 'Data'), 5000));
  assert.equal(named(s).Data, 20000);
});

test('undo is refused once the money has been spent', () => {
  const s = L.defaultState(NOV);
  const t = income(s, 30000);
  const e = L.applyTxn(s, L.makeExpense(s, id(s, 'Food'), 1000, '', NOV));
  assert.throws(() => L.removeTxn(s, t.id), /below zero/);
  L.removeTxn(s, e.id);
  L.removeTxn(s, t.id);
  assert.equal(s.txns.length, 0);
});

test('new month sweeps leftovers 30/70 and resets funding', () => {
  const s = L.defaultState(NOV);
  income(s, 30000);
  L.applyTxn(s, L.makeExpense(s, id(s, 'Data'), 15000, '', NOV));
  L.applyTxn(s, L.makeExpense(s, id(s, 'Food'), 5000, '', NOV));
  assert.equal(L.rollover(s, NOV), null);
  const DEC = new Date(2026, 11, 2, 9);
  const sweep = L.rollover(s, DEC);
  assert.equal(sweep.amount, 10000);
  assert.deepEqual(named(s),
    { Data: 0, Food: 0, Transport: 0, Personal: 0, Buffer: 3000, Savings: 7000 });
  assert.equal(L.rollover(s, DEC), null);
  assert.deepEqual(amounts(s, L.allocate(s, 30000, DEC)),
    { Data: 15000, Food: 5000, Transport: 5000, Personal: 5000, Buffer: 0, Savings: 0 });
});

test('backup round trip and rejection of bad files', () => {
  const s = L.defaultState(NOV);
  income(s, 42000);
  const restored = L.validateImport(JSON.parse(JSON.stringify({ app: 'envelope-budget', state: s })));
  assert.deepEqual(named(restored), named(s));
  assert.throws(() => L.validateImport({ hello: 1 }), /not a valid/);
  assert.throws(() => L.validateImport(null), /not a valid/);
});
