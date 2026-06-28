// companion.js — AI Companion (pure MCP). Off by default. When enabled, the
// page exposes the live game to the player's own Claude through our remote MCP
// server: it pushes the position after every move, shows the connector URL +
// pairing code, and mirrors Claude's suggestions as click-to-play cards.
// The conversation itself happens in the player's Claude app.
// position.js pulls in chess.js (~108KB); load it lazily only when the
// companion is actually enabled, so the default page stays light.
let buildPosition = null, readState = null, Chess = null;
async function ensurePos() { if (!buildPosition) ({ buildPosition, readState, Chess } = await import('./position.js')); }
const curPos = () => buildPosition(readState(window.SG));

// Authoritative move history: keep a chess.js game in step with the real
// position by reconciling it (≤2 plies, since the engine usually replies
// between our pushes) against the authoritative FEN. The board-diff move log
// can mislabel/merge fast 2-ply changes; this never does.
let trackerGame = null;
const fenKey = (fen) => { const f = fen.split(' '); return f[0] + ' ' + f[1]; };   // placement + side
const movetext = (g) => g.pgn().replace(/\[[^\]]*\]\s*/g, '').replace(/\*\s*$/, '').trim();  // moves only, no headers
function authPgn(curFen) {
  try {
    if (!trackerGame) trackerGame = new Chess();
    if (fenKey(trackerGame.fen()) === fenKey(curFen)) return movetext(trackerGame);
    for (const m of trackerGame.moves({ verbose: true })) {            // 1 ply
      trackerGame.move(m);
      if (fenKey(trackerGame.fen()) === fenKey(curFen)) return movetext(trackerGame);
      trackerGame.undo();
    }
    for (const m1 of trackerGame.moves({ verbose: true })) {           // 2 plies (you + engine)
      trackerGame.move(m1);
      for (const m2 of trackerGame.moves({ verbose: true })) {
        trackerGame.move(m2);
        if (fenKey(trackerGame.fen()) === fenKey(curFen)) return movetext(trackerGame);
        trackerGame.undo();
      }
      trackerGame.undo();
    }
    trackerGame = new Chess(curFen);                                   // jump (new game / take-back / load) — history restarts
    return '';
  } catch (e) { try { trackerGame = new Chess(curFen); } catch (_) { trackerGame = null; } return ''; }
}
// signature of the board the current suggestion cards belong to (staleness guard)
function boardSig() { const b = window.SG.board(); let h = 0; for (let i = 0; i < 128; i++) h = (Math.imul(h, 31) + b[i]) | 0; return h; }
let sugSig = null;        // board the current cards belong to
let pushedSig = null;     // board last pushed to the server

const API = (typeof window.SG_API_BASE === 'string' && window.SG_API_BASE)
  ? window.SG_API_BASE
  : (location.port === '8099' ? `${location.protocol}//${location.hostname}:8100` : '');
const MCP_URL = `${API || location.origin}/mcp`;

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) } }).then(r => r.json());
const alg2sq = (a) => (a.charCodeAt(1) - 49) * 16 + (a.charCodeAt(0) - 97);   // 'e2' -> 0x14

let enabled = localStorage.getItem('sg_companion') === '1';
let autoPlay = localStorage.getItem('sg_companion_autoplay') === '1';
let session = null;                 // {sessionId, code}
let pollTimer = null, lastSugAt = 0, handledCmd = new Set();

function init() {
  const tog = $('companion-enable');
  tog.checked = enabled;
  tog.onchange = () => { enabled = tog.checked; localStorage.setItem('sg_companion', enabled ? '1' : '0'); enabled ? start() : stop(); };
  const ap = $('companion-autoplay');
  if (ap) { ap.checked = autoPlay; ap.onchange = () => { autoPlay = ap.checked; localStorage.setItem('sg_companion_autoplay', autoPlay ? '1' : '0'); }; }
  // re-push the position to Claude after every ply, and clear stale cards
  window.SG.onPly(() => { if (enabled && session) { pushState(); clearCards('position changed — ask Claude for fresh advice'); } });
  if (enabled) start();
}

