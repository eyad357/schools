'use strict';

/**
 * Server-layer operational constants.
 *
 * Pulled out of server/app.js so scattered magic numbers/strings (the
 * self-heal interval, the JSON body-size limit, the CSP policy) live in
 * one place instead of inline inside the app-factory function. Values are
 * unchanged from before this move — this is a relocation, not a behavior
 * change.
 *
 * Deliberately narrow in scope: constants that are already local to a
 * single file with a single caller (e.g. the SSE heartbeat interval in
 * routes/events.js, the audit-log cap in store/store.js, the upload
 * raw-body size limit in routes/files.js) were left where they are.
 * Moving every numeric literal in the codebase into a shared config
 * module would be exactly the kind of unnecessary, drive-by "clean
 * everything up" abstraction this refactoring phase is meant to avoid —
 * this module only collects the constants that were previously mixed
 * into server/app.js's own setup logic, which is the actual coupling
 * the Phase 0 audit flagged as worth separating.
 */

// How often createApp()'s self-heal loop re-checks that the evidence
// folder tree still exists and recreates anything missing.
const SELF_HEAL_INTERVAL_MS = 60 * 1000;

// express.json() body size limit for the small JSON API payloads (school
// info, settings, license activation, etc.). Evidence file bytes go
// through a separate, much larger express.raw() limit that stays local to
// server/routes/files.js, since it's a concern of that one upload route,
// not server-wide configuration.
const JSON_BODY_LIMIT = '5mb';

// Content-Security-Policy sent on every response. This is a local desktop
// app serving 100%-first-party content over 127.0.0.1 only — see
// PDF-ARCHITECTURE-REVIEW.md for why 'wasm-unsafe-eval' and an explicit
// worker-src are both present (the PDF engine's JPEG2000/JPX decoder and
// its module Worker, respectively).
const CONTENT_SECURITY_POLICY =
  "default-src 'self' http://localhost:* http://127.0.0.1:*; " +
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "worker-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:*; " +
  "connect-src 'self' http://localhost:* http://127.0.0.1:*";

module.exports = { SELF_HEAL_INTERVAL_MS, JSON_BODY_LIMIT, CONTENT_SECURITY_POLICY };
