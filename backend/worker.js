import { Chess } from 'chess.js';   // server-side result verification

// Spectral Gambit — Cloudflare Worker API (D1-backed).
//
// Routes (all JSON unless noted):
//   POST /api/games            {mode,name}            -> {id,color,token,join}
//   POST /api/games/:id/join   {name}                 -> {id,color,token}
//   GET  /api/games/:id                               -> game meta + movelog
//   GET  /api/games/:id/state                         -> {szx}
//   POST /api/games/:id/move   {token,szx,movelog,result?} -> {ok,turn,status}
//   POST /api/ladder           {name,level,result,moves}  -> {ok,rank}
//   GET  /api/leaderboard                             -> {ladder,recent}
//
// Async human-vs-human is correspondence chess: each side plays one ply
// in the emulator's two-player mode, then POSTs the new .szx; the server
// flips the turn. Turns are enforced by the per-side token.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const bad = (m, s = 400) => json({ error: m }, s);
const now = () => Date.now();
const id6 = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
const tok = () => crypto.randomUUID().replace(/-/g, '');
// pairing code: 6 chars, no ambiguous glyphs (0/O/1/I), easy to read/type
const CODE_ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code6 = () => Array.from({ length: 6 }, () => CODE_ALPH[Math.floor(Math.random() * CODE_ALPH.length)]).join('');

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');
    const db = env.DB;
    try {
      if (req.method === 'POST' && p === '/api/games')      return createGame(req, db);
      let m;
      if ((m = p.match(/^\/api\/games\/([\w-]+)\/join$/)) && req.method === 'POST')  return joinGame(req, db, m[1]);
      if ((m = p.match(/^\/api\/games\/([\w-]+)\/state$/)) && req.method === 'GET')  return getState(db, m[1]);
      if ((m = p.match(/^\/api\/games\/([\w-]+)\/move$/))  && req.method === 'POST') return postMove(req, db, m[1]);
      if ((m = p.match(/^\/api\/games\/([\w-]+)$/))        && req.method === 'GET')  return getGame(db, m[1]);
      if (p === '/api/ladder'      && req.method === 'POST') return postLadder(req, db);
      if (p === '/api/leaderboard' && req.method === 'GET')  return leaderboard(db);
      // ---- AI Companion (page-facing) ----
      if (p === '/api/companion/open'  && req.method === 'POST') return companionOpen(db);
      if (p === '/api/companion/state' && req.method === 'POST') return companionState(req, db);
      if (p === '/api/companion/poll'  && req.method === 'GET')  return companionPoll(db, url);
      if (p === '/api/companion/ack'   && req.method === 'POST') return companionAck(req, db);
      // ---- remote MCP server (the player's Claude connects here) ----
      if (p === '/mcp') return handleMcp(req, db);
      return bad('not found', 404);
    } catch (e) {
      return bad('server error: ' + e.message, 500);
    }
  },
};

