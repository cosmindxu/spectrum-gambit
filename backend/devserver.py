#!/usr/bin/env python3
"""Local dev stand-in for the Cloudflare Worker — identical API, SQLite
backend. Lets us exercise the full compete flow on the LAN before
deploying. Run: python3 devserver.py [port]  (default 8100)."""
import json, os, re, sqlite3, sys, time, uuid, random, string
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DB = os.path.join(os.path.dirname(__file__), "spectrum.db")
SCHEMA = os.path.join(os.path.dirname(__file__), "schema.sql")

def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c

def init_db():
    with db() as c, open(SCHEMA) as f:
        c.executescript(f.read())

def now(): return int(time.time() * 1000)
def id6(): return ''.join(random.choices(string.ascii_lowercase + string.digits, k=10))
def tok(): return uuid.uuid4().hex

def verify_result(result, fen, position_keys):
    """Lightweight mirror of worker.js verifyResult(), enough to exercise the
    leaderboard fixes locally. This dev shim has no chess engine, so checkmate is
    accepted unverified (wins/losses) and stalemate / insufficient-material draws
    can't be recognised here — the Cloudflare Worker is authoritative for those in
    production. What IS checked: the FEN-derivable fifty-move rule and the
    client-supplied threefold-repetition proof, mirroring the relaxed worker check
    (final key present >=2x + its board+side-to-move matching the final FEN)."""
    if not isinstance(fen, str) or not fen:
        return (False, "no final position supplied")
    if result in ("win", "loss"):
        return (True, None)                       # needs chess.js; the Worker verifies
    if result == "draw":
        fields = fen.split(" ")
        # (b) fifty-move rule — halfmove clock in the FEN
        try:
            if int(fields[4]) >= 100:
                return (True, None)
        except (IndexError, ValueError):
            pass
        # (c) threefold repetition — the ~20Hz settle loop can record the final
        #     position as few as twice; accept >=2 and corroborate against the FEN.
        if isinstance(position_keys, list) and len(position_keys) >= 4:
            last = position_keys[-1] if position_keys else None
            if last and " ".join(last.split(" ")[:2]) == " ".join(fields[:2]) \
               and position_keys.count(last) >= 2:
                return (True, None)
        return (False, "not a verifiable draw (need the position history for a repetition)")
    return (False, "unknown result")


def leader_rows(c):
    return [dict(r) for r in c.execute("""
        SELECT name,
               MAX(CASE WHEN result='win' THEN level ELSE 0 END) AS best,
               SUM(CASE WHEN result='win' THEN 1 ELSE 0 END)     AS wins,
               COUNT(*)                                          AS games
        FROM ladder GROUP BY name
        ORDER BY best DESC, wins DESC, games ASC LIMIT 100""")]

class H(BaseHTTPRequestHandler):
    def _send(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try: return json.loads(self.rfile.read(n) or b"{}")
        except Exception: return {}
    def log_message(self, *a): pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        p = self.path.rstrip("/")
        with db() as c:
            m = re.match(r"^/api/games/([\w-]+)/state$", p)
            if m:
                g = c.execute("SELECT szx FROM games WHERE id=?", (m[1],)).fetchone()
                return self._send({"error": "not found"}, 404) if not g else self._send({"szx": g["szx"]})
            m = re.match(r"^/api/games/([\w-]+)$", p)
            if m:
                g = c.execute("SELECT * FROM games WHERE id=?", (m[1],)).fetchone()
                if not g: return self._send({"error": "not found"}, 404)
                return self._send({"id": g["id"], "mode": g["mode"], "status": g["status"],
                    "turn": g["turn"], "white": g["white_name"], "black": g["black_name"],
                    "movelog": json.loads(g["movelog"] or "[]"), "hasState": bool(g["szx"]),
                    "result": g["result"], "updated_at": g["updated_at"]})
            if p == "/api/leaderboard":
                ladder = leader_rows(c)
                recent = [dict(r) for r in c.execute(
                    "SELECT name,level,result,moves,created_at FROM ladder ORDER BY created_at DESC LIMIT 12")]
                return self._send({"ladder": ladder, "recent": recent})
        self._send({"error": "not found"}, 404)

    def do_POST(self):
        p = self.path.rstrip("/")
        b = self._body()
        with db() as c:
            if p == "/api/games":
                gid, wt, t = id6(), tok(), now()
                c.execute("""INSERT INTO games (id,mode,status,turn,white_name,white_token,movelog,created_at,updated_at)
                             VALUES (?,?,?,?,?,?,?,?,?)""",
                          (gid, b.get("mode", "h2h"), "waiting", "white",
                           (b.get("name") or "White")[:24], wt, "[]", t, t))
                return self._send({"id": gid, "color": "white", "token": wt})
            m = re.match(r"^/api/games/([\w-]+)/join$", p)
            if m:
                g = c.execute("SELECT * FROM games WHERE id=?", (m[1],)).fetchone()
                if not g: return self._send({"error": "not found"}, 404)
                if g["black_token"]: return self._send({"error": "already full"}, 409)
                bt = tok()
                c.execute("UPDATE games SET black_name=?,black_token=?,status=?,updated_at=? WHERE id=?",
                          ((b.get("name") or "Black")[:24], bt, "active", now(), m[1]))
                return self._send({"id": m[1], "color": "black", "token": bt})
            m = re.match(r"^/api/games/([\w-]+)/move$", p)
            if m:
                g = c.execute("SELECT * FROM games WHERE id=?", (m[1],)).fetchone()
                if not g: return self._send({"error": "not found"}, 404)
                token, szx = b.get("token"), b.get("szx")
                side = "white" if token == g["white_token"] else "black" if token == g["black_token"] else None
                if not side: return self._send({"error": "invalid token"}, 403)
                if g["status"] == "over": return self._send({"error": "game over"}, 409)
                if g["turn"] != side: return self._send({"error": "not your turn"}, 409)
                if not isinstance(szx, str) or len(szx) > 400000: return self._send({"error": "bad state"}, 400)
                nxt = "black" if side == "white" else "white"
                result = b.get("result")
                status = "over" if result else "active"
                c.execute("UPDATE games SET szx=?,movelog=?,turn=?,status=?,result=?,updated_at=? WHERE id=?",
                          (szx, json.dumps(b.get("movelog") or json.loads(g["movelog"] or "[]")),
                           nxt, status, result or g["result"], now(), m[1]))
                return self._send({"ok": True, "turn": nxt, "status": status})
            if p == "/api/ladder":
                name, level, result = b.get("name"), b.get("level"), b.get("result")
                if not (name and level and result): return self._send({"error": "missing fields"}, 400)
                ok, reason = verify_result(result, b.get("fen"), b.get("positionKeys"))
                if not ok: return self._send({"error": "result not verified: " + reason}, 422)
                c.execute("INSERT INTO ladder (name,level,result,moves,created_at) VALUES (?,?,?,?,?)",
                          (str(name)[:24], int(level), result, int(b.get("moves") or 0), now()))
                rows = leader_rows(c)
                rank = next((i + 1 for i, r in enumerate(rows) if r["name"] == str(name)[:24]), 0)
                return self._send({"ok": True, "rank": rank})
        self._send({"error": "not found"}, 404)

if __name__ == "__main__":
    init_db()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8100
    print(f"Spectrum Gambit dev API on :{port}  (db={DB})")
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
