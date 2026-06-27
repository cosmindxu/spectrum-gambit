// Spectral Gambit runtime config.
//
// Leave SG_API_BASE empty ('') for:
//   - local LAN testing (auto-talks to the Python dev shim on :8100), and
//   - a single Cloudflare Worker that serves BOTH the static site and /api.
//
// Set it to your Worker URL ONLY when the static site and the API live on
// different origins (e.g. GitHub Pages static + a separate Worker):
//   window.SG_API_BASE = 'https://spectral-gambit-api.YOURNAME.workers.dev';
window.SG_API_BASE = 'https://spectral-gambit-api.cosmindxu.workers.dev';
