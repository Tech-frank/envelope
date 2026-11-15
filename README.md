# Envelope Budget

An offline envelope budgeting app (PWA). All data stays on the device in IndexedDB.

## How money is split

1. Income fills the spending envelopes in priority order, each up to its monthly target.
2. A later income in the same month only tops up envelopes that are still short.
3. Anything beyond the targets goes to Buffer (30%) and Savings (70%).
4. When a new budget month starts, whatever is left in the spending envelopes is swept to Buffer and Savings in the same ratio.
5. Spending more than an envelope holds takes the gap from Buffer, or is refused if Buffer cannot cover it.

Targets, priority order, the Buffer share, an optional Buffer cap and the day the budget month starts are all editable in Settings.

## Run locally

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080.

## Tests

```bash
npm test
```

## Put it on your phone

The app must be served over HTTPS to be installable. Upload this folder as-is (no build step) to any static host, for example GitHub Pages, Cloudflare Pages or Netlify. Open the address in Chrome on Android, then choose "Add to Home screen" / "Install app" from the menu.

When you change any file, bump `CACHE` in `sw.js` (for example `envelope-v2`) so phones pick up the new version.

## Files

- `logic.js`: the budgeting rules, with no browser dependencies (tested in `tests/`)
- `store.js`: IndexedDB load and save
- `app.js`, `index.html`, `styles.css`: the screens
- `sw.js`, `manifest.webmanifest`, `icons/`: offline support and install
