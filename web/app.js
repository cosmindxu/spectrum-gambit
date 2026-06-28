// app.js — Spectral Gambit front-end.
// Drives the WASM emulator: runs frames, renders the ZX screen to a
// canvas, feeds live keys, derives a move log, and auto-saves full
// machine state so a game can be put down and resumed hours later.
import { diffMove, toMovetext, sq2alg } from './chess.js';

const HOLD = 6, GAP = 6;             // key pulse: frames down / frames gap
const SPEED_PLAY = 4;                // emulated frames per tick when idle
const SPEED_TURBO = 48;              // when the engine is thinking / booting
const FRAME_BUDGET_MS = 10;          // hard cap on emulation time per tick

let M, sg = {}, fbPtr, FBW, FBH, imageData, ctx, boardBuf;
let emuFrame = 0, ready = false;
let prevBoard = new Uint8Array(128);
let history = [];                    // [{san, side, from, to, ...}]
let lastStatus = '', lastEngineMove = '', curLevel = 2, reportedOver = '';
let queue = [], active = null;       // input pulse state machine
let onPlyCbs = [], onOverCbs = []; // hooks (clock, compete, companion) — multi-subscriber
let aiMoveCount = 0, playerMoveCount = 0;   // AI-played vs total of YOUR (White) moves this game

const START_FEN_BOARD = buildStartBoard();

// ---------- boot ----------
SpectralGambit().then((mod) => {
  M = mod;
  sg.init   = M.cwrap('sg_init', 'number', []);
  sg.run    = M.cwrap('sg_run_frame', 'void', []);
  sg.fb     = M.cwrap('sg_framebuffer', 'number', []);
  sg.w      = M.cwrap('sg_fb_w', 'number', []);
  sg.h      = M.cwrap('sg_fb_h', 'number', []);
  sg.fc     = M.cwrap('sg_frame_counter', 'number', []);
  sg.key    = M.cwrap('sg_key', 'number', ['string', 'number']);
  sg.clear  = M.cwrap('sg_keys_clear', 'void', []);
  sg.text   = M.cwrap('sg_screen_text', 'number', []);
  sg.save   = M.cwrap('sg_save_state', 'number', ['string']);
  sg.load   = M.cwrap('sg_load_state', 'number', ['string']);
  sg.board  = M.cwrap('sg_board', 'void', ['number']);
  sg.peek   = M.cwrap('sg_peek', 'number', ['number']);
  sg.reset  = M.cwrap('sg_reset', 'number', []);

  FBW = sg.w(); FBH = sg.h();
  const canvas = document.getElementById('screen');
  canvas.width = FBW; canvas.height = FBH;
  ctx = canvas.getContext('2d', { alpha: false });
  imageData = ctx.createImageData(FBW, FBH);
  boardBuf = M._malloc(128);

  sg.init();
  wireUI();
  // Automatically restore the last game from a previous visit (the whole
  // point of the save-state). Falls through to a fresh boot if there's none.
  autoResume();
  requestAnimationFrame(loop);
});

// persist on the way out too, so the very latest state is never lost
function saveOnExit() { if (window.__sgNoSave) return; if (ready && history.length) autoSave(true); }
window.addEventListener('pagehide', saveOnExit);
window.addEventListener('beforeunload', saveOnExit);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveOnExit(); });

// ---------- main loop ----------
function loop() {
  const status = lastStatus;
  const turbo = !ready || /thinking/i.test(status);
  const target = turbo ? SPEED_TURBO : SPEED_PLAY;
  const t0 = performance.now();
  for (let i = 0; i < target; i++) {
    stepInput();
    sg.run();
    emuFrame++;
    if (performance.now() - t0 > FRAME_BUDGET_MS) break;
  }
  render();
  poll();
  requestAnimationFrame(loop);
}

function render() {
  fbPtr = sg.fb();
  imageData.data.set(M.HEAPU8.subarray(fbPtr, fbPtr + FBW * FBH * 4));
  ctx.putImageData(imageData, 0, 0);
}

