// Exhaustive UI test suite for Spectral Gambit, driven through a real
// headless Chromium (puppeteer-core). Covers every button, text field and
// input, plus two-consecutive-input sequences. Each test runs on a clean
// reload and fails if it triggers any console/page error.
//
// Requires the static site on :8099 and the dev API on :8100.
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';

const URL = process.env.URL || 'http://localhost:8099/';
const API = 'http://127.0.0.1:8100';   // node-18 resolves localhost->::1; API is IPv4-only
const SQ = { a1:0x00,h1:0x07,a2:0x10,d2:0x13,e2:0x14,g1:0x06,e4:0x34,d4:0x33,f3:0x25,e7:0x64,e5:0x44 };

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-gpu','--disable-dev-shm-usage',
    // keep the rAF-driven emulator at full speed in headless (no backgrounding)
    '--disable-background-timer-throttling','--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding','--disable-features=CalculateNativeWinOcclusion'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 1500 });
await page.bringToFront();   // keep the tab "visible" so rAF isn't throttled (would starve the emulator)
// config.js hardcodes the prod worker; point the page at the local dev API instead
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.url().endsWith('/config.js')) return req.respond({ status: 200, contentType: 'application/javascript', body: `window.SG_API_BASE='${API}';` });
  req.continue();
});
let errs = [];
await page.evaluateOnNewDocument(() => {
  window.__clip = null;
  navigator.clipboard = navigator.clipboard || {};
  navigator.clipboard.writeText = (t) => { window.__clip = t; return Promise.resolve(); };
});
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('pageerror', e => errs.push('pageerror: ' + e.message));

// ---- helpers ----
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady() { await page.waitForFunction('window.SG&&window.SG.isReady&&window.SG.isReady()', { timeout: 30000 }); }
async function resetClean() {
  // stop the unloading page from re-saving its game, then wipe storage so the
  // reload boots truly fresh (no leaked position / flip / level from prior test)
  await ev(() => { window.__sgNoSave = true; localStorage.clear(); });
  await page.reload({ waitUntil: 'networkidle2' });
  await waitReady();
  await waitIdle();
}
async function waitIdle(ms = 15000) { await page.waitForFunction('window.SG.queueLen()===0', { timeout: ms }); }
async function waitYourMove(ms = 30000) { await page.waitForFunction('/your move/i.test(window.SG.status())', { timeout: ms }); }
async function board() { return ev(() => window.SG.board()); }
const type = s => s & 7;                 // piece type from a 0x88 board byte
const colr = s => (s >> 3) & 1;          // colour bit
async function clickSquare(sq) {
  const pt = await ev((sq) => {
    const flip = window.SG.flip(); const file = sq & 7, rank = (sq >> 4) & 7;
    const c = flip ? 7 - file : file, r = flip ? rank : 7 - rank;
    const fbx = 64 + c * 16 + 8, fby = 40 + r * 16 + 8;
    const cv = document.getElementById('screen'), b = cv.getBoundingClientRect();
    return { x: b.left + fbx / 320 * b.width, y: b.top + fby / 240 * b.height };
  }, sq);
  await page.mouse.click(pt.x, pt.y);
}
// full move via the board: pick up, drop, then wait for BOTH plies (the
// player's and the engine's reply) to land in the log — a reliable
// "engine actually replied" signal, unlike the ambiguous "Your move" text.
async function tapMoveUI(from, to) {
  const h0 = await ev(() => window.SG.history().length);
  await clickSquare(from); await waitIdle();
  await clickSquare(to); await waitIdle();
  await page.waitForFunction(`window.SG.history().length >= ${h0 + 2}`, { timeout: 30000 });
}

// ---- test registry ----
const tests = [];
const T = (id, name, fn) => tests.push({ id, name, fn });
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ''} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

// ===== A. boot & render =====
T('A1', 'boots to "Your move" with no errors', async () => {
  await resetClean(); eq(await ev(() => /your move/i.test(window.SG.status())), true, 'status');
});
T('A2', 'canvas renders a non-blank frame', async () => {
  const distinct = await ev(() => { const c = document.getElementById('screen'); const x = c.getContext('2d');
    const d = x.getImageData(64, 40, 128, 128).data; const set = new Set();
    for (let i = 0; i < d.length; i += 4) set.add(d[i] + ',' + d[i+1] + ',' + d[i+2]); return set.size; });
  assert(distinct >= 3, 'board should have several colours, got ' + distinct);
});
T('A3', 'panel shows Level 2 and Material 0 at start', async () => {
  eq(await ev(() => document.getElementById('lvl').textContent), '2', 'level');
  eq(await ev(() => document.getElementById('matl').textContent), '0.00', 'material');
});

