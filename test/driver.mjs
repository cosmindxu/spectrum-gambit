// Browser driver for subagent A ("the user"): opens the LIVE Spectral Gambit
// page in Chromium, starts a new game at strength SG_LEVEL (+ optional SG_CLOCK),
// enables the AI Companion + auto-play, publishes the pairing code, then keeps
// the page un-throttled so the LLM's moves auto-play. Snapshots the board and,
// on game over, saves the verified result + a final screenshot.
//
// CRASH-SURVIVAL: headless Chromium on small/ARM devices can crash at random
// (seen anywhere from 18s to ~10min). We use a PERSISTENT user-data-dir so the
// game state (localStorage autosave) and the companion session survive, and on
// ANY page/browser crash we relaunch the whole browser and re-open the site —
// the game auto-resumes from autosave and companion.js reuses its saved session,
// so Claude reconnects with the SAME pairing code and play continues.
//
// Knobs (env): SG_LEVEL=1..5, SG_CLOCK=off|3+2|5+0|10+5|15+10, SG_NAME=<label>,
//              SG_DIR=<workspace> (default /tmp/sg_game), SG_MAX_MIN=<minutes>.
// Files under SG_DIR: code.txt, status.txt, board.png (~30s), final_board.png +
// result.json (at game over), profile/ (persistent Chromium profile).
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
const SITE = 'https://cosmindxu.github.io/spectral-gambit/';
const DIR = process.env.SG_DIR || '/tmp/sg_game';
const LEVEL = String(process.env.SG_LEVEL || '5');
const CLOCK = process.env.SG_CLOCK || 'off';
const NAME = process.env.SG_NAME || 'Auto player';
const SETUP_ONLY = process.env.SETUP_ONLY === '1';
const MAX_MIN = Number(process.env.SG_MAX_MIN || 90);
const READY = 'window.SG&&window.SG.isReady&&window.SG.isReady()';
const log = (m) => { const s = new Date().toISOString().slice(11, 19) + ' ' + m; console.log(s); try { writeFileSync(DIR + '/status.txt', s + '\n', { flag: 'a' }); } catch {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LAUNCH = { executablePath: '/usr/bin/chromium', headless: 'new', userDataDir: DIR + '/profile',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion'] };

let browser = null, page = null;
// ev/snapBoard read the *current* page, so they keep working after a relaunch
const ev = (f, ...a) => page.evaluate(f, ...a);
const snapBoard = async (file) => { try { const el = await page.$('#screen'); if (el) await el.screenshot({ path: DIR + '/' + file }); } catch {} };

async function makeBrowser() {
  browser = await puppeteer.launch(LAUNCH);
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {           // anti-throttle: always look "visible"
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false });
    document.hasFocus = () => true;
  });
  await page.setViewport({ width: 1100, height: 1400 });
  await page.bringToFront();
}
async function openSite(timeout = 60000) {
  await page.goto(SITE, { waitUntil: 'networkidle2', timeout });
  await page.waitForFunction(READY, { timeout: 40000 });
}
// recover from a browser/renderer crash: relaunch the whole browser and re-open
// the site. The persistent profile makes the game auto-resume + Claude reconnect.
async function relaunch() {
  try { if (browser) await browser.close(); } catch {}
  await makeBrowser();
  await openSite(45000);
  // the resumed game can lose the difficulty setting — re-assert the chosen level
  try { await page.click(`[data-level="${LEVEL}"]`); await sleep(300); } catch {}
}

// full game setup (one attempt). Wrapped in a retry below so a random Chromium
// crash during startup relaunches instead of killing the run.
async function setupGame() {
  await makeBrowser();
  log('opening ' + SITE + ' (level ' + LEVEL + ', clock ' + CLOCK + ')');
  await openSite();
  await ev(() => localStorage.clear());              // fresh game this run
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(READY, { timeout: 40000 });

  await page.click('#playername'); await page.type('#playername', NAME);
  await ev(() => document.getElementById('playername').blur());

  await page.click('#newgame'); await sleep(800);
  await page.click(`[data-level="${LEVEL}"]`); await sleep(500);
  const lvl = await ev(() => document.getElementById('lvl').textContent);
  log('strength set, level reads ' + lvl);
  if (CLOCK && CLOCK !== 'off') { await page.select('#timecontrol', CLOCK); await sleep(300); log('clock set to ' + CLOCK); }

  await page.click('#companion-enable');
  await page.waitForFunction('!/^…?$/.test(document.getElementById("companion-code").textContent)', { timeout: 15000 });
  const code = await ev(() => document.getElementById('companion-code').textContent);
  const apChecked = await ev(() => document.getElementById('companion-autoplay').checked);
  if (!apChecked) await page.click('#companion-autoplay');
  const ap = await ev(() => document.getElementById('companion-autoplay').checked);
  log(`companion enabled, autoplay=${ap}, level=${lvl}, name="${NAME}"`);

  writeFileSync(DIR + '/code.txt', code + '\n');
  log('PAIRING CODE = ' + code + '  (written to code.txt)');
  log('READY — waiting for the LLM to pair and play.');
}

