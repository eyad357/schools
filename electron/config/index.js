'use strict';

/**
 * Main-process operational constants.
 *
 * Pulled out of electron/main/main.js so "what ports does this app try on
 * startup" isn't answered by the same file that also owns app lifecycle,
 * window creation, and crash recovery. Values are unchanged from before
 * this move — this is a relocation, not a behavior change.
 */

// Ports tried, in order, when starting the embedded server. 0 means "ask
// the OS for any free port" and is always the last resort.
const PREFERRED_PORTS = [3000, 3210, 4820, 5175, 0];

module.exports = { PREFERRED_PORTS };
