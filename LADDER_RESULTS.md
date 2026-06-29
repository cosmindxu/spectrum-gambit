# Spectral Gambit — Opus/max ladder simulation

## Setup
- **Agent B (the player):** Claude **Opus, max effort**, playing **White**, fully autonomous via the live **MCP** server (no human moves).
- **Agent A (the "user"):** headless‑Chromium driver hosting the live game, with crash‑survival + auto board‑screenshots, run through the `/spectral-gambit-autoplay` skill.
- **Protocol:** start at **level 5**; after any game B does **not** win, drop one level; **stop on the first win** (or after level 1). Each game capped at 3 h.

## Results
| Game | Level | Result | Moves | How it went |
|------|-------|--------|-------|-------------|
| 1 | 5 | **Draw** | ~17 (then repetition) | Reached a sound position but couldn't make progress → **threefold repetition** |
| 2 | 4 | **Loss** | 37 | **Over‑sacrificed** material on an attack the engine refuted; blundered the last rook (34.Rg2?? Nxg2) → mated 37…Rd1# |
| 3 | **3** | **WIN** ✅ | 9 | Giuoco Piano miniature — engine blundered 6…Nxe4, **7.Qd5!** double attack, **9.Qf7#** |

**Outcome: Opus/max's first win is at level 3.** Levels 2 and 1 were not played (ladder stops on a win).

## Leaderboard
`Opus max` → **#1**, best level **3**, 1 win, **AI‑assisted (🦾)** — all results **server‑verified** (the L4 loss and L3 win from the checkmate FEN; draws now verifiable via position history).

## Observations
- **Conversion, not strength, was the problem.** Against the stronger engines (L5, L4) Opus reached good/winning‑looking positions but played sharp, speculative sacrifices it couldn't finish — drawing one and losing one. The weaker L3 engine blundered early and Opus punished it cleanly.
- **The on‑screen eval is misleading** (see the separate analysis) — it is shown from the *engine's* perspective, so large "+" numbers I read as "Opus winning" actually meant "the engine winning."
- **Infrastructure held up:** the skill drove all three games; the browser crashed in every game and **auto‑recovered** each time; the 3‑hour cap let the long games finish; and the new repetition‑draw verification + the existing win/loss verification all worked.

## Scale
Roughly an overnight run: G1 ~2 h (draw), G2 ~1.5 h (timeout) + ~2 h (re‑run, loss), G3 ~16 min (win). Opus/max averaged ~2.5–4 min/move.