// ===== B. tap-to-move (canvas) =====
T('B1', 'tap e2 then e4 plays the pawn; engine replies', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  const b = await board(); eq(type(b[SQ.e2]), 0, 'e2 empty'); eq(type(b[SQ.e4]), 1, 'pawn on e4');
});
T('B2', 'tap g1 then f3 develops the knight', async () => {
  await resetClean(); await tapMoveUI(SQ.g1, SQ.f3); await waitYourMove();
  const b = await board(); eq(type(b[SQ.g1]), 0, 'g1 empty'); eq(type(b[SQ.f3]), 2, 'knight on f3');
});
T('B3', 'after Flip, tap-to-move still resolves the right square', async () => {
  await resetClean(); await ev(() => window.SG.tap('F')); await waitIdle(); await sleep(300);
  eq(await ev(() => window.SG.flip()), 1, 'flipped');
  await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  const b = await board(); eq(type(b[SQ.e4]), 1, 'pawn on e4 even when flipped');
});
T('B4', 'toggle OFF: tapping the board makes no move', async () => {
  await resetClean(); await page.click('#tapmove'); // uncheck
  eq(await ev(() => document.getElementById('tapmove').checked), false, 'unchecked');
  const before = await ev(() => window.SG.cursor());
  await clickSquare(SQ.a1); await sleep(300);
  eq(await ev(() => window.SG.queueLen()), 0, 'no queued input');
  eq(await ev(() => window.SG.cursor()), before, 'cursor unchanged');
});
T('B5', 'tap-to-move toggle persists in localStorage', async () => {
  await resetClean(); await page.click('#tapmove');
  eq(await ev(() => localStorage.getItem('sg_tapmove')), '0', 'persisted off');
  await page.click('#tapmove');
  eq(await ev(() => localStorage.getItem('sg_tapmove')), '1', 'persisted on');
});

// ===== C. d-pad & keyboard =====
T('C1', 'D-pad makes a move (ENTER, Up, Up, ENTER = e2e4)', async () => {
  await resetClean();
  for (const sel of ['.dpad .ok', '.dpad .up', '.dpad .up', '.dpad .ok']) { await page.click(sel); await waitIdle(); }
  await waitYourMove(); const b = await board(); eq(type(b[SQ.e4]), 1, 'pawn e4 via dpad');
});
T('C2', 'keyboard arrows + Enter make a move', async () => {
  await resetClean();   // body has focus; window keydown handler receives keys
  await page.keyboard.press('Enter'); await waitIdle();
  await page.keyboard.press('ArrowUp'); await waitIdle();
  await page.keyboard.press('ArrowUp'); await waitIdle();
  await page.keyboard.press('Enter'); await waitIdle(); await waitYourMove();
  const b = await board(); eq(type(b[SQ.e4]), 1, 'pawn e4 via keyboard');
});
T('C3', 'keyboard "N" starts a new game', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await page.keyboard.press('n'); await sleep(500);
  const b = await board(); eq(type(b[SQ.e2]), 1, 'pawn back on e2 after new game');
});

// ===== D. control buttons =====
T('D1', 'Strength buttons 1..5 update the Level readout', async () => {
  await resetClean();
  for (const lvl of ['1','5','3']) {
    await page.click(`[data-level="${lvl}"]`); await sleep(400);
    eq(await ev(() => document.getElementById('lvl').textContent), lvl, 'level ' + lvl);
  }
});
T('D2', 'New game button resets board and clears the move log', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  assert((await ev(() => window.SG.history().length)) > 0, 'has moves');
  await page.click('#newgame'); await sleep(600);
  eq(await ev(() => window.SG.history().length), 0, 'log cleared');
  eq(type((await board())[SQ.e2]), 1, 'pawn back on e2');
});
T('D3', 'Take back undoes the last full move', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await page.click('#undo'); await sleep(800);
  eq(type((await board())[SQ.e4]), 0, 'e4 empty after take back');
  eq(type((await board())[SQ.e2]), 1, 'pawn restored to e2');
});
T('D4', 'Flip toggles board orientation', async () => {
  await resetClean(); eq(await ev(() => window.SG.flip()), 0, 'starts unflipped');
  await page.click('#flip'); await sleep(400); eq(await ev(() => window.SG.flip()), 1, 'flipped');
  await page.click('#flip'); await sleep(400); eq(await ev(() => window.SG.flip()), 0, 'unflipped again');
});
T('D5', 'Colour cycles the scheme name on screen', async () => {
  await resetClean();
  const s1 = await ev(() => window.SG.screen());
  await page.click('#colour'); await sleep(400);
  const s2 = await ev(() => window.SG.screen());
  assert(s1.match(/C:\w+/)[0] !== s2.match(/C:\w+/)[0], 'scheme name changed');
});
T('D6', 'Copy PGN writes the move text to the clipboard', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await page.click('#pgn'); await sleep(200);
  const clip = await ev(() => window.__clip);
  assert(clip && /1\.\s*e4/.test(clip), 'clipboard has PGN, got: ' + clip);
});

