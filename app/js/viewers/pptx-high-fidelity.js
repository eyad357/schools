/* ════════════════════════════════════════════════════════════
   PPTX HIGH-FIDELITY FALLBACK — app/js/viewers/pptx-high-fidelity.js
   ────────────────────────────────────────────────────────────
   Phase 6C / 6C-F. Isolated, PPTX-specific module — nothing here leaks
   into viewer.js beyond the small generic hooks it already exposes
   (ctx.isActive, ctx.switchToPdfView, ctx.reopenNative — see viewer.js's
   renderPptx()).

   Phase 6C-F changed the DEFAULT behavior: opening any .pptx/.ppsx now
   tries the LibreOffice high-fidelity conversion FIRST, automatically,
   with no click required — renderAutomatic() below. It falls back to
   the native renderer (unchanged from Phase 6A-F) when LibreOffice is
   unavailable, the conversion fails, or it times out. Phase 6C's
   original opt-in button (attachButton) is preserved and still used —
   it's what appears on the NATIVE view whenever renderAutomatic()
   itself fell back, giving the user a manual retry (useful for a
   transient failure/timeout; not useful and correctly never shown when
   LibreOffice isn't installed at all, since checkAvailability() would
   say so again).

   Responsibilities:
     1. getPresentationRenderStrategy(nativeCapabilities) — pure decision
        function: does this file's content look like something the
        native renderer can't fully represent, and why (used for the
        native view's info-panel note + the manual button's tooltip;
        does NOT gate renderAutomatic() itself, which now applies
        unconditionally to every PPTX/PPSX per the 6C-F requirement).
     2. checkAvailability() — asks the server whether LibreOffice is
        resolvable at all (cached for the page's lifetime).
     3. renderAutomatic(ctx, {code, filename}) — the new default entry
        point. Returns true if it successfully switched to the
        high-fidelity PDF view (caller should do nothing further) or if
        the render became stale mid-flight (caller should also do
        nothing further — the ctx it was given is no longer current, so
        rendering native on top of it would be equally moot). Returns
        false only when the caller should proceed to render natively:
        LibreOffice unavailable, conversion failed, or conversion timed
        out.
     4. attachButton(ctx, {code, filename, strategy}) — adds the manual
        "high fidelity" retry button to the (fallback) native view.

   Server contract (server/routes/pptxHighFidelity.js):
     GET  /api/pptx-high-fidelity/available
          -> { available: boolean }
     POST /api/pptx-high-fidelity/:code/:name[?timeoutMs=N]
          -> streams back "Content-Type: application/pdf" on success,
             or a JSON { error, message } with a 4xx/5xx status on
             failure (LibreOffice missing / conversion timeout /
             conversion failed / invalid output). `timeoutMs` lets
             renderAutomatic() ask for a much shorter deadline than the
             manual button does (see AUTO_TIMEOUT_MS below) — nobody
             should wait two minutes on file OPEN just to land on the
             native fallback anyway.
   ════════════════════════════════════════════════════════════ */
