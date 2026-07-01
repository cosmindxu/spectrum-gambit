// Spectrum Gambit autonomous-game workflow TEMPLATE.
// Substitute the {{TOKENS}} (LEVEL, CLOCK, MODEL, EFFORT, NAME) before launching
// via the Workflow tool (pass the result as the inline `script`).
//   {{LEVEL}}  engine strength 1..5            (agent A)
//   {{CLOCK}}  off|3+2|5+0|10+5|15+10          (agent A)
//   {{MODEL}}  opus|sonnet|haiku|fable         (agent B)
//   {{EFFORT}} low|medium|high|max             (agent B)
//   {{NAME}}   leaderboard label, e.g. "Opus max"
//
// By DEFAULT agent B may use ONLY its own reasoning — the B_PROMPT forbids external
// chess engines / solvers / tablebases / analysis tools. Remove the "NO EXTERNAL
// ENGINES" block below ONLY if the user EXPLICITLY asks to allow them (see SKILL.md
// -> "External engines / tools"). Without this the ladder is not a like-for-like
// comparison: a resourceful model (e.g. Opus) will install Stockfish and the result
// reflects the engine, not the model.
export const meta = {
  name: 'spectrum-gambit-autoplay',
  description: 'Two subagents play a Spectrum Gambit game: the user (Chromium driver) + an LLM (via MCP)',
  phases: [{ title: 'Play', detail: 'A hosts the level-{{LEVEL}} game; B ({{MODEL}}/{{EFFORT}}) plays via MCP' }],
};

const A_PROMPT = [
  'You are subagent A: "the user", operating the live Spectrum Gambit chess site through Chromium.',
  'Run this single command in the foreground and let it run to completion (it can take up to ~90 minutes):',
  '',
  '    cd /home/dcosmin/spectrum-gambit/test && SG_LEVEL={{LEVEL}} SG_CLOCK={{CLOCK}} SG_NAME="{{NAME}}" SG_DIR=/tmp/sg_game node driver.mjs',
  '',
  'That driver opens the live site, starts a NEW game at strength {{LEVEL}} (clock {{CLOCK}}), enables the AI',
  'Companion + auto-play, writes the 6-char pairing code to /tmp/sg_game/code.txt, keeps the page un-throttled so',
  'the LLM player\'s moves auto-play, snapshots the board to /tmp/sg_game/board.png every ~30s, and on game over saves',
  'the verified result (player name "{{NAME}}") + /tmp/sg_game/final_board.png + /tmp/sg_game/result.json. It auto-',
  'recovers from a renderer crash by reloading. When the command exits, read /tmp/sg_game/result.json and report it',
  'verbatim plus a one-line summary (result, final FEN, plies, assisted flag, savedFlash). Do NOT make chess moves',
  'yourself — subagent B does that.',
].join('\n');