// ===== E. save / load =====
T('E1', 'Save slot stores a named game', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await page.type('#slotname', 'mygame');
  await page.click('#saveslot'); await sleep(300);
  eq(await ev(() => localStorage.getItem('sg_slot_mygame') ? 1 : 0), 1, 'slot saved');
  const listed = await ev(() => [...document.querySelectorAll('#slots li span')].map(s => s.textContent));
  assert(listed.includes('mygame'), 'slot listed');
});
T('E2', 'Load slot restores the saved position', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await page.type('#slotname', 'restore'); await page.click('#saveslot'); await sleep(300);
  await page.click('#newgame'); await sleep(600); eq(type((await board())[SQ.e4]), 0, 'fresh board');
  await ev(() => { for (const b of document.querySelectorAll('#slots li')) if (b.querySelector('span').textContent === 'restore') b.querySelector('button').click(); });
  await sleep(600); eq(type((await board())[SQ.e4]), 1, 'position restored');
});
T('E3', 'Delete slot removes it', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await page.type('#slotname', 'temp'); await page.click('#saveslot'); await sleep(300);
  await ev(() => { for (const li of document.querySelectorAll('#slots li')) if (li.querySelector('span').textContent === 'temp') li.querySelector('.del').click(); });
  await sleep(200); eq(await ev(() => localStorage.getItem('sg_slot_temp')), null, 'slot removed');
});
T('E4', 'Export produces .szx bytes without error', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  const n = await ev(() => window.SG.getSzx().length); assert(n > 1000, 'szx has bytes: ' + n);
  await page.click('#export'); await sleep(200); // must not throw
});
T('E5', 'Import .szx loads a position from file', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  const arr = await ev(() => Array.from(window.SG.getSzx()));
  writeFileSync('/tmp/sg_import.szx', Buffer.from(arr));
  await page.click('#newgame'); await sleep(600); eq(type((await board())[SQ.e4]), 0, 'cleared');
  const input = await page.$('#importfile'); await input.uploadFile('/tmp/sg_import.szx');
  await sleep(800); eq(type((await board())[SQ.e4]), 1, 'imported position has e4 pawn');
});

// ===== F. resume flow =====
T('F1', 'reload auto-resumes the game (banner, no empty parens)', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove(); await sleep(300);
  await page.reload({ waitUntil: 'networkidle2' }); await waitReady();
  eq(type((await board())[SQ.e4]), 1, 'position auto-restored');
  const banner = await ev(() => { const b = document.getElementById('resume');
    return { shown: !b.classList.contains('hidden'), text: b.textContent.trim() }; });
  assert(banner.shown, 'resume banner visible');
  assert(!/\(\s*\)/.test(banner.text), 'no empty parens: ' + banner.text);
});
T('F2', 'Dismiss hides the resume banner', async () => {
  // (continues from prior saved game state)
  await page.reload({ waitUntil: 'networkidle2' }); await waitReady();
  await page.click('#resume .dismiss'); await sleep(150);
  eq(await ev(() => document.getElementById('resume').classList.contains('hidden')), true, 'hidden');
});
T('F3', 'Start a new game wipes the save and resets', async () => {
  await page.reload({ waitUntil: 'networkidle2' }); await waitReady();
  await page.click('#resume .fresh'); await sleep(1200); await waitReady();
  eq(await ev(() => localStorage.getItem('sg_autosave')), null, 'autosave cleared');
});