const PptxHighFidelity = (function () {
  'use strict';

  // How long the AUTOMATIC (no-click) path waits before giving up and
  // falling back to native. Deliberately much shorter than the manual
  // button's server-side default (120s, unchanged) — a click is an
  // explicit "I'm willing to wait for this" signal; opening a file is
  // not, so a slow/stuck conversion must not stall the whole experience.
  const AUTO_TIMEOUT_MS = 20000;

  // getPresentationRenderStrategy — pure, no I/O. `nativeCapabilities`
  // matches the shape pptx-viewer.js computes during its own parse pass
  // (see renderNative()'s nativeCapabilities accumulator).
  function getPresentationRenderStrategy(nativeCapabilities) {
    const reasons = [];
    const c = nativeCapabilities || {};
    if (c.hasSmartArt) reasons.push('يحتوي هذا العرض على SmartArt (رسم تخطيطي ذكي)');
    if (c.degradedChartCount > 0) reasons.push(`يحتوي هذا العرض على ${c.degradedChartCount} رسم بياني من نوع غير مدعوم مباشرة (يُعرض كجدول بيانات)`);
    if (c.hasUnsupportedObjects) reasons.push('يحتوي هذا العرض على كائنات غير مدعومة (مثل ملفات مضمّنة)');
    if (c.hasEffects) reasons.push('يحتوي هذا العرض على تأثيرات بصرية متقدمة (ظلال/توهج/تأثيرات ثلاثية الأبعاد) لا تُعرض محليًا');
    if (c.hasAnimations) reasons.push('يحتوي هذا العرض على حركات/انتقالات — تُعرض الشريحة في حالتها الثابتة فقط');
    return { mode: reasons.length ? 'native-with-fallback' : 'native', reasons };
  }

  // Cached for the lifetime of the page — LibreOffice availability
  // cannot meaningfully change between two files opened moments apart
  // in the same session, so there's no reason to ask the server again
  // for every single PPTX the user opens.
  let availabilityCache = null;
  async function checkAvailability() {
    if (availabilityCache !== null) return availabilityCache;
    try {
      const res = await fetch(`${window.API || ''}/api/pptx-high-fidelity/available`);
      const data = await res.json();
      availabilityCache = !!data.available;
    } catch {
      availabilityCache = false;
    }
    return availabilityCache;
  }

  // Shared conversion request used by both the automatic and manual
  // paths — one place owns the fetch/error-parsing/blob logic so the
  // two call sites can't drift apart.
  async function requestConversion(code, filename, timeoutMs) {
    const qs = timeoutMs ? `?timeoutMs=${encodeURIComponent(timeoutMs)}` : '';
    const res = await fetch(`${window.API || ''}/api/pptx-high-fidelity/${encodeURIComponent(code)}/${encodeURIComponent(filename)}${qs}`, { method: 'POST' });
    if (!res.ok) {
      let message = 'تعذّر إنشاء عرض بجودة عالية لهذا الملف.';
      try { const errBody = await res.json(); if (errBody && errBody.message) message = errBody.message; } catch {}
      const err = new Error(message);
      err.httpStatus = res.status;
      throw err;
    }
    return res.blob();
  }

  // ── Phase 6C-F: automatic default path ─────────────────────────────
  async function renderAutomatic(ctx, opts) {
    const { code, filename } = opts;
    const { showLoading, isActive, switchToPdfView, addToolBtn } = ctx;

    const available = await checkAvailability();
    if (!available) return false; // LibreOffice unavailable -> caller renders native
    if (!isActive()) return true; // stale before we even started — nothing left to render for this call

    showLoading('جارٍ تحضير عرض بجودة عالية…');
    let blob;
    try {
      blob = await requestConversion(code, filename, AUTO_TIMEOUT_MS);
    } catch (err) {
      return false; // conversion failed/timed out -> caller renders native (silently; the native render's own loading state replaces this one immediately)
    }
    if (!isActive()) return true; // user moved on while the (potentially large) body was downloading

    const objectUrl = URL.createObjectURL(blob);
    if (ctx.state && ctx.state.objectUrls) ctx.state.objectUrls.push(objectUrl);
    await switchToPdfView(objectUrl);
    if (isActive()) {
      addToolBtn('⤺ العرض المحلي', 'التبديل إلى العرض المحلي داخل التطبيق (أسرع، دقة تقريبية)', () => ctx.reopenNative());
    }
    return true;
  }

  function attachButton(ctx, opts) {
    const { code, filename, strategy } = opts;
    const { addToolBtn, addSep, isActive, switchToPdfView } = ctx;
    // Availability check happens async, after the toolbar/slides have
    // already rendered — the native view is never blocked or delayed
    // waiting on it.
    checkAvailability().then((available) => {
      if (!available) return;
      if (!isActive()) return; // user already moved on before this resolved
      addSep();
      const label = strategy.mode === 'native-with-fallback' ? '⚠ عرض بجودة عالية' : '🖹 عرض بجودة عالية';
      const title = strategy.reasons.length
        ? 'هذا العرض يحتوي على عناصر قد لا تظهر بدقة كاملة في العرض المباشر:\n' + strategy.reasons.join('\n') + '\n\nانقر لعرضه بجودة عالية عبر LibreOffice (قد يستغرق بضع ثوانٍ).'
        : 'عرض هذا الملف بجودة عالية عبر LibreOffice — مفيد كمحاولة يدوية إذا فشلت المحاولة التلقائية.';
      const btn = addToolBtn(label, title, () => convertAndShow());
      let converting = false;

      async function convertAndShow() {
        if (converting) return;
        converting = true;
        const originalLabel = btn.textContent;
        btn.textContent = '⏳ جارٍ التحويل…';
        btn.disabled = true;
        try {
          const blob = await requestConversion(code, filename);
          if (!isActive()) return; // the user opened a different file while this was in flight — discard
          const objectUrl = URL.createObjectURL(blob);
          // state.objectUrls is the shell's own revoke-on-cleanup list —
          // switchToPdfView() calls cleanupPrevious() internally, which
          // already revokes everything in it, so this blob URL is
          // guaranteed disposed whenever the user navigates away.
          if (ctx.state && ctx.state.objectUrls) ctx.state.objectUrls.push(objectUrl);
          await switchToPdfView(objectUrl);
          // switchToPdfView() rebuilds the toolbar for the PDF viewer
          // (generic, knows nothing about PPTX) — the one PPTX-specific
          // addition, a way back to the native render, is appended here
          // instead, right after it, rather than teaching the generic
          // PDF path about PPTX.
          if (isActive()) ctx.addToolBtn('⤺ العرض الأصلي', 'العودة إلى العرض المباشر داخل التطبيق', () => ctx.reopenNative());
        } catch (err) {
          if (isActive()) showFidelityError(ctx, err && err.message ? err.message : 'تعذّر الاتصال بخدمة العرض بجودة عالية.');
        } finally {
          converting = false;
          if (document.body.contains(btn)) { btn.textContent = originalLabel; btn.disabled = false; }
        }
      }
    });
  }

  function showFidelityError(ctx, message) {
    const { dom } = ctx;
    const toast = document.createElement('div');
    toast.className = 'dv-hifi-toast';
    toast.textContent = message;
    (dom.content.parentElement || dom.content).appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  return { getPresentationRenderStrategy, checkAvailability, renderAutomatic, attachButton };
})();