try {
  let setupOk = false;
  for (let attempt = 1; attempt <= 5 && !setupOk; attempt++) {
    try { await setupGame(); setupOk = true; }
    catch (e) {
      log('setup attempt ' + attempt + ' crashed (' + e.message.slice(0, 40) + ') — relaunching');
      try { if (browser) await browser.close(); } catch {}
      await sleep(3000);
    }
  }
  if (!setupOk) throw new Error('setup failed after 5 attempts');

  if (SETUP_ONLY) { log('SETUP_ONLY done'); await browser.close(); process.exit(0); }

  // monitor loop with crash-survival
  const deadline = Date.now() + MAX_MIN * 60000;
  let lastMoves = -1, connectedSeen = false, jig = 0, recoveries = 0, gameOver = false;
  while (Date.now() < deadline && !gameOver) {
    try {
      await page.bringToFront().catch(() => {});
      await page.mouse.move(40 + (jig++ % 12), 40).catch(() => {});
      const st = await ev(() => ({
        gs: window.SG.peek(0xE088),                  // 0 play; 1 white-mated; 2 black-mated; 3 stalemate; 4 fifty-move
        moves: window.SG.history().length,
        stm: (window.SG.peek(0xE080) & 8) ? 'black' : 'white',
        conn: /connected/i.test(document.getElementById('companion-status').textContent),
      }));
      if (st.conn && !connectedSeen) { connectedSeen = true; log('LLM connected ✓'); }
      if (st.moves !== lastMoves) { lastMoves = st.moves; log(`plies=${st.moves} toMove=${st.stm} connected=${st.conn} gameState=${st.gs}`); }
      if (jig % 12 === 1) await snapBoard('board.png');
      if (st.gs !== 0) { log('GAME OVER detected (gameState=' + st.gs + ')'); gameOver = true; break; }
    } catch (e) {
      if (++recoveries > 40) { log('too many recoveries — giving up: ' + e.message.slice(0, 50)); break; }
      log('browser crash #' + recoveries + ' (' + e.message.slice(0, 40) + ') — relaunching to recover');
      try {
        await relaunch();
        connectedSeen = false; lastMoves = -1;
        log('recovered: browser relaunched, game resumed from autosave (companion reconnecting)');
        await sleep(5000);                            // give companion time to re-pair + B to notice
      } catch (e2) { log('relaunch failed (' + e2.message.slice(0, 40) + ') — will retry'); await sleep(3000); }
    }
    await sleep(2500);
  }

  // capture + save the verified result, surviving a crash at the finish line
  let fin = null, saved = '';
  for (let attempt = 0; attempt < 3 && !fin; attempt++) {
    try {
      fin = await ev(async () => {
        const { buildPosition, readState } = await import('./position.js');
        const p = buildPosition(readState(window.SG));
        return { gs: window.SG.peek(0xE088), fen: p.fen, assisted: window.SG.wasAssisted(),
                 plies: window.SG.history().length, label: (document.getElementById('reportstatus') || {}).textContent || '' };
      });
      log('final: ' + JSON.stringify(fin));
      await snapBoard('final_board.png'); log('captured final board screenshot');
      await page.waitForFunction('!document.getElementById("reportbox").classList.contains("hidden")', { timeout: 8000 }).catch(() => {});
      await page.click('#report-save').catch(() => {}); await sleep(1500);
      saved = await ev(() => document.getElementById('flash').textContent).catch(() => '');
    } catch (e) {
      log('capture attempt ' + (attempt + 1) + ' failed (' + e.message.slice(0, 40) + ') — relaunching');
      try { await relaunch(); await sleep(4000); } catch {}
    }
  }
  const result = { ...(fin || { error: 'could not capture final position' }), savedFlash: saved, name: NAME, finishedAt: new Date().toISOString() };
  writeFileSync(DIR + '/result.json', JSON.stringify(result, null, 2));
  log('RESULT SAVED — ' + JSON.stringify(result));
} catch (e) {
  log('DRIVER ERROR: ' + e.message);
  writeFileSync(DIR + '/result.json', JSON.stringify({ error: e.message }, null, 2));
} finally {
  try { if (browser) await browser.close(); } catch {}
}
