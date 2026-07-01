---
name: spectrum-gambit-autoplay
description: Run an end-to-end autonomous game on the live Spectrum Gambit (ZX-CHESS HC-91) site using two subagents — agent A is "the user" hosting the game in headless Chromium (set difficulty + clock), agent B is an LLM that plays it via MCP (set model + effort). Saves the verified leaderboard result and a final board screenshot. Use when asked to have two subagents play the chess game, or to re-run this autonomous-game experiment with different difficulty/clock/model/effort.
---

# Spectrum Gambit — autonomous two-agent game

Two subagents play a full game on the live site (https://cosmindxu.github.io/spectrum-gambit/):

- **Agent A — "the user" (Chromium driver).** Hosts the game in a headless, anti-throttled browser: new game at a chosen **difficulty** + **clock**, enables the AI Companion + auto-play, publishes a 6-char pairing code, snapshots the board, and on game-over saves the verified result + final screenshot. **Survives Chromium crashes** by relaunching the browser and resuming from a persistent profile (see gotchas). Script: `/home/dcosmin/spectrum-gambit/test/driver.mjs` (knobs via env).
- **Agent B — the LLM player.** Connects to the live MCP server with curl, pairs using the code, and plays White move-by-move until the game ends. Its **model** + **effort** are set on the `agent()` call.

They coordinate only through `/tmp/sg_game/code.txt` + the live MCP server. The driver's moves auto-play whatever B sends.

## Parameters (from the user's args; otherwise use defaults)

| Knob | Side | Values | Default |
|------|------|--------|---------|
| difficulty | A | 1–5 (5 = max) | 5 |
| clock | A | `off`, `3+2`, `5+0`, `10+5`, `15+10` | off |
| model | B | opus, sonnet, haiku, fable | opus |
| effort | B | low, medium, high, max | max |
| external tools | B | forbidden / allowed | **forbidden** |

Derive the leaderboard **name** from model+effort, e.g. `Opus max`, `Sonnet high` (this is what gets logged, satisfying "note the model + effort used"). If the user gave no values, use the defaults and say so. Only ask (AskUserQuestion) if they signalled they want to choose but were vague.

⚠️ A tight **clock** + a slow/high-effort **model** can flag the player on time (e.g. Opus/max deliberates ~1 min/move, so `5+0` would lose on time). Warn the user if their combo is risky.

### External engines / tools — forbidden by default 🚫
The ladder measures **the model's own chess**, so by default agent B may use **only its own reasoning**. The
`B_PROMPT` in `game-workflow.template.js` carries a **NO EXTERNAL ENGINES** block that forbids Stockfish/Leela,
python-chess evaluation or mate-search, tablebases, opening books, and any other move-evaluating tool (`curl` is
allowed **only** for the MCP endpoint). **Keep that block in place.** Remove it **only if the user EXPLICITLY asks**
to allow an external engine/tool — and if so, flag it in the leaderboard **name** (e.g. `Opus max +SF`) so the entry
isn't mistaken for the model's own play. Why it matters: a resourceful model (Opus was observed installing
**Stockfish 17.1** and verifying every move with it) otherwise logs engine-strength results that don't reflect the
model and aren't comparable with weaker models that played their own moves.

## Procedure

1. **Prep the workspace.** `mkdir -p /tmp/sg_game`; remove stale files (`code.txt status.txt result.json watchdog.log board.png final_board.png h b`) AND `rm -rf /tmp/sg_game/profile` (the persistent Chromium profile, so the game starts fresh). A clean workspace is REQUIRED — a leftover `code.txt` makes B pair the wrong/dead session. Kill any stale browser: `pkill -9 chromium` and `pkill -9 -f driver.mjs` (don't put `sg_game` in a pkill pattern — it self-matches the shell; an exit-1 from pkill is harmless).

2. **Build & launch the workflow.** Read `/home/dcosmin/spectrum-gambit/.claude/skills/spectrum-gambit-autoplay/scripts/game-workflow.template.js`, substitute every `{{LEVEL}} {{CLOCK}} {{MODEL}} {{EFFORT}} {{NAME}}`, and launch via the **Workflow** tool as the inline `script`. (Only the Workflow tool can set per-agent `effort`; this is why it's a workflow, not two Agent calls.) It runs A + B in `parallel()`.

3. **Confirm setup.** Wait (up to ~90s) for `/tmp/sg_game/code.txt`. Check `status.txt` shows `level reads <N>`, `autoplay=true`, `PAIRING CODE`. Within ~30s of B connecting you should see `LLM connected ✓` and a `board.png`.

4. **Start the watchdog** (background Bash): `SG_DIR=/tmp/sg_game python3 /home/dcosmin/spectrum-gambit/.claude/skills/spectrum-gambit-autoplay/scripts/watchdog.py`. It polls the authoritative position and EXITS (notifying you) on: result saved, game over, or a real B-stall (White-to-move, no move >5 min). Black-to-move "thinking" is the engine, not a stall.

5. **Monitor / report.** Give the user progress from `status.txt` + `watchdog.log` (move numbers should be **monotonic**). On request, send the latest `board.png` with `SendUserFile`. Don't busy-poll — the watchdog + workflow completion notify you.

6. **On game over** (`result.json` appears / workflow completes): read `result.json`, **send `/tmp/sg_game/final_board.png`** with `SendUserFile`, and report the outcome (win/loss/draw), final FEN, move count, AI-assisted flag, and the leaderboard save (`savedFlash`). The result is server-verified; a fake/wrong claim is rejected (422). The entry is flagged 🤖 since B played ≥50% of moves.

7. **Cleanup.** Stop the workflow (TaskStop on its task id) and the watchdog, `pkill -9 chromium`.

## Gotchas (already handled — don't rediscover them)

- **Throttling:** the headless page must stay "visible" or the emulator crawls (level-5 took 15 min/move). The driver overrides `document.visibilityState` + jiggles the mouse / `bringToFront` each tick → ~1 s/move. Don't remove that.
- **Speculative positions:** the Z80 engine searches on the live board, so mid-search it shows garbage. The DEPLOYED app (app.js + companion.js) now only reads/pushes **settled** positions (gated on `!thinking`). If positions ever **oscillate** (move number goes backwards), that gating regressed on the live site — re-check it.
- **Random Chromium crashes (this device):** headless Chromium here crashes unpredictably — anywhere from ~18 s to ~10 min — with `Attempted to use detached Frame` (not OOM; 3.8 GB free). A page `reload` can't fix it because the whole browser dies. The driver therefore does **crash-survival**: persistent `userDataDir` (game autosave + companion session on disk) + relaunch the whole browser + re-open the site on any crash → the game auto-resumes and Claude reconnects with the same code. Don't remove this. Expect a few `browser crash #N … recovered` lines per long game; that's normal. A faster model finishes in fewer minutes = fewer crashes to ride through.
- **2-minute Bash cap:** never write a single command that polls for minutes. The watchdog runs in the background; B is told to keep curl calls short and reason between them.
- **Cloudflare 403:** set `-H "User-Agent: curl/8"` on every curl to the worker (default UA is blocked). Already in the watchdog and B's prompt.
- **Pacing:** wall-clock is dominated by B's model/effort (Opus/max ≈ 1 min/move → ~25–40 min game), not the engine.
- **node_modules:** the driver imports `puppeteer-core` from `/home/dcosmin/spectrum-gambit/test/node_modules`, so it must run from that dir (the A prompt `cd`s there).

## Quick test (optional)

Verify just the browser side without a full game: `SETUP_ONLY=1 SG_LEVEL=5 node /home/dcosmin/spectrum-gambit/test/driver.mjs` — should print a pairing code and exit. To check engine speed at a level, see `test/` for the throttling/speed probes used during development.