async function createGame(req, db) {
  const { mode = 'h2h', name = 'White' } = await req.json().catch(() => ({}));
  const id = id6(), wt = tok(), t = now();
  await db.prepare(
    `INSERT INTO games (id,mode,status,turn,white_name,white_token,movelog,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, mode, 'waiting', 'white', name.slice(0, 24), wt, '[]', t, t).run();
  return json({ id, color: 'white', token: wt });
}

async function joinGame(req, db, id) {
  const { name = 'Black' } = await req.json().catch(() => ({}));
  const g = await db.prepare('SELECT * FROM games WHERE id=?').bind(id).first();
  if (!g) return bad('game not found', 404);
  if (g.black_token) return bad('game already has two players', 409);
  const bt = tok();
  await db.prepare('UPDATE games SET black_name=?,black_token=?,status=?,updated_at=? WHERE id=?')
    .bind(name.slice(0, 24), bt, 'active', now(), id).run();
  return json({ id, color: 'black', token: bt });
}

async function getGame(db, id) {
  const g = await db.prepare('SELECT * FROM games WHERE id=?').bind(id).first();
  if (!g) return bad('game not found', 404);
  return json({
    id: g.id, mode: g.mode, status: g.status, turn: g.turn,
    white: g.white_name, black: g.black_name,
    movelog: JSON.parse(g.movelog || '[]'), hasState: !!g.szx,
    result: g.result, updated_at: g.updated_at,
  });
}

async function getState(db, id) {
  const g = await db.prepare('SELECT szx FROM games WHERE id=?').bind(id).first();
  if (!g) return bad('game not found', 404);
  return json({ szx: g.szx || null });
}

async function postMove(req, db, id) {
  const body = await req.json().catch(() => ({}));
  const { token, szx, movelog, result } = body;
  const g = await db.prepare('SELECT * FROM games WHERE id=?').bind(id).first();
  if (!g) return bad('game not found', 404);
  const side = token === g.white_token ? 'white' : token === g.black_token ? 'black' : null;
  if (!side) return bad('invalid token', 403);
  if (g.status === 'over') return bad('game is over', 409);
  if (g.turn !== side) return bad('not your turn', 409);
  if (typeof szx !== 'string' || szx.length > 400000) return bad('bad state');
  const next = side === 'white' ? 'black' : 'white';
  const status = result ? 'over' : (g.black_token ? 'active' : 'active');
  await db.prepare('UPDATE games SET szx=?,movelog=?,turn=?,status=?,result=?,updated_at=? WHERE id=?')
    .bind(szx, JSON.stringify(movelog || JSON.parse(g.movelog || '[]')), next, status,
          result || g.result || null, now(), id).run();
  return json({ ok: true, turn: next, status });
}

async function postLadder(req, db) {
  const b = await req.json().catch(() => ({}));
  const { name, level, result, moves, fen } = b;
  const assisted = b.assisted ? 1 : 0;
  if (!name || !level || !result) return bad('name, level, result required');
  // server-side verification: the claimed result must match the actual final position
  const v = verifyResult(result, fen);
  if (!v.ok) return bad('result not verified: ' + v.reason, 422);
  await db.prepare('INSERT INTO ladder (name,level,result,moves,assisted,created_at) VALUES (?,?,?,?,?,?)')
    .bind(String(name).slice(0, 24), level | 0, result, moves | 0, assisted, now()).run();
  const rows = await leaderRows(db);
  const rank = rows.findIndex(r => r.name === String(name).slice(0, 24)) + 1;
  return json({ ok: true, rank, verified: true });
}

// The human plays White. A WIN must be a real checkmate with Black (the engine)
// to move (mated); a LOSS the reverse; a DRAW a genuine drawn position.
function verifyResult(result, fen) {
  if (typeof fen !== 'string' || !fen) return { ok: false, reason: 'no final position supplied' };
  let c;
  try { c = new Chess(fen); } catch (e) { return { ok: false, reason: 'invalid final position' }; }
  if (result === 'win')  return (c.isCheckmate() && c.turn() === 'b') ? { ok: true } : { ok: false, reason: 'not a checkmate in your favour' };
  if (result === 'loss') return (c.isCheckmate() && c.turn() === 'w') ? { ok: true } : { ok: false, reason: 'not a checkmate against you' };
  if (result === 'draw') return (c.isStalemate() || c.isInsufficientMaterial() || c.isDraw()) ? { ok: true } : { ok: false, reason: 'not a drawn position' };
  return { ok: false, reason: 'unknown result' };
}

async function leaderRows(db) {
  // Rank by highest SOLO level beaten (assisted wins are tracked but ranked lower),
  // then best overall, then total wins.
  const { results } = await db.prepare(`
    SELECT name,
           MAX(CASE WHEN result='win' THEN level ELSE 0 END)                  AS best,
           MAX(CASE WHEN result='win' AND assisted=0 THEN level ELSE 0 END)   AS best_solo,
           SUM(CASE WHEN result='win' THEN 1 ELSE 0 END)                      AS wins,
           SUM(CASE WHEN result='win' AND assisted=1 THEN 1 ELSE 0 END)       AS assisted_wins,
           COUNT(*)                                                           AS games
    FROM ladder GROUP BY name
    ORDER BY best_solo DESC, best DESC, wins DESC, games ASC LIMIT 100`).all();
  return results || [];
}

async function leaderboard(db) {
  const ladder = await leaderRows(db);
  const recent = (await db.prepare(
    'SELECT name,level,result,moves,assisted,created_at FROM ladder ORDER BY created_at DESC LIMIT 12').all()).results || [];
  return json({ ladder, recent });
}

// ===================== AI Companion (page-facing) =====================

async function companionOpen(db) {
  const id = tok(), code = code6(), t = now();
  await db.prepare('INSERT INTO companion_sessions (id,code,mcp_bound,created_at,last_seen) VALUES (?,?,0,?,?)')
    .bind(id, code, t, t).run();
  return json({ sessionId: id, code });
}

async function companionState(req, db) {
  const b = await req.json().catch(() => ({}));
  const { sessionId, fen, pgn, side, level, legalMoves } = b;
  if (!sessionId) return bad('sessionId required');
  const s = await db.prepare('SELECT mcp_bound FROM companion_sessions WHERE id=?').bind(sessionId).first();
  if (!s) return bad('session not found', 404);
  await db.prepare(
    `INSERT INTO companion_state (session_id,fen,pgn,side,eval,level,legal_moves,updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET fen=excluded.fen,pgn=excluded.pgn,side=excluded.side,
       eval=excluded.eval,level=excluded.level,legal_moves=excluded.legal_moves,updated_at=excluded.updated_at`
  ).bind(sessionId, fen || null, pgn || null, side || null, (b.eval | 0), (level | 0),
         JSON.stringify(legalMoves || []), now()).run();
  await db.prepare('UPDATE companion_sessions SET last_seen=? WHERE id=?').bind(now(), sessionId).run();
  return json({ ok: true, connected: !!s.mcp_bound });
}

async function companionPoll(db, url) {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return bad('sessionId required');
  const s = await db.prepare('SELECT mcp_bound FROM companion_sessions WHERE id=?').bind(sessionId).first();
  if (!s) return bad('session not found', 404);
  const sug = await db.prepare('SELECT candidates,comment,created_at FROM companion_suggestions WHERE session_id=?')
    .bind(sessionId).first();
  const cmds = (await db.prepare(
    "SELECT id,type,san FROM companion_commands WHERE session_id=? AND status='pending' ORDER BY id")
    .bind(sessionId).all()).results || [];
  return json({
    connected: !!s.mcp_bound,
    suggestions: sug ? { candidates: JSON.parse(sug.candidates || '[]'), comment: sug.comment, at: sug.created_at } : null,
    commands: cmds,
  });
}

async function companionAck(req, db) {
  const { sessionId, commandId, result } = await req.json().catch(() => ({}));
  if (!sessionId || !commandId) return bad('sessionId and commandId required');
  const st = result === 'dismissed' ? 'dismissed' : 'done';
  await db.prepare('UPDATE companion_commands SET status=? WHERE id=? AND session_id=?')
    .bind(st, commandId, sessionId).run();
  return json({ ok: true });
}

// ===================== Remote MCP server (Streamable HTTP) =====================
// A minimal JSON-RPC-over-HTTP MCP server. The player's Claude (claude.ai
// connector / Desktop / Code) connects, calls pair(code) once, then reads the
// position and proposes candidate moves shown on the chess page.

const MCP_PROTO = '2025-06-18';
const SUPPORTED_PROTO = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_INSTRUCTIONS =
  "You are a chess companion for a live game on the player's Spectral Gambit page. " +
  "The player plays WHITE; the engine plays Black.\n" +
  "Workflow: (1) Call pair once with the 6-character code from their page. " +
  "(2) Call get_position to see the live FEN, whose turn it is, the engine eval, and the legal moves. " +
  "(3) When it is White's turn, propose exactly THREE legal candidate moves, each with a one-line " +
  "rationale, via propose_candidates — they appear as click-to-play cards on the page. Be decisive and concise.\n" +
  "Playing: if the player asks you to play a move, call play_move directly with legal SAN — do NOT ask " +
  "for confirmation first; the page handles confirm/auto-play.\n" +
  "Turn flow: the page cannot notify you when the board changes, so after the player or the engine moves, " +
  "the player will prompt you again (e.g. 'next') — just call get_position to refresh, then advise. " +
  "ALWAYS choose from get_position's legalMoves; never suggest a move that isn't in that list.";

const TOOLS = [
  { name: 'pair', title: 'Pair with the chess game',
    description: "Pair with the player's chess game using the 6-character code shown on their Spectral Gambit page. Call this first.",
    inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'The 6-character pairing code from the page' } }, required: ['code'] } },
  { name: 'get_position', title: 'Get the current position',
    description: 'Get the live position: FEN, PGN, side to move, engine evaluation (centipawns), engine level, and the list of legal moves in SAN. Call after pair.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_history', title: 'Get the move list',
    description: 'Get the full move list so far (PGN).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'propose_candidates', title: 'Show 3 candidate moves',
    description: "Display candidate moves (ideally three) with one-line rationales as cards on the player's page. Moves must be legal SAN from get_position.",
    inputSchema: { type: 'object', properties: {
      candidates: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object',
        properties: { san: { type: 'string', description: 'Legal move in SAN, e.g. Nf3' }, rationale: { type: 'string', description: 'One-line reason' } }, required: ['san'] } },
      comment: { type: 'string', description: 'Optional overall comment shown above the cards' } }, required: ['candidates'] } },
  { name: 'play_move', title: 'Play a move',
    description: 'Play a move on the board. With auto-play on it plays immediately; otherwise the player confirms with one tap. Call this directly when asked to make a move — no need to ask permission first. Use legal SAN.',
    inputSchema: { type: 'object', properties: { san: { type: 'string', description: 'Legal move in SAN' } }, required: ['san'] } },
];

const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolOk = (id, text) => rpcOk(id, { content: [{ type: 'text', text }] });
const toolErr = (id, text) => rpcOk(id, { content: [{ type: 'text', text }], isError: true });
const stripSan = (s) => String(s).replace(/[+#]+$/, '');

async function handleMcp(req, db) {
  if (req.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: CORS });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: CORS });
  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify(rpcErr(null, -32700, 'Parse error')), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }); }
  const reqSession = req.headers.get('Mcp-Session-Id') || req.headers.get('mcp-session-id') || '';
  const batch = Array.isArray(body) ? body : [body];
  const out = [];
  let assigned = reqSession;
  for (const msg of batch) {
    if (!msg || msg.id === undefined || msg.id === null) continue;   // notification -> no reply
    const res = await mcpDispatch(msg, db, reqSession, (sid) => { assigned = sid; });
    if (res !== undefined) out.push(res);
  }
  const headers = { ...CORS, 'Content-Type': 'application/json' };
  if (assigned) headers['Mcp-Session-Id'] = assigned;
  if (out.length === 0) return new Response(null, { status: 202, headers: CORS });
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { status: 200, headers });
}

async function mcpDispatch(msg, db, mcpSession, setSession) {
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      const proto = SUPPORTED_PROTO.includes(params?.protocolVersion) ? params.protocolVersion : MCP_PROTO;
      const sid = mcpSession || tok();
      setSession(sid);
      return rpcOk(id, {
        protocolVersion: proto,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'spectral-gambit', title: 'Spectral Gambit chess companion', version: '1.0.0' },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    if (method === 'ping') return rpcOk(id, {});
    if (method === 'tools/list') return rpcOk(id, { tools: TOOLS });
    if (method === 'resources/list') return rpcOk(id, { resources: [] });
    if (method === 'prompts/list') return rpcOk(id, { prompts: [] });
    if (method === 'tools/call') return await mcpToolCall(id, params, db, mcpSession);
    return rpcErr(id, -32601, 'Method not found: ' + method);
  } catch (e) {
    return rpcErr(id, -32603, 'Internal error: ' + e.message);
  }
}

async function boundSession(db, mcpSession) {
  if (!mcpSession) return null;
  const b = await db.prepare('SELECT session_id FROM companion_bindings WHERE mcp_session=?').bind(mcpSession).first();
  return b ? b.session_id : null;
}

async function mcpToolCall(id, params, db, mcpSession) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === 'pair') {
    const code = String(args.code || '').trim().toUpperCase();
    if (!code) return toolErr(id, 'Provide the 6-character code shown on the chess page.');
    const sess = await db.prepare('SELECT id FROM companion_sessions WHERE code=?').bind(code).first();
    if (!sess) return toolErr(id, 'No game found for that code. Enable the companion on the chess page and re-read the code.');
    if (!mcpSession) return toolErr(id, 'This connector did not provide a session id; please reconnect.');
    await db.prepare('INSERT INTO companion_bindings (mcp_session,session_id,created_at) VALUES (?,?,?) ON CONFLICT(mcp_session) DO UPDATE SET session_id=excluded.session_id')
      .bind(mcpSession, sess.id, now()).run();
    await db.prepare('UPDATE companion_sessions SET mcp_bound=1, last_seen=? WHERE id=?').bind(now(), sess.id).run();
    const st = await db.prepare('SELECT fen FROM companion_state WHERE session_id=?').bind(sess.id).first();
    return toolOk(id, "Paired ✓ You are now advising this game." + (st?.fen ? ' Current FEN: ' + st.fen : ' (No position yet — ask the player to make a move.)'));
  }

  const sid = await boundSession(db, mcpSession);
  if (!sid) return toolErr(id, 'Not paired yet. Call pair with the 6-character code shown on the chess page.');

  if (name === 'get_position') {
    const st = await db.prepare('SELECT * FROM companion_state WHERE session_id=?').bind(sid).first();
    if (!st || !st.fen) return toolErr(id, 'No position available yet — ask the player to open a game.');
    return toolOk(id, JSON.stringify({
      fen: st.fen, pgn: st.pgn,
      sideToMove: st.side === 'w' ? 'white' : 'black',
      evalCentipawns: st.eval, engineLevel: st.level,
      legalMoves: JSON.parse(st.legal_moves || '[]'),
    }, null, 2));
  }
  if (name === 'get_history') {
    const st = await db.prepare('SELECT pgn FROM companion_state WHERE session_id=?').bind(sid).first();
    return toolOk(id, st?.pgn || '(no moves yet)');
  }
  if (name === 'propose_candidates') {
    const list = Array.isArray(args.candidates) ? args.candidates : [];
    const cands = list.slice(0, 5).map(c => ({ san: String(c.san || '').trim(), rationale: String(c.rationale || '') })).filter(c => c.san);
    if (!cands.length) return toolErr(id, 'Provide at least one candidate {san, rationale}.');
    const st = await db.prepare('SELECT legal_moves FROM companion_state WHERE session_id=?').bind(sid).first();
    const legal = new Set(JSON.parse(st?.legal_moves || '[]').map(stripSan));
    const flagged = cands.map(c => ({ ...c, legal: legal.size ? legal.has(stripSan(c.san)) : true }));
    await db.prepare('INSERT INTO companion_suggestions (session_id,candidates,comment,created_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET candidates=excluded.candidates,comment=excluded.comment,created_at=excluded.created_at')
      .bind(sid, JSON.stringify(flagged), String(args.comment || ''), now()).run();
    const bad2 = flagged.filter(c => !c.legal).map(c => c.san);
    return toolOk(id, "Shown on the player's page." + (bad2.length ? ' Note: not legal in this position: ' + bad2.join(', ') + '. Please re-check against legalMoves.' : ''));
  }
  if (name === 'play_move') {
    const san = String(args.san || '').trim();
    if (!san) return toolErr(id, 'Provide a move in SAN.');
    await db.prepare("INSERT INTO companion_commands (session_id,type,san,status,created_at) VALUES (?,?,?,?,?)")
      .bind(sid, 'play', san, 'pending', now()).run();
    return toolOk(id, `Sent ${san} to the board — it plays immediately if auto-play is on, otherwise the player confirms with one tap.`);
  }
  return toolErr(id, 'Unknown tool: ' + name);
}
