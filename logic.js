// Pure budgeting rules. No DOM, no storage: everything here is unit-tested.
// Money is always a whole number (no decimals) to avoid rounding drift.

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** The budget month a date belongs to, e.g. "2026-11". A month that starts on
 *  day 25 runs from the 25th to the 24th and is labelled by its starting month. */
export function periodKey(date, startDay = 1) {
  const d = new Date(date);
  let y = d.getFullYear();
  let m = d.getMonth();
  if (d.getDate() < startDay) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

export function defaultState(now = new Date()) {
  const env = (name, target, kind = 'spend') => ({ id: uid(), name, kind, target });
  return {
    version: 1,
    settings: {
      currency: '₦',
      bufferPct: 30,   // share of overflow / month-end leftovers that goes to Buffer
      bufferCap: 0,    // 0 = no cap; otherwise Buffer stops filling at this balance
      startDay: 1,     // day of the month the budget month starts
      period: periodKey(now, 1),
      lastBackup: null,
    },
    envelopes: [
      env('Data', 15000),
      env('Food', 5000),
      env('Transport', 5000),
      env('Personal', 5000),
      env('Buffer', 0, 'buffer'),
      env('Savings', 0, 'savings'),
    ],
    txns: [],
  };
}

/** "30000", "30,000", "30k", "1.5m" -> whole number. Invalid input -> 0. */
export function parseAmount(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? Math.round(input) : 0;
  let s = String(input ?? '').trim().toLowerCase().replace(/[,\s]/g, '');
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return 0;
  return Math.round(parseFloat(s) * mult);
}

export const activeEnvelopes = (state) => state.envelopes.filter((e) => !e.archived);
export const spendEnvelopes = (state) => activeEnvelopes(state).filter((e) => e.kind === 'spend');
export const reserve = (state, kind) => state.envelopes.find((e) => e.kind === kind);

/** Balance of every envelope, derived from the full transaction history. */
export function balances(state, txns = state.txns) {
  const b = {};
  for (const e of state.envelopes) b[e.id] = 0;
  for (const t of txns) for (const l of t.lines) b[l.env] = (b[l.env] || 0) + l.delta;
  return b;
}

/** How much income each envelope has already received in the given budget month. */
export function fundedInPeriod(state, key) {
  const f = {};
  for (const t of state.txns) {
    if (t.type !== 'income' || periodKey(t.ts, state.settings.startDay) !== key) continue;
    for (const l of t.lines) if (l.delta > 0) f[l.env] = (f[l.env] || 0) + l.delta;
  }
  return f;
}

/** Split money that has no spending envelope to go to: bufferPct to Buffer
 *  (respecting the cap, if any), everything else to Savings. */
export function splitReserve(amount, settings, bufferBalance) {
  let toBuffer = Math.round((amount * settings.bufferPct) / 100);
  if (settings.bufferCap > 0) {
    toBuffer = Math.min(toBuffer, Math.max(0, settings.bufferCap - bufferBalance));
  }
  return { buffer: toBuffer, savings: amount - toBuffer };
}

/** Suggested split for new income: fill spending envelopes in priority order up
 *  to what each still needs this month, then send the rest to Buffer/Savings.
 *  Returns one entry per active envelope, in display order. */
export function allocate(state, amount, now = new Date()) {
  const funded = fundedInPeriod(state, periodKey(now, state.settings.startDay));
  let left = amount;
  const out = [];
  for (const e of spendEnvelopes(state)) {
    const need = Math.max(0, (e.target || 0) - (funded[e.id] || 0));
    const give = Math.min(need, left);
    left -= give;
    out.push({ env: e.id, amount: give });
  }
  const buffer = reserve(state, 'buffer');
  const savings = reserve(state, 'savings');
  const split = splitReserve(left, state.settings, balances(state)[buffer.id] || 0);
  out.push({ env: buffer.id, amount: split.buffer });
  out.push({ env: savings.id, amount: split.savings });
  return out;
}

function assertNoNegative(state, txns) {
  const b = balances(state, txns);
  for (const e of state.envelopes) {
    if (b[e.id] < 0) throw new Error(`That would leave ${e.name} below zero.`);
  }
}

/** Add a transaction, refusing anything that would overdraw an envelope. */
export function applyTxn(state, txn) {
  assertNoNegative(state, [...state.txns, txn]);
  state.txns.push(txn);
  return txn;
}

/** Undo a transaction, refusing if money it brought in has already been used. */
export function removeTxn(state, id) {
  const rest = state.txns.filter((t) => t.id !== id);
  assertNoNegative(state, rest);
  state.txns = rest;
}

export function makeIncome(state, amount, alloc, note = '', now = new Date()) {
  const lines = alloc.filter((a) => a.amount > 0).map((a) => ({ env: a.env, delta: a.amount }));
  const sum = lines.reduce((s, l) => s + l.delta, 0);
  if (amount <= 0) throw new Error('Enter an amount.');
  if (sum !== amount) throw new Error('The split must add up to the amount received.');
  return { id: uid(), ts: now.toISOString(), type: 'income', amount, note, lines };
}

/** Spend from an envelope. If it is short, the gap is taken from Buffer. */
export function makeExpense(state, envId, amount, note = '', now = new Date()) {
  if (amount <= 0) throw new Error('Enter an amount.');
  const b = balances(state);
  const buffer = reserve(state, 'buffer');
  const have = b[envId] || 0;
  const short = Math.max(0, amount - have);
  if (short > 0 && (envId === buffer.id || short > (b[buffer.id] || 0))) {
    throw new Error('Not enough in this envelope or in Buffer. Move money in first.');
  }
  const lines = [{ env: envId, delta: -(amount - short) }];
  if (short > 0) lines.push({ env: buffer.id, delta: -short });
  return {
    id: uid(), ts: now.toISOString(), type: 'expense', amount, env: envId, note,
    lines: lines.filter((l) => l.delta !== 0),
  };
}

export function makeTransfer(state, from, to, amount, note = '', now = new Date()) {
  if (amount <= 0) throw new Error('Enter an amount.');
  if (from === to) throw new Error('Pick two different envelopes.');
  return {
    id: uid(), ts: now.toISOString(), type: 'transfer', amount, from, to, note,
    lines: [{ env: from, delta: -amount }, { env: to, delta: amount }],
  };
}

/** If a new budget month has started, sweep what is left in the spending
 *  envelopes into Buffer/Savings. Returns the sweep transaction, or null. */
export function rollover(state, now = new Date()) {
  const key = periodKey(now, state.settings.startDay);
  if (state.settings.period === key) return null;
  state.settings.period = key;
  const b = balances(state);
  const lines = [];
  let total = 0;
  for (const e of state.envelopes) {
    if (e.kind === 'spend' && b[e.id] > 0) {
      lines.push({ env: e.id, delta: -b[e.id] });
      total += b[e.id];
    }
  }
  if (total === 0) return null;
  const buffer = reserve(state, 'buffer');
  const savings = reserve(state, 'savings');
  const split = splitReserve(total, state.settings, b[buffer.id] || 0);
  if (split.buffer) lines.push({ env: buffer.id, delta: split.buffer });
  if (split.savings) lines.push({ env: savings.id, delta: split.savings });
  const txn = {
    id: uid(), ts: now.toISOString(), type: 'sweep', amount: total, note: '',
    toBuffer: split.buffer, toSavings: split.savings, lines,
  };
  state.txns.push(txn);
  return txn;
}

/** Check a backup file before it replaces the data on the device. */
export function validateImport(data) {
  const s = data && data.state ? data.state : data;
  const ok =
    s && typeof s === 'object' &&
    Array.isArray(s.envelopes) && Array.isArray(s.txns) &&
    s.settings && typeof s.settings === 'object' &&
    s.envelopes.every((e) => e && typeof e.id === 'string' && typeof e.name === 'string') &&
    s.envelopes.some((e) => e.kind === 'buffer') &&
    s.envelopes.some((e) => e.kind === 'savings') &&
    s.txns.every((t) => t && Array.isArray(t.lines) &&
      t.lines.every((l) => typeof l.env === 'string' && Number.isInteger(l.delta)));
  if (!ok) throw new Error('This file is not a valid Envelope backup.');
  return s;
}
