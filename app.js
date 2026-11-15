import * as L from './logic.js';
import { load, save } from './store.js';

let state;
let tab = 'home';
let notice = null;          // one-off message shown on the home screen
let backupDismissed = false;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n < 0 ? '−' : '') + state.settings.currency + Math.abs(n).toLocaleString('en');
const envName = (id) => state.envelopes.find((e) => e.id === id)?.name ?? '(removed)';
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined,
  { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function commit() {
  await save(state);
  render();
}

function sweepNotice(sweep) {
  return `New month: ${fmt(sweep.amount)} left unspent was moved to Buffer (${fmt(sweep.toBuffer)}) and Savings (${fmt(sweep.toSavings)}).`;
}

/* ---------- Screens ---------- */

function viewHome() {
  const bal = L.balances(state);
  const funded = L.fundedInPeriod(state, L.periodKey(new Date(), state.settings.startDay));
  const spend = L.spendEnvelopes(state);
  const total = L.activeEnvelopes(state).reduce((s, e) => s + bal[e.id], 0);
  const last = state.settings.lastBackup ? new Date(state.settings.lastBackup).getTime() : 0;
  // Nudge once the oldest change that is not in a backup is more than 3 days old.
  const oldestUnsaved = state.txns.map((t) => new Date(t.ts).getTime()).find((ts) => ts > last);
  const stale = oldestUnsaved && Date.now() - oldestUnsaved > 3 * 864e5 && !backupDismissed;

  const spendCards = spend.map((e, i) => {
    const f = funded[e.id] || 0;
    const pct = e.target > 0 ? Math.min(100, Math.round((bal[e.id] / e.target) * 100)) : 0;
    const need = Math.max(0, e.target - f);
    return `<button class="env" data-action="spend" data-env="${e.id}">
      <div class="env-top">
        <div class="env-name"><i class="rank">${i + 1}</i><span>${esc(e.name)}</span></div>
        <div class="env-bal num">${fmt(bal[e.id])}</div>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="env-sub num">
        <span>Funded ${fmt(f)} of ${fmt(e.target)}</span>
        ${need > 0 ? `<span class="need">Needs ${fmt(need)}</span>` : '<span>Fully funded</span>'}
      </div>
    </button>`;
  }).join('');

  const reserveCards = ['buffer', 'savings'].map((kind) => {
    const e = L.reserve(state, kind);
    const cap = kind === 'buffer' && state.settings.bufferCap > 0
      ? `Cap ${fmt(state.settings.bufferCap)}` : '';
    const sub = kind === 'buffer'
      ? `Covers overspending. Gets ${state.settings.bufferPct}% of extra money.`
      : `Gets ${100 - state.settings.bufferPct}% of extra money.`;
    return `<button class="env" data-action="spend" data-env="${e.id}">
      <div class="env-top">
        <div class="env-name"><span>${esc(e.name)}</span></div>
        <div class="env-bal num">${fmt(bal[e.id])}</div>
      </div>
      <div class="env-sub"><span>${sub}</span><span class="num">${cap}</span></div>
    </button>`;
  }).join('');

  return `
    <header class="total">
      <small>Total across all envelopes</small>
      <strong class="num">${fmt(total)}</strong>
    </header>
    <div class="actions">
      <button class="btn primary" data-action="income">Add income</button>
      <button class="btn" data-action="spend">Spend</button>
      <button class="btn" data-action="move">Move</button>
    </div>
    ${notice ? `<div class="banner"><p>${esc(notice)}</p><button class="x" data-action="dismiss-notice" aria-label="Dismiss">×</button></div>` : ''}
    ${stale ? `<div class="banner warn"><p>You have changes that are not backed up. <button class="link" data-action="export">Back up now</button></p><button class="x" data-action="dismiss-backup" aria-label="Dismiss">×</button></div>` : ''}
    <h3>This month, in priority order</h3>
    <div class="list">${spendCards || '<p class="empty">No spending envelopes yet. Add one in Settings.</p>'}</div>
    <h3>Reserves</h3>
    <div class="list">${reserveCards}</div>`;
}

function txnCard(t) {
  const parts = (sign) => t.lines.filter((l) => Math.sign(l.delta) === sign)
    .map((l) => `${esc(envName(l.env))} ${fmt(Math.abs(l.delta))}`).join(' · ');
  let title, amount, meta;
  if (t.type === 'income') {
    title = 'Income'; amount = `<span class="in num">+${fmt(t.amount)}</span>`; meta = parts(1);
  } else if (t.type === 'expense') {
    title = esc(envName(t.env)); amount = `<span class="num">−${fmt(t.amount)}</span>`;
    meta = t.lines.length > 1 ? `Paid from ${parts(-1)}` : '';
  } else if (t.type === 'transfer') {
    title = `${esc(envName(t.from))} → ${esc(envName(t.to))}`; amount = `<span class="num">${fmt(t.amount)}</span>`; meta = '';
  } else {
    title = 'Month-end sweep'; amount = `<span class="num">${fmt(t.amount)}</span>`;
    meta = `From ${parts(-1)}. To ${parts(1)}`;
  }
  const note = t.note ? esc(t.note) : '';
  return `<div class="txn">
    <div class="txn-top"><span>${title}</span>${amount}</div>
    ${note ? `<div class="txn-meta">${note}</div>` : ''}
    ${meta ? `<div class="txn-meta num">${meta}</div>` : ''}
    <div class="txn-foot"><span>${fmtDate(t.ts)}</span>
      <button class="link" data-action="undo" data-id="${t.id}">Undo</button></div>
  </div>`;
}

function viewHistory() {
  const items = [...state.txns].reverse();
  if (!items.length) return '<h2>History</h2><p class="empty">Nothing yet. Add your first income from the Envelopes tab.</p>';
  const shown = items.slice(0, 200);
  return `<h2>History</h2><h3>${items.length} ${items.length === 1 ? 'entry' : 'entries'}</h3>
    <div class="list">${shown.map(txnCard).join('')}</div>
    ${items.length > shown.length ? '<p class="empty">Showing the latest 200. Older entries are kept and included in backups.</p>' : ''}`;
}

function viewSettings() {
  const s = state.settings;
  const bal = L.balances(state);
  const spend = L.spendEnvelopes(state);
  const rows = spend.map((e, i) => `
    <div class="erow" data-env="${e.id}">
      <input data-field="name" value="${esc(e.name)}" maxlength="24" aria-label="Envelope name">
      <input data-field="target" class="num" inputmode="decimal" value="${e.target}" aria-label="Monthly target for ${esc(e.name)}">
      <div class="tools">
        <span>Priority ${i + 1}</span>
        <button class="icon-btn" data-action="up" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(e.name)} up">↑</button>
        <button class="icon-btn" data-action="down" ${i === spend.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(e.name)} down">↓</button>
        <button class="icon-btn" data-action="remove" aria-label="Remove ${esc(e.name)}">✕</button>
      </div>
    </div>`).join('');
  const last = s.lastBackup ? new Date(s.lastBackup).toLocaleString() : 'never';
  const total = spend.reduce((t, e) => t + (e.target || 0), 0);

  return `<h2>Settings</h2>
    <h3>Spending envelopes</h3>
    <div class="card">
      <p>Income fills these from top to bottom, each up to its monthly target. Targets total <b class="num">${fmt(total)}</b> a month.</p>
      ${rows}
      <div class="btn-row" style="margin-top:10px"><button class="btn small" data-action="add-env">Add envelope</button></div>
    </div>

    <h3>Extra money and leftovers</h3>
    <div class="card">
      <label class="field"><span>Share that goes to Buffer (%)</span>
        <input id="set-pct" class="num" inputmode="numeric" value="${s.bufferPct}">
        <small>The other ${100 - s.bufferPct}% goes to Savings. Applies to income beyond your targets and to money left unspent at month end.</small></label>
      <label class="field"><span>Buffer cap (0 for none)</span>
        <input id="set-cap" class="num" inputmode="decimal" value="${s.bufferCap}">
        <small>Once Buffer holds this much, everything extra goes to Savings.</small></label>
      <label class="field"><span>Budget month starts on day</span>
        <input id="set-start" class="num" inputmode="numeric" value="${s.startDay}">
        <small>Set this to your payday (1 to 28) so a late-month salary is not swept days after it arrives.</small></label>
      <label class="field" style="margin-bottom:0"><span>Currency symbol</span>
        <input id="set-cur" value="${esc(s.currency)}" maxlength="4"></label>
    </div>

    <h3>Backup</h3>
    <div class="card">
      <p>Your data lives only on this device. Save a backup file somewhere else (Drive, email, WhatsApp to yourself) so you can restore it. Last backup: <b>${esc(last)}</b>.</p>
      <div class="btn-row">
        <button class="btn primary" data-action="export">Save backup file</button>
        <button class="btn" data-action="import">Restore from file</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
    </div>
    <p class="empty" style="padding:16px">Balances: ${L.activeEnvelopes(state).map((e) => `${esc(e.name)} ${fmt(bal[e.id])}`).join(' · ')}</p>`;
}

function render() {
  $('#view').innerHTML = tab === 'home' ? viewHome() : tab === 'history' ? viewHistory() : viewSettings();
  for (const b of $$('.tabs button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
}

/* ---------- Dialogs ---------- */

function openDialog(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  d.showModal();
  $$('[data-close]', d).forEach((b) => b.addEventListener('click', () => d.close()));
  return d;
}

function envOptions(selected, list = L.activeEnvelopes(state)) {
  const bal = L.balances(state);
  return list.map((e) =>
    `<option value="${e.id}" ${e.id === selected ? 'selected' : ''}>${esc(e.name)} (${fmt(bal[e.id])})</option>`).join('');
}

function dlgIncome() {
  let total = 0;
  let alloc = [];
  const d = openDialog(`<form id="f">
    <h2>Add income</h2>
    <label class="field"><span>Amount received</span>
      <input id="amt" class="num" inputmode="decimal" autocomplete="off" placeholder="e.g. 30000 or 30k"></label>
    <div id="split-wrap" hidden>
      <div class="split" id="split"></div>
      <div class="split-foot"><span id="rem"></span><button type="button" class="link" id="reset">Use suggested split</button></div>
    </div>
    <label class="field"><span>Note (optional)</span><input id="note" maxlength="80" autocomplete="off"></label>
    <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button>
      <button class="btn primary" id="ok" disabled>Confirm</button></div>
  </form>`);

  const check = () => {
    const sum = alloc.reduce((s, a) => s + a.amount, 0);
    const diff = total - sum;
    const rem = $('#rem', d);
    rem.className = diff === 0 ? 'good' : 'bad';
    rem.textContent = diff === 0 ? 'Fully assigned'
      : diff > 0 ? `${fmt(diff)} still to assign` : `${fmt(-diff)} over the amount`;
    $('#ok', d).disabled = !(total > 0 && diff === 0);
  };
  const draw = () => {
    $('#split-wrap', d).hidden = total <= 0;
    $('#split', d).innerHTML = alloc.map((a, i) => `<label class="split-row">
      <span>${esc(envName(a.env))}</span>
      <input class="num" inputmode="decimal" data-i="${i}" value="${a.amount}" autocomplete="off"></label>`).join('');
    check();
  };
  const suggest = () => { alloc = total > 0 ? L.allocate(state, total) : []; draw(); };

  $('#amt', d).addEventListener('input', (e) => { total = L.parseAmount(e.target.value); suggest(); });
  $('#reset', d).addEventListener('click', suggest);
  $('#split', d).addEventListener('input', (e) => {
    alloc[+e.target.dataset.i].amount = L.parseAmount(e.target.value);
    check();
  });
  $('#f', d).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      L.applyTxn(state, L.makeIncome(state, total, alloc, $('#note', d).value.trim()));
      d.close();
      await commit();
      toast(`${fmt(total)} added`);
    } catch (err) { toast(err.message); }
  });
  $('#amt', d).focus();
}