// ---------- input: serialize taps into HOLD/GAP pulses ----------
function tap(name) { queue.push(name); }
function stepInput() {
  if (!active) {
    if (queue.length) {
      active = { name: queue.shift(), phase: 0, left: HOLD };
      sg.key(active.name, 1);
    }
    return;
  }
  if (--active.left <= 0) {
    if (active.phase === 0) { sg.key(active.name, 0); active.phase = 1; active.left = GAP; }
    else active = null;
  }
}

const CURSOR = { ArrowUp: 'Q', ArrowDown: 'A', ArrowLeft: 'O', ArrowRight: 'P' };
function mapKey(e) {
  if (e.key in CURSOR) return CURSOR[e.key];
  if (e.key === 'Enter') return 'ENTER';
  if (e.key === ' ') return 'SPACE';
  const k = e.key.toUpperCase();
  if (/^[A-Z0-9]$/.test(k)) return k;
  return null;
}
const REPEATABLE = new Set(['Q', 'A', 'O', 'P']);
function typingInField(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
window.addEventListener('keydown', (e) => {
  if (!ready) return;
  if (typingInField(e)) return;                   // let text boxes get their keys
  const name = mapKey(e);
  if (!name) return;
  e.preventDefault();
  if (e.repeat && !REPEATABLE.has(name)) return;  // no accidental double-select
  tap(name);
});

// ---------- tap-to-move (configurable; D-pad & keyboard still work) ----------
const BOARD = { x0: 64, y0: 40, sq: 16 };        // board rect in fb pixels (verified)
const CURSOR_SQ = 0xE086, FLIP_FLAG = 0xE095, AI_DEPTH = 0xE08A;
let tapMove = localStorage.getItem('sg_tapmove') !== '0';   // default ON
let predCursor = null;                            // predicted cursor square for chaining

// map a canvas pointer position to a 0x88 square, honouring board flip
function clickToSquare(clientX, clientY, canvas) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const fx = (clientX - r.left) * (FBW / r.width);
  const fy = (clientY - r.top) * (FBH / r.height);
  const col = Math.floor((fx - BOARD.x0) / BOARD.sq);
  const row = Math.floor((fy - BOARD.y0) / BOARD.sq);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  const flip = sg.peek(FLIP_FLAG) & 1;
  const file = flip ? 7 - col : col;
  const rank = flip ? row : 7 - row;
  return rank * 16 + file;
}

// drive the cursor from its current (or predicted) square to `sq`, then ENTER.
// movement is in board coords (Q=rank+,A=rank-,O=file-,P=file+), flip-independent.
function navTo(sq) {
  if ((!active && queue.length === 0) || predCursor == null) predCursor = sg.peek(CURSOR_SQ);
  let cf = predCursor & 7, cr = (predCursor >> 4) & 7;
  const tf = sq & 7, tr = (sq >> 4) & 7;
  while (cf < tf) { tap('P'); cf++; }
  while (cf > tf) { tap('O'); cf--; }
  while (cr < tr) { tap('Q'); cr++; }
  while (cr > tr) { tap('A'); cr--; }
  tap('ENTER');
  predCursor = sq;
}

function onBoardTap(clientX, clientY) {
  if (!ready || !tapMove) return;
  const sq = clickToSquare(clientX, clientY, document.getElementById('screen'));
  if (sq != null) navTo(sq);
}