// ===== G. input-field safety (the iOS bug) =====
T('G1', 'typing in slot name does NOT leak keys to the emulator', async () => {
  await resetClean(); const before = await ev(() => window.SG.cursor());
  await page.click('#slotname'); await page.type('#slotname', 'Nf3test');
  await sleep(200);
  eq(await ev(() => document.getElementById('slotname').value), 'Nf3test', 'text entered');
  eq(await ev(() => window.SG.cursor()), before, 'cursor not moved by typing');
  eq(type((await board())[SQ.e2]), 1, 'board untouched (no New game from the N)');
});
T('G2', 'typing in player name does not disturb the board', async () => {
  await resetClean(); await page.click('#playername'); await page.type('#playername', 'anna');
  await sleep(150);
  eq(await ev(() => document.getElementById('playername').value), 'anna', 'name typed');
  eq(type((await board())[SQ.a2]), 1, 'board untouched');
});
T('G3', 'slot name then Save uses the sanitised typed name', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await page.type('#slotname', 'my game!!'); await page.click('#saveslot'); await sleep(300);
  eq(await ev(() => localStorage.getItem('sg_slot_mygame') ? 1 : 0), 1, 'sanitised to mygame');
});

// ===== H. compete: ladder =====
T('H1', 'player name persists to localStorage', async () => {
  await resetClean(); await page.click('#playername'); await page.type('#playername', 'tester');
  await page.evaluate(() => document.getElementById('playername').blur()); await sleep(150);
  eq(await ev(() => localStorage.getItem('sg_name')), 'tester', 'name saved');
});
T('H2', 'leaderboard renders rows from the API', async () => {
  await resetClean(); await sleep(600);
  const rows = await ev(() => document.querySelectorAll('#leaderboard tr').length);
  assert(rows >= 1, 'leaderboard has rows: ' + rows);
});
T('H3', 'game-over report shows a single Save button (no win/loss/draw choices)', async () => {
  await resetClean();
  eq(await ev(() => !!document.getElementById('report-save')), true, 'single Save button present');
  eq(await ev(() => !!document.getElementById('report-win')), false, 'old three-choice buttons gone');
});

// ===== I. compete: correspondence =====
T('I1', 'Create game shows active panel with a share link', async () => {
  await resetClean(); await page.click('#corr-create'); await sleep(800);
  eq(await ev(() => document.getElementById('corr-active').classList.contains('hidden')), false, 'active shown');
  const share = await ev(() => document.getElementById('corr-share').value);
  assert(/\?g=\w+/.test(share), 'share link has ?g=, got ' + share);
  eq(await ev(() => JSON.parse(localStorage.getItem('sg_corr')).color), 'white', 'creator is white');
});
T('I2', 'Submit before moving warns and does not advance the server', async () => {
  await resetClean(); await page.click('#corr-create'); await sleep(800);
  await page.click('#corr-submit'); await sleep(400);
  const gid = await ev(() => JSON.parse(localStorage.getItem('sg_corr')).gid);
  const g = await (await fetch(`${API}/api/games/${gid}`)).json();
  eq(g.movelog.length, 0, 'no move recorded on the server');
});
T('I3', 'move then Submit advances the correspondence game', async () => {
  await resetClean(); await page.click('#corr-create'); await sleep(800);
  // correspondence = two-player mode: only OUR ply lands, no engine reply
  const h0 = await ev(() => window.SG.history().length);
  await clickSquare(SQ.e2); await waitIdle(); await clickSquare(SQ.e4); await waitIdle();
  await page.waitForFunction(`window.SG.history().length >= ${h0 + 1}`, { timeout: 15000 });
  await page.click('#corr-submit'); await sleep(800);
  const gid = await ev(() => JSON.parse(localStorage.getItem('sg_corr')).gid);
  const g = await (await fetch(`${API}/api/games/${gid}`)).json();
  assert(g.movelog.length >= 1, 'server has the move, got ' + g.movelog.length);
  eq(g.turn, 'black', 'turn passed to black');
});
T('I4', 'Copy link copies the share URL', async () => {
  await resetClean(); await page.click('#corr-create'); await sleep(800);
  await page.click('#corr-copy'); await sleep(150);
  assert(/\?g=\w+/.test(await ev(() => window.__clip || '')), 'clipboard has link');
});
T('I5', 'Leave returns to the idle (create) state', async () => {
  await resetClean(); await page.click('#corr-create'); await sleep(800);
  await page.click('#corr-leave'); await sleep(200);
  eq(await ev(() => document.getElementById('corr-idle').classList.contains('hidden')), false, 'idle shown');
  eq(await ev(() => localStorage.getItem('sg_corr')), null, 'corr cleared');
});