function dlgSpend(preselect) {
  const buffer = L.reserve(state, 'buffer');
  const first = preselect || L.spendEnvelopes(state)[0]?.id || buffer.id;
  const d = openDialog(`<form id="f">
    <h2>Record spending</h2>
    <label class="field"><span>From envelope</span><select id="env">${envOptions(first)}</select></label>
    <label class="field"><span>Amount spent</span>
      <input id="amt" class="num" inputmode="decimal" autocomplete="off" placeholder="e.g. 1500"></label>
    <p class="hint" id="hint" hidden></p>
    <label class="field"><span>What was it for? (optional)</span><input id="note" maxlength="80" autocomplete="off"></label>
    <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button>
      <button class="btn primary" id="ok" disabled>Save</button></div>
  </form>`);

  const check = () => {
    const bal = L.balances(state);
    const env = $('#env', d).value;
    const amount = L.parseAmount($('#amt', d).value);
    const short = Math.max(0, amount - bal[env]);
    const hint = $('#hint', d);
    const blocked = short > 0 && (env === buffer.id || short > bal[buffer.id]);
    hint.hidden = short === 0;
    hint.className = 'hint ' + (blocked ? 'bad' : 'warn');
    hint.textContent = blocked
      ? `${envName(env)} is short by ${fmt(short)} and Buffer cannot cover it. Move money in first.`
      : `${envName(env)} is short by ${fmt(short)}. The gap will come from Buffer (${fmt(bal[buffer.id])}).`;
    $('#ok', d).disabled = !(amount > 0) || blocked;
  };
  $('#env', d).addEventListener('change', check);
  $('#amt', d).addEventListener('input', check);
  $('#f', d).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const amount = L.parseAmount($('#amt', d).value);
      const env = $('#env', d).value;
      L.applyTxn(state, L.makeExpense(state, env, amount, $('#note', d).value.trim()));
      d.close();
      await commit();
      toast(`${fmt(amount)} spent from ${envName(env)}`);
    } catch (err) { toast(err.message); }
  });
  $('#amt', d).focus();
}