// ---------- per-tick polling: status, board diff, autosave ----------
let pollCounter = 0;
function poll() {
  if (++pollCounter % 3 !== 0) return;            // ~20Hz is plenty
  const text = M.UTF8ToString(sg.text());
  lastStatus = extractStatus(text);
  updatePanel(text);

  if (!ready) {
    if (/your move|thinking|mate|draw|flag/i.test(text)) {
      ready = true;
      document.getElementById('loading').classList.add('hidden');
      sg.board(boardBuf);
      prevBoard.set(M.HEAPU8.subarray(boardBuf, boardBuf + 128));
    }
    return;
  }

  sg.board(boardBuf);
  const cur = M.HEAPU8.subarray(boardBuf, boardBuf + 128);
  if (!sameBoard(cur, prevBoard)) {
    if (isStartPosition(cur)) {                   // new game / reset
      history = []; renderLog(); aiMoveCount = 0; playerMoveCount = 0;
    } else {
      const mv = diffMove(prevBoard, cur);
      if (mv) {
        history.push(mv); renderLog();
        if (mv.side === 0) playerMoveCount++;     // a White (your) move
        onPlyCbs.forEach(cb => cb(mv, history.slice()));
      }
    }
    prevBoard.set(cur);
    predCursor = null;                            // re-sync tap-to-move after any move
    autoSave();                                   // persist after every ply
  }

  // fire a one-shot game-over event for the compete layer
  const ov = lastStatus.match(/checkmate|stalemate|white wins|black wins|draw|flag/i);
  if (ov && ov[0] !== reportedOver) { reportedOver = ov[0]; onOverCbs.forEach(cb => cb(lastStatus)); }
  else if (!ov) reportedOver = '';
}

function extractStatus(text) {
  const m = text.match(/(your move|thinking[.]*|checkmate|stalemate|white wins|black wins|draw|flag|illegal)/i);
  return m ? m[1] : '';
}

// ---------- panel + move log ----------
function updatePanel(text) {
  // read difficulty straight from RAM — the on-screen "Level" label is only
  // repainted on a full redraw, so it lags after a strength change.
  const lvl  = sg.peek(AI_DEPTH);
  const ev   = text.match(/Eval (-?\d+)/);
  const matl = text.match(/Matl (-?\d+)/);
  const emv  = text.match(/Move ([a-h][1-8][a-h][1-8])/);
  if (lvl >= 1 && lvl <= 5) curLevel = lvl;
  set('lvl', (lvl >= 1 && lvl <= 5) ? lvl : '–');
  set('eval', ev ? signed(ev[1]) : '–');
  set('matl', matl ? signed(matl[1]) : '–');
  const st = lastStatus || '…';
  const badge = document.getElementById('status');
  badge.textContent = st.replace(/\.+$/, '');
  badge.className = 'status ' + (/thinking/i.test(st) ? 'thinking'
    : /your move/i.test(st) ? 'yourmove'
    : /mate|wins|flag/i.test(st) ? 'over' : '');
  if (emv) lastEngineMove = emv[1];
}
function signed(n) { n = parseInt(n, 10); return (n > 0 ? '+' : '') + (n / 100).toFixed(2); }