async function start() {
  $('companion-body').classList.remove('hidden');
  trackerGame = null;                       // fresh move-history tracking each session
  try {
    const saved = JSON.parse(localStorage.getItem('sg_companion_session') || 'null');
    session = saved && saved.sessionId ? saved : await openSession();
    localStorage.setItem('sg_companion_session', JSON.stringify(session));
  } catch (e) { session = await openSession().catch(() => null); }
  if (!session) { setStatus('offline', 'backend unreachable'); return; }
  $('companion-url').textContent = MCP_URL;
  $('companion-code').textContent = session.code;
  // fill the per-client setup snippets with the real URL + code
  const d = $('companion-desktop');
  if (d) d.textContent = JSON.stringify({ mcpServers: { 'spectral-gambit': { command: 'npx', args: ['-y', 'mcp-remote', MCP_URL] } } }, null, 2);
  const cli = $('companion-cli');
  if (cli) cli.textContent = `claude mcp add --transport http spectral-gambit ${MCP_URL}`;
  document.querySelectorAll('.codeRef').forEach(e => (e.textContent = session.code));
  await pushState();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 3000);
  poll();
}
function stop() {
  $('companion-body').classList.add('hidden');
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
async function openSession() {
  const r = await api('/api/companion/open', { method: 'POST', body: '{}' });
  return r && r.sessionId ? r : null;
}

async function pushState() {
  if (!session) return;
  await ensurePos();
  pushedSig = boardSig();                 // mark before the await so poll won't re-trigger
  const pos = curPos();
  const ev = (window.SG.screen().match(/Eval (-?\d+)/) || [])[1];
  const r = await api('/api/companion/state', { method: 'POST', body: JSON.stringify({
    sessionId: session.sessionId, fen: pos.fen, pgn: authPgn(pos.fen), side: pos.side,
    eval: ev ? parseInt(ev, 10) : 0, level: window.SG.level(), legalMoves: pos.legal,
  }) }).catch(() => null);
  if (r && 'connected' in r) reflectConnected(r.connected);
}

async function poll() {
  if (!session) return;
  // catch ANY board change the move-log hooks miss — New game, Take back, slot
  // load, import — and re-sync the position to the server.
  if (pushedSig !== null && boardSig() !== pushedSig) await pushState();
  const r = await api(`/api/companion/poll?sessionId=${session.sessionId}`).catch(() => null);
  if (!r) { setStatus('offline', 'backend unreachable'); return; }
  if (r.error) { localStorage.removeItem('sg_companion_session'); session = await openSession(); return; }
  reflectConnected(r.connected);
  if (r.suggestions && r.suggestions.at && r.suggestions.at !== lastSugAt) {
    lastSugAt = r.suggestions.at;
    renderCards(r.suggestions);
    logLine(r.suggestions);
  }
  for (const c of r.commands || []) if (!handledCmd.has(c.id)) { handledCmd.add(c.id); handleCommand(c); }
  // robust staleness guard: if the board changed since the cards were shown
  // (a manual move, an engine reply, anything), retire them — even if onPly missed it
  if (sugSig !== null && boardSig() !== sugSig) clearCards('position changed — ask Claude for fresh advice');
}

function reflectConnected(c) { setStatus(c ? 'connected' : 'waiting', c ? 'Claude connected ✓' : 'waiting for Claude…'); }
function setStatus(cls, text) { const el = $('companion-status'); if (el) { el.textContent = text; el.className = 'comp-status ' + cls; } }

// ---- suggestion cards ----
function clearCards(msg) { sugSig = null; $('companion-suggestions').innerHTML = msg ? `<p class="dim small">${msg}</p>` : ''; }
function renderCards(sug) {
  sugSig = boardSig();                  // these cards belong to the current board
  const wrap = $('companion-suggestions');
  wrap.innerHTML = sug.comment ? `<p class="comp-comment">${esc(sug.comment)}</p>` : '';
  for (const c of sug.candidates || []) {
    const card = document.createElement('div');
    card.className = 'comp-card' + (c.legal === false ? ' illegal' : '');
    card.innerHTML = `<div class="comp-move">${esc(c.san)}${c.legal === false ? ' <span class="warn">illegal?</span>' : ''}</div>` +
      `<div class="comp-why">${esc(c.rationale || '')}</div>`;
    if (c.legal !== false) {
      const b = document.createElement('button'); b.textContent = 'Play'; b.className = 'comp-play';
      b.onclick = () => playSan(c.san);
      card.appendChild(b);
    }
    wrap.appendChild(card);
  }
}
function logLine(sug) {
  const log = $('companion-log'); if (!log) return;
  const moves = (sug.candidates || []).map(c => c.san).join(', ');
  const li = document.createElement('div'); li.className = 'comp-logline';
  li.textContent = (sug.comment ? sug.comment + ' — ' : '') + moves;
  log.prepend(li);
  while (log.children.length > 8) log.removeChild(log.lastChild);
}

// ---- playing moves ----
async function playSan(san) {
  await ensurePos();
  const pos = curPos();
  const m = pos.sanToMove(san);
  if (!m) { window.SG.flash(`${san} isn't legal now — the position changed`); clearCards('position changed — ask Claude for fresh advice'); return; }
  window.SG.markAssisted();                  // this game used AI help (flagged on the ladder)
  window.SG.tapSquare(alg2sq(m.from));
  window.SG.tapSquare(alg2sq(m.to));        // navTo chains via predicted cursor
  window.SG.flash(`playing ${san}`);
}

function handleCommand(c) {
  if (c.type !== 'play') return;
  if (autoPlay) { playSan(c.san); ack(c.id, 'done'); return; }
  const box = $('companion-cmd');
  box.innerHTML = `<span>Claude wants to play <b>${esc(c.san)}</b></span>`;
  const yes = btn('Play', () => { playSan(c.san); ack(c.id, 'done'); box.innerHTML = ''; });
  const no = btn('Dismiss', () => { ack(c.id, 'dismissed'); box.innerHTML = ''; }); no.className = 'ghost';
  box.append(yes, no);
}
function ack(commandId, result) { api('/api/companion/ack', { method: 'POST', body: JSON.stringify({ sessionId: session.sessionId, commandId, result }) }).catch(() => {}); }

// ---- helpers ----
function btn(label, fn) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b; }
function esc(s) { return String(s || '').replace(/[<>&]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m])); }

window.SG ? boot() : window.addEventListener('load', boot);
function boot() { if (window.SG && window.SG.onReady) window.SG.onReady(init); else setTimeout(boot, 200); }