function dlgMove() {
  const envs = L.activeEnvelopes(state);
  const bal = L.balances(state);
  const from = envs.find((e) => bal[e.id] > 0)?.id || envs[0].id;
  const to = envs.find((e) => e.id !== from).id;
  const d = openDialog(`<form id="f">
    <h2>Move money</h2>
    <label class="field"><span>From</span><select id="from">${envOptions(from)}</select></label>
    <label class="field"><span>To</span><select id="to">${envOptions(to)}</select></label>
    <label class="field"><span>Amount</span>
      <input id="amt" class="num" inputmode="decimal" autocomplete="off"></label>
    <p class="hint bad" id="hint" hidden></p>
    <div class="btn-row"><button type="button" class="btn" data-close>Cancel</button>
      <button class="btn primary" id="ok" disabled>Move</button></div>
  </form>`);
  const check = () => {
    const f = $('#from', d).value, t = $('#to', d).value;
    const amount = L.parseAmount($('#amt', d).value);
    const msg = f === t ? 'Pick two different envelopes.'
      : amount > bal[f] ? `${envName(f)} only has ${fmt(bal[f])}.` : '';
    $('#hint', d).hidden = !msg;
    $('#hint', d).textContent = msg;
    $('#ok', d).disabled = !(amount > 0) || !!msg;
  };
  d.addEventListener('input', check);
  $('#f', d).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const amount = L.parseAmount($('#amt', d).value);
      L.applyTxn(state, L.makeTransfer(state, $('#from', d).value, $('#to', d).value, amount));
      d.close();
      await commit();
      toast(`${fmt(amount)} moved`);
    } catch (err) { toast(err.message); }
  });
  $('#amt', d).focus();
}