const B_PROMPT = [
  'You are subagent B: the chess brain. You play WHITE against a level-{{LEVEL}} engine (Black) in a live game on',
  'Spectrum Gambit, driving it through its remote MCP server with curl. Play strong, principled chess and TRY TO WIN.',
  'Reason carefully about each position using ONLY YOUR OWN CHESS KNOWLEDGE.',
  '',
  // ---- default-on restriction. Keep these lines UNLESS the user EXPLICITLY asked to
  //      allow an external engine/tool (see SKILL.md), in which case delete this block.
  '*** HARD RULE — NO EXTERNAL ENGINES OR SOLVERS ***',
  'Do NOT install, download, compile, or call ANY external chess engine, solver, tablebase, opening book, or',
  'move-evaluating tool (no Stockfish, Leela, python-chess evaluation/mate-search, online analysis, etc.). Use curl',
  'ONLY to talk to the MCP endpoint below. Every move must come from YOUR OWN reasoning — this measures the model\'s',
  'play, not an engine\'s.',
  '',
  'The MCP endpoint is:',
  '    MCP=https://spectrum-gambit-api.cosmindxu.workers.dev/mcp',
  '',
  'IMPORTANT — keep every Bash call SHORT (one or a few curls, no long sleep/poll loops): the shell has a 2-minute',
  'cap, so do NOT write a single command that polls for minutes. Reason between calls instead. Set a curl User-Agent',
  '(-H "User-Agent: curl/8") on every request — Cloudflare 403s the default.',
  '',
  'STEP 1 - get the pairing code the browser publishes (wait for it, up to ~90s):',
  '    for i in $(seq 1 30); do [ -f /tmp/sg_game/code.txt ] && break; sleep 3; done; CODE=$(cat /tmp/sg_game/code.txt | tr -d "[:space:]"); echo "code=$CODE"',
  '',
  'STEP 2 - initialize and capture the session id from the Mcp-Session-Id RESPONSE HEADER:',
  '    curl -s -D /tmp/sg_game/h -o /tmp/sg_game/b -H "Content-Type: application/json" -H "User-Agent: curl/8" -d \'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"b","version":"1"}}}\' "$MCP"',
  '    SID=$(grep -i "^mcp-session-id:" /tmp/sg_game/h | tr -d "\\r" | awk "{print \\$2}"); echo "sid=$SID"',
  '  Pass -H "Mcp-Session-Id: $SID" on EVERY subsequent call.',
  '',
  'STEP 3 - pair with the game:',
  '    curl -s -H "Content-Type: application/json" -H "User-Agent: curl/8" -H "Mcp-Session-Id: $SID" -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":2,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"pair\\",\\"arguments\\":{\\"code\\":\\"$CODE\\"}}}" "$MCP"',
  '',
  'STEP 4 - get_position (result text is JSON: fen, pgn, sideToMove, evalCentipawns, engineLevel, legalMoves):',
  '    curl -s -H "Content-Type: application/json" -H "User-Agent: curl/8" -H "Mcp-Session-Id: $SID" -d \'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_position","arguments":{}}}\' "$MCP"',
  '',
  'STEP 5 - play_move (SAN must be EXACTLY one of legalMoves):',
  '    curl -s -H "Content-Type: application/json" -H "User-Agent: curl/8" -H "Mcp-Session-Id: $SID" -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":4,\\"method\\":\\"tools/call\\",\\"params\\":{\\"name\\":\\"play_move\\",\\"arguments\\":{\\"san\\":\\"e4\\"}}}" "$MCP"',
  '',
  'THE LOOP - repeat until the game ends:',
  '  1. get_position. Parse it.',
  '  2. If legalMoves is empty / game over -> STOP.',
  '  3. If sideToMove is "black": the engine is thinking. Sleep ~5s and get_position again.',
  '  4. If sideToMove is "white" AND the fen differs from the fen you last moved from: it is your turn on a NEW',
  '     position. Choose the BEST legal move for White FROM YOUR OWN REASONING (no external engines/tools), then',
  '     play_move with a SAN copied exactly from legalMoves.',
  '     Record this fen as "last moved from".',
  '  5. After play_move, the browser auto-plays it and the engine replies. Poll get_position every ~5s until the fen',
  '     advances or the game is over. Then loop.',
  '',
  'RULES: only ever play a SAN present verbatim in legalMoves. Never move twice from the same fen. NO external',
  'engines/solvers/tablebases/analysis tools — own reasoning only (hard rule above). The position the',
  'page reports is always a SETTLED one (the page no longer leaks mid-search positions). If 60 min pass or ~120 plies',
  'with no end, stop. When the game ends, report the outcome (won/lost/drew + how), the final FEN, and total moves.',
  'The browser side saves the leaderboard entry; you do not.',
].join('\n');

phase('Play');
log('Fanning out: A = user/Chromium (level {{LEVEL}}, clock {{CLOCK}}), B = {{MODEL}}/{{EFFORT}} chess brain. They meet at /tmp/sg_game/code.txt + the live MCP server.');
const [user, opus] = await parallel([
  () => agent(A_PROMPT, { label: 'A:user-chromium', phase: 'Play' }),
  () => agent(B_PROMPT, { label: 'B:{{MODEL}}-{{EFFORT}}', model: '{{MODEL}}', effort: '{{EFFORT}}', phase: 'Play' }),
]);
return { user, opus };
