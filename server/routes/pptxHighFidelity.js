'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const evidenceService = require('../services/evidenceService');
const libreOfficeService = require('../services/libreOfficeService');
const FileSupportPolicy = require('../../app/js/file-support-policy.js');
const log = require('../../electron/utils/logger');

const router = express.Router();

const PRESENTATION_EXTS = new Set(['pptx', 'ppsx']);

// Distinct from FileSupportPolicy.getViewerCapabilities()'s own error
// codes — these map 1:1 onto libreOfficeService.LibreOfficeError codes,
// used by the frontend (app/js/viewers/pptx-high-fidelity.js) purely to
// pick a friendly message; the `message` field is already Arabic and
// user-facing on its own.
const ERROR_STATUS = {
  LIBREOFFICE_NOT_FOUND: 503,
  CONVERSION_TIMEOUT: 504,
  INVALID_OUTPUT: 502,
  CONVERSION_FAILED: 500,
};

router.get('/pptx-high-fidelity/available', async (req, res) => {
  const soffice = await libreOfficeService.resolveLibreOffice();
  res.json({ available: !!soffice });
});

router.post('/pptx-high-fidelity/:code/:name', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const { code, name } = req.params;

  const ext = FileSupportPolicy.getExtension(name);
  if (!PRESENTATION_EXTS.has(ext)) {
    return res.status(400).json({ error: 'NOT_A_PRESENTATION', message: 'هذا الملف ليس عرض PowerPoint (pptx/ppsx).' });
  }

  const filePath = await evidenceService.getFilePath(evidenceRoot, code, name);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'تعذّر العثور على الملف.' });
  }

  // Phase 6C-F: the automatic default-on-open flow (see
  // app/js/viewers/pptx-high-fidelity.js's renderAutomatic) wants a much
  // shorter deadline than an explicit user-initiated retry — nobody
  // should wait 2 minutes on file OPEN just to find out it's falling
  // back to native anyway. Callers may pass ?timeoutMs=N; clamped to a
  // sane range so a caller can't request an effectively-infinite wait
  // (0 would disable execFile's own timeout) or an unreasonably long one.
  const requestedTimeout = parseInt(req.query.timeoutMs, 10);
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.min(180000, Math.max(3000, requestedTimeout)) : 120000;

  let conversion;
  try {
    // No file-size limit here by design (see PHASE_6C brief) — a large
    // deck simply takes longer, bounded only by the timeout below, which
    // is generous specifically so large real-world decks aren't cut off.
    conversion = await libreOfficeService.convertToPdf(filePath, { timeoutMs });
  } catch (err) {
    const status = ERROR_STATUS[err.code] || 500;
    log.warn(`[pptx-high-fidelity] conversion failed for ${code}/${name}: ${err.code || err.message}`);
    return res.status(status).json({ error: err.code || 'CONVERSION_FAILED', message: err.message || 'فشل التحويل.' });
  }

  let responded = false;
  const finish = async () => {
    if (conversion) await conversion.cleanup();
  };
  try {
    res.setHeader('Content-Type', 'application/pdf');
    const baseName = path.basename(name, path.extname(name));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(baseName)}.pdf"`);
    const stream = fs.createReadStream(conversion.pdfPath);
    stream.on('error', async (err) => {
      log.warn(`[pptx-high-fidelity] stream error for ${code}/${name}: ${err.message}`);
      if (!responded) { responded = true; res.status(500).json({ error: 'STREAM_FAILED', message: 'تعذّر إرسال ملف PDF.' }); }
      await finish();
    });
    stream.on('close', async () => { responded = true; await finish(); });
    stream.pipe(res);
  } catch (err) {
    await finish();
    if (!responded) res.status(500).json({ error: 'STREAM_FAILED', message: err.message });
  }
});

module.exports = router;