function confirmDialog(title, body, okLabel, danger = false) {
  return new Promise((resolve) => {
    const d = openDialog(`<h2>${esc(title)}</h2><p class="hint" style="margin:0 0 16px">${esc(body)}</p>
      <div class="btn-row"><button class="btn" data-close>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" id="yes">${esc(okLabel)}</button></div>`);
    let answer = false;
    $('#yes', d).addEventListener('click', () => { answer = true; d.close(); });
    d.addEventListener('close', () => resolve(answer), { once: true });
  });
}

/* ---------- Backup ---------- */

async function exportBackup() {
  const stamp = new Date().toISOString();
  const data = JSON.stringify({ app: 'envelope-budget', exportedAt: stamp, state }, null, 1);
  const name = `envelope-backup-${stamp.slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  state.settings.lastBackup = stamp;
  await commit();
  toast('Backup saved to Downloads. Copy it off this phone.');
}

async function importBackup(file) {
  try {
    const incoming = L.validateImport(JSON.parse(await file.text()));
    const ok = await confirmDialog('Restore this backup?',
      `This replaces everything on this device with the backup (${incoming.txns.length} entries). This cannot be undone.`,
      'Replace my data', true);
    if (!ok) return;
    state = incoming;
    const sweep = L.rollover(state);
    notice = sweep ? sweepNotice(sweep) : null;
    tab = 'home';
    await commit();
    toast('Backup restored');
  } catch (err) {
    toast(err instanceof SyntaxError ? 'This file is not a valid Envelope backup.' : err.message);
  }
}

/* ---------- Events ---------- */

document.addEventListener('click', async (ev) => {
  const tabBtn = ev.target.closest('.tabs button');
  if (tabBtn) { tab = tabBtn.dataset.tab; render(); window.scrollTo(0, 0); return; }

  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const row = el.closest('[data-env]');
  const spend = L.spendEnvelopes(state);

  if (action === 'income') dlgIncome();
  else if (action === 'spend') dlgSpend(el.dataset.env);
  else if (action === 'move') dlgMove();
  else if (action === 'export') exportBackup();
  else if (action === 'import') $('#import-file').click();
  else if (action === 'dismiss-notice') { notice = null; render(); }
  else if (action === 'dismiss-backup') { backupDismissed = true; render(); }
  else if (action === 'undo') {
    const ok = await confirmDialog('Undo this entry?', 'It will be removed and balances recalculated.', 'Undo entry', true);
    if (!ok) return;
    try { L.removeTxn(state, el.dataset.id); await commit(); toast('Entry removed'); }
    catch (err) { toast(err.message + ' Undo the later spending first.'); }
  }
  else if (action === 'add-env') {
    const at = state.envelopes.findIndex((e) => e.kind !== 'spend');
    state.envelopes.splice(at, 0, { id: L.uid(), name: 'New envelope', kind: 'spend', target: 0 });
    await commit();
  }
  else if (action === 'up' || action === 'down') {
    const i = spend.findIndex((e) => e.id === row.dataset.env);
    const other = spend[i + (action === 'up' ? -1 : 1)];
    const a = state.envelopes.indexOf(spend[i]);
    const b = state.envelopes.indexOf(other);
    [state.envelopes[a], state.envelopes[b]] = [state.envelopes[b], state.envelopes[a]];
    await commit();
  }
  else if (action === 'remove') {
    const env = state.envelopes.find((e) => e.id === row.dataset.env);
    if (L.balances(state)[env.id] !== 0) { toast(`Move the money out of ${env.name} first.`); return; }
    const ok = await confirmDialog(`Remove ${env.name}?`, 'Its past entries stay in your history.', 'Remove', true);
    if (!ok) return;
    env.archived = true;
    await commit();
  }
});

// Settings fields save as soon as you leave them.
document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'import-file') { if (t.files[0]) await importBackup(t.files[0]); t.value = ''; return; }
  if (t.closest('dialog')) return;
  const s = state.settings;
  const row = t.closest('.erow');
  if (row) {
    const env = state.envelopes.find((e) => e.id === row.dataset.env);
    if (t.dataset.field === 'name') env.name = t.value.trim() || env.name;
    if (t.dataset.field === 'target') env.target = L.parseAmount(t.value);
  } else if (t.id === 'set-pct') {
    s.bufferPct = Math.min(100, Math.max(0, Math.round(Number(t.value)) || 0));
  } else if (t.id === 'set-cap') {
    s.bufferCap = L.parseAmount(t.value);
  } else if (t.id === 'set-start') {
    s.startDay = Math.min(28, Math.max(1, Math.round(Number(t.value)) || 1));
    s.period = L.periodKey(new Date(), s.startDay); // changing the start day must not trigger a sweep
  } else if (t.id === 'set-cur') {
    s.currency = t.value.trim();
  } else return;
  await commit();
});

/* ---------- Start ---------- */

async function start() {
  try {
    state = (await load()) || L.defaultState();
  } catch {
    state = L.defaultState();
    toast('Storage is unavailable, so nothing will be saved in this browser.');
  }
  const sweep = L.rollover(state);
  if (sweep) notice = sweepNotice(sweep);
  await save(state).catch(() => {});
  render();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // Ask the browser not to clear our data when the phone runs low on space.
  navigator.storage?.persist?.().catch(() => {});
}

// Catch a month change while the app stays open in the background.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !state || $('#dlg').open) return;
  const sweep = L.rollover(state);
  if (sweep) { notice = sweepNotice(sweep); await commit(); }
});

start();