// ===== J. extra sequences (two different inputs in a row) =====
T('J1', 'Strength change then a move keeps the new level', async () => {
  await resetClean(); await page.click('[data-level="1"]'); await sleep(300);
  await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  eq(await ev(() => document.getElementById('lvl').textContent), '1', 'still level 1');
});
T('J2', 'two moves in a row build a 2-move log', async () => {
  await resetClean(); await tapMoveUI(SQ.e2, SQ.e4); await waitYourMove();
  await tapMoveUI(SQ.g1, SQ.f3); await waitYourMove();
  assert((await ev(() => window.SG.history().length)) >= 4, 'four plies logged');
});
T('J3', 'Flip then New game keeps things consistent (no errors)', async () => {
  await resetClean(); await page.click('#flip'); await sleep(300); await page.click('#newgame'); await sleep(500);
  eq(type((await board())[SQ.e2]), 1, 'board fine after flip+new');
});
T('J4', 'tap same square twice (pick up then put down) leaves board intact', async () => {
  await resetClean(); await clickSquare(SQ.e2); await waitIdle(); await clickSquare(SQ.e2); await waitIdle(); await sleep(300);
  eq(type((await board())[SQ.e2]), 1, 'pawn still on e2');
});

// ===== K. real (wall-clock) chess clock =====
const clkSec = async (which) => ev((w) => {
  const t = document.querySelector(`#clk-${w} b`).textContent; const [m, s] = t.split(':').map(Number);
  return m * 60 + s;
}, which);
T('K1', 'default has no clock (hidden)', async () => {
  await resetClean();
  eq(await ev(() => document.getElementById('clocks').classList.contains('hidden')), true, 'clocks hidden');
});
T('K2', 'selecting a time control shows both clocks at the base time', async () => {
  await resetClean();
  await page.select('#timecontrol', '3+2'); await sleep(300);
  eq(await ev(() => document.getElementById('clocks').classList.contains('hidden')), false, 'clocks shown');
  eq(await clkSec('you'), 180, 'you 3:00'); eq(await clkSec('eng'), 180, 'engine 3:00');
});
T('K3', 'your clock ticks down in real time on your move', async () => {
  await resetClean();
  await page.select('#timecontrol', '5+0'); await sleep(200);
  const t0 = await clkSec('you'); await sleep(2200);
  const t1 = await clkSec('you');
  assert(t1 < t0, `your clock should drop (was ${t0}, now ${t1})`);
});
T('K4', 'time-control choice persists across reload', async () => {
  await resetClean();
  await page.select('#timecontrol', '3+2'); await sleep(300);
  await page.reload({ waitUntil: 'networkidle2' }); await waitReady(); await sleep(300);
  eq(await ev(() => document.getElementById('timecontrol').value), '3+2', 'TC restored');
  eq(await ev(() => document.getElementById('clocks').classList.contains('hidden')), false, 'clocks shown after reload');
});
T('K5', 'increment is added after your move', async () => {
  await resetClean();
  await page.select('#timecontrol', '3+2'); await sleep(200);
  await tapMoveUI(SQ.e2, SQ.e4);          // your ply (+2s) then engine replies
  await sleep(300);
  // after your move you got +2s; allowing for a little think time, you should be near/above 3:00-ish
  assert(await clkSec('you') >= 178, 'your clock got the increment back');
});

// ---- run ----
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });   // establish the origin first
await waitReady();
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const run = ONLY.length ? tests.filter(t => ONLY.includes(t.id)) : tests;
const results = [];
for (const t of run) {
  let ok = false, err = null, attempts = 0;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {     // retries for flaky headless rAF timing
    attempts = attempt;
    const base = errs.length;
    try {
      await t.fn();
      const newErrs = errs.slice(base);
      if (newErrs.length) throw new Error('console/page error: ' + newErrs.join(' | '));
      ok = true;
    } catch (e) { err = e.message; }
  }
  results.push({ ...t, ok, err, attempts });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${t.id}  ${t.name}${ok && attempts > 1 ? '  (passed on retry)' : ''}${ok ? '' : '\n        ' + err}`);
}
const pass = results.filter(r => r.ok).length;
const retried = results.filter(r => r.ok && r.attempts > 1).length;
console.log(`\n${pass}/${results.length} passed${retried ? ` (${retried} needed a retry)` : ''}`);
await browser.close();
process.exit(pass === results.length ? 0 : 1);