function renderLog() {
  const tbody = document.getElementById('movelog');
  tbody.innerHTML = '';
  for (let i = 0; i < history.length; i += 2) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="n">${i / 2 + 1}.</td>` +
      `<td>${history[i] ? history[i].san : ''}</td>` +
      `<td>${history[i + 1] ? history[i + 1].san : ''}</td>`;
    tbody.appendChild(tr);
  }
  const wrap = document.getElementById('logwrap');
  wrap.scrollTop = wrap.scrollHeight;
  set('movecount', history.length ? Math.ceil(history.length / 2) + ' moves' : '');
}

// ---------- persistence ----------
function readSzx() {
  if (sg.save('/state.szx') !== 0) return null;
  return M.FS.readFile('/state.szx');           // Uint8Array
}
function writeSzx(bytes) {
  M.FS.writeFile('/state.szx', bytes);
  if (sg.load('/state.szx') !== 0) return false;
  resyncAfterLoad();
  return true;
}
function resyncAfterLoad() {
  emuFrame = sg.fc();
  sg.clear(); queue = []; active = null;
  sg.board(boardBuf);
  prevBoard.set(M.HEAPU8.subarray(boardBuf, boardBuf + 128));
  ready = true;
  document.getElementById('loading').classList.add('hidden');
}

function autoSave(quiet) {
  const bytes = readSzx();
  if (!bytes) return;
  try {
    localStorage.setItem('sg_autosave', b64(bytes));
    localStorage.setItem('sg_autosave_log', JSON.stringify(history));
    localStorage.setItem('sg_autosave_at', new Date().toISOString());
    if (!quiet) flash('saved');
  } catch (e) { /* quota — ignore */ }
}

// Restore the last auto-saved game immediately on load. Returns true if a
// game was restored, false if there was nothing to restore (fresh boot).
function autoResume() {
  const saved = localStorage.getItem('sg_autosave');
  if (!saved) return false;
  try {
    if (!writeSzx(u8(saved))) return false;   // loads szx, marks ready
    history = JSON.parse(localStorage.getItem('sg_autosave_log') || '[]');
    renderLog();
    const at = localStorage.getItem('sg_autosave_at');
    const banner = document.getElementById('resume');
    banner.querySelector('.when').textContent = at ? ` (${new Date(at).toLocaleString()})` : '';
    banner.classList.remove('hidden');
    banner.querySelector('.fresh').onclick = startFresh;
    banner.querySelector('.dismiss').onclick = () => banner.classList.add('hidden');
    return true;
  } catch (e) { return false; }
}

// Wipe the saved game and cold-reboot into a fresh one.
function startFresh() {
  localStorage.removeItem('sg_autosave');
  localStorage.removeItem('sg_autosave_log');
  localStorage.removeItem('sg_autosave_at');
  history = []; renderLog();
  ready = false; reportedOver = ''; queue = []; active = null;
  lastStatus = '';
  document.getElementById('resume').classList.add('hidden');
  document.getElementById('loading').classList.remove('hidden');
  sg.reset();                                 // re-init + re-attach tape + autoload
}

// named local slots
function listSlots() {
  return Object.keys(localStorage).filter(k => k.startsWith('sg_slot_'))
    .map(k => k.slice(8));
}
function saveSlot(name) {
  const bytes = readSzx(); if (!bytes) return;
  localStorage.setItem('sg_slot_' + name, b64(bytes));
  localStorage.setItem('sg_slotlog_' + name, JSON.stringify(history));
  renderSlots();
}
function loadSlot(name) {
  const s = localStorage.getItem('sg_slot_' + name); if (!s) return;
  writeSzx(u8(s));
  history = JSON.parse(localStorage.getItem('sg_slotlog_' + name) || '[]');
  renderLog();
}
function delSlot(name) {
  localStorage.removeItem('sg_slot_' + name);
  localStorage.removeItem('sg_slotlog_' + name);
  renderSlots();
}
function renderSlots() {
  const ul = document.getElementById('slots'); ul.innerHTML = '';
  for (const name of listSlots()) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${name}</span>`;
    const load = btn('load', () => loadSlot(name));
    const del = btn('✕', () => delSlot(name)); del.className = 'del';
    li.append(load, del); ul.appendChild(li);
  }
}

// ---------- UI wiring ----------
function wireUI() {
  renderSlots();
  // tap-to-move on the board canvas + its toggle
  const canvas = document.getElementById('screen');
  canvas.addEventListener('click', (e) => onBoardTap(e.clientX, e.clientY));
  const tm = document.getElementById('tapmove');
  if (tm) {
    tm.checked = tapMove;
    tm.onchange = () => { tapMove = tm.checked; localStorage.setItem('sg_tapmove', tapMove ? '1' : '0'); };
  }
  document.getElementById('newgame').onclick = () => tap('N');
  document.getElementById('undo').onclick = () => tap('Z');
  document.getElementById('flip').onclick = () => tap('F');
  document.getElementById('colour').onclick = () => tap('C');
  for (const b of document.querySelectorAll('[data-key]')) {
    const k = b.getAttribute('data-key');
    b.onclick = () => tap(k);
  }
  for (const b of document.querySelectorAll('[data-level]')) {
    b.onclick = () => tap(b.getAttribute('data-level'));
  }
  document.getElementById('saveslot').onclick = () => {
    const name = (document.getElementById('slotname').value || '').trim()
      .replace(/[^\w-]/g, '').slice(0, 24);
    if (name) { saveSlot(name); document.getElementById('slotname').value = ''; }
  };
  document.getElementById('export').onclick = () => {
    const bytes = readSzx(); if (!bytes) return;
    download('spectral-gambit.szx', bytes);
  };
  document.getElementById('importfile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.arrayBuffer().then(buf => { writeSzx(new Uint8Array(buf)); history = []; renderLog(); });
  };
  document.getElementById('pgn').onclick = () => {
    navigator.clipboard?.writeText(toMovetext(history));
    flash('copied PGN');
  };
}

// ---------- helpers ----------
function set(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
function btn(label, fn) { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; return b; }
function sameBoard(a, b) { for (let i = 0; i < 128; i++) if (a[i] !== b[i]) return false; return true; }
function flash(msg) {
  const el = document.getElementById('flash'); el.textContent = msg;
  el.classList.add('show'); clearTimeout(flash.t);
  flash.t = setTimeout(() => el.classList.remove('show'), 900);
}
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
function u8(s) { const bin = atob(s), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function download(name, bytes) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function buildStartBoard() {
  // standard start in 0x88, type|colour bytes — used only to detect "new game".
  const b = new Uint8Array(128);
  const back = [4, 2, 3, 5, 6, 3, 2, 4];
  for (let f = 0; f < 8; f++) {
    b[0x00 + f] = back[f];        // white back rank
    b[0x10 + f] = 1;             // white pawns
    b[0x60 + f] = 1 | 8;         // black pawns
    b[0x70 + f] = back[f] | 8;   // black back rank
  }
  return b;
}
function isStartPosition(cur) { return sameBoard(cur, START_FEN_BOARD); }

// ---------- bridge for the compete layer (compete.js) ----------
window.SG = {
  isReady:   () => ready,
  getSzx:    () => readSzx(),                         // Uint8Array | null
  loadSzx:   (bytes, movelog) => {                    // returns bool
    const ok = writeSzx(bytes);
    if (ok && movelog) { history = movelog; renderLog(); }
    return ok;
  },
  history:   () => history.slice(),
  setHistory:(h) => { history = h || []; renderLog(); },
  level:     () => curLevel,
  status:    () => lastStatus,
  tap,
  flash,
  onPly:     (cb) => { onPlyCbs.push(cb); },
  onOver:    (cb) => { onOverCbs.push(cb); },
  onReady:   (cb) => { const t = setInterval(() => { if (ready) { clearInterval(t); cb(); } }, 120); },
  // tap-to-move helpers (also used by the test harness)
  cursor:    () => sg.peek(CURSOR_SQ),
  peek:      (addr) => sg.peek(addr),
  markAssisted: () => { aiMoveCount++; },        // companion played one of your moves
  // AI-assisted if the companion played >= 50% of your moves this game
  wasAssisted:  () => { const d = Math.max(playerMoveCount, aiMoveCount); return d > 0 && aiMoveCount / d >= 0.5; },
  flip:      () => sg.peek(FLIP_FLAG) & 1,
  screen:    () => M.UTF8ToString(sg.text()),
  board:     () => { sg.board(boardBuf); return Array.from(M.HEAPU8.subarray(boardBuf, boardBuf + 128)); },
  setTapMove:(on) => { tapMove = !!on; localStorage.setItem('sg_tapmove', on ? '1' : '0');
                       const tm = document.getElementById('tapmove'); if (tm) tm.checked = !!on; },
  tapSquare: (sq) => navTo(sq),
  squareAt:  (x, y) => clickToSquare(x, y, document.getElementById('screen')),
  queueLen:  () => queue.length + (active ? 1 : 0),
};
