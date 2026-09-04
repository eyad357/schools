/* ════════════════════════════════════════════════════════════
   PRESENTATION (.pptx / .ppsx) VIEWER ENGINE — Phase 6A-F
   ────────────────────────────────────────────────────────────
   Shell-facing orchestrator: slide loop, presentation-specific UX
   (zoom/navigation/fullscreen/presentation mode/keyboard), and the DOM
   scaffold. OOXML parsing itself is split across sibling files this
   file depends on (loaded before it — see app/index.html):
     - pptx-common.js   shared OOXML/theme/geometry/text primitives
     - pptx-shapes.js   shapes/groups/connectors (incl. real nested
                        group-transform composition) + tables
     - pptx-charts.js   embedded charts, rendered as real SVG
     - pptx-smartart.js SmartArt diagrams
   pptx-shapes.js dispatches to pptx-charts.js/pptx-smartart.js itself
   for graphicFrame content it recognizes as a chart or diagram — this
   file never touches OOXML shape/chart/diagram internals directly.

   The shell (viewer.js) doesn't know anything about OOXML slide
   structure; this file doesn't know anything about the shell's
   toolbar/state/DOM plumbing beyond the `ctx` contract below.

   Contract: window.PptxViewer.render(ctx) where ctx provides:
     ctx.fetchBytes()           -> Promise<ArrayBuffer> current file's bytes
     ctx.showLoading(msg)       -> shows the shell's loading state
     ctx.showError(title, body) -> shows the shell's error state
     ctx.setInfoExtra(html)     -> populates the shell's info panel
     ctx.addSearchToggle()      -> wires the shell's in-viewer search button
     ctx.esc(str)               -> shared HTML-escaping helper
     ctx.dom.content            -> the shell's content container element
     ctx.dom.toolbar            -> the shell's toolbar element
     ctx.dom.statusLeft         -> the shell's status-bar left-side element
     ctx.state                  -> the shell's current-file state object
                                    (only `state.searchTarget` is written here)
     ctx.addToolBtn(label, title, onClick, opts?) -> shared toolbar button factory
     ctx.addSep()                -> shared toolbar separator
     ctx.addZoomControls(onZoom, initialPct) -> shared −/pct/+/reset zoom widget
                                    (this engine keeps its OWN zoom level —
                                    it does not use state.zoom/applyContentZoom,
                                    which only branch on image/word/text)
     ctx.toggleFullscreen()      -> shared fullscreen toggle for the whole viewer overlay
     ctx.setKeyHandler(fn)       -> registers fn(KeyboardEvent) => boolean as
                                    THIS render's keyboard handler; the shell
                                    calls it before its own key handling and
                                    skips its own handling for that event if
                                    fn returns true. Cleared automatically by
                                    the shell on the next open()/close().
     ctx.onCleanup(fn)           -> registers fn() to run once, automatically,
                                    when the shell tears this viewer down
                                    (switching files or closing) — this is how
                                    the ResizeObserver below gets disposed
                                    without the shell needing to know it exists.

   Depends on the globally-loaded JSZip vendor bundle and the browser's
   native DOMParser — both already loaded before this script by
   app/index.html, same as every other viewer engine.

   FIDELITY MODEL (what this does and does not reproduce)
   ────────────────────────────────────────────────────────────
   Reproduced:
     - real slide dimensions/aspect ratio (ppt/presentation.xml <p:sldSz>)
     - each shape's actual on-slide position/size/rotation/flip (<a:xfrm>),
       INCLUDING real nested-group-transform composition (chOff/chExt) —
       a group's children (and further-nested groups) are positioned via
       the actual OOXML coordinate-space math, not an approximation
     - text-less autoshapes (fill/border only — card backgrounds, icon
       circles, dividers) are rendered, not silently dropped
     - connectors/lines/arrows (<p:cxnSp>) as real SVG lines, honoring
       flip and arrowhead presence
     - embedded charts (bar/column, line, pie, doughnut, area) as real
       SVG charts with actual category/series/value data; other chart
       types fall back to a data table rather than disappearing
     - SmartArt diagrams, by reusing PowerPoint's own cached rendered
       shapes (ppt/diagrams/drawingN.xml) when present, or a structured
       text fallback from the semantic data model otherwise
     - slide background, INCLUDING inheritance: slide -> slide layout ->
       slide master, with theme color-scheme (<a:clrScheme>) resolution
       for schemeClr/sysClr references, not just literal srgbClr
     - multi-stop gradient fills (backgrounds AND shape fills), rendered
       as a real CSS linear-gradient() with every stop's actual position
       and color, not just an approximation of one stop
     - per-run text formatting: real font size (pt, converted to actual
       px from the rendered canvas width so it scales correctly), bold,
       italic, underline, text color (same theme-color resolution)
     - PowerPoint's own precomputed "shrink text to fit" factor
       (<a:normAutofit fontScale/lnSpcReduction>) where the source file
       stored one, PLUS a live shrink-to-fit pass (shrinkTextToFit) as a
       safety net for shapes that don't — either because autofit was
       never stored, or because the browser's substituted font renders
       slightly wider/taller than PowerPoint's own
     - image cropping (<a:srcRect>), paragraph alignment, RTL
       direction/detection, bullets, vertical text anchor, simple tables
   Deliberately NOT attempted (documented limitation, not a bug):
     - real PowerPoint fonts (the browser substitutes its own — this is
       also *why* the live shrink-to-fit pass above exists, not just
       normAutofit)
     - non-linear gradients (radial/path/circle) are approximated as a
       linear-gradient through the same stops/colors/order
     - picture slide/shape backgrounds (no background rather than a
       wrong guess), shadows/glow/soft-edge/reflection/3D effects,
       non-rectangular autoshape geometry beyond rect/roundRect/ellipse
     - exact bent/curved connector routing (approximated as a straight
       line between the connector's own bounding-box corners)
     - a custom <p:clrMap>/<p:clrMapOvr> color remap (the standard
       tx1->dk1/bg1->lt1/tx2->dk2/bg2->lt2 mapping is assumed)
     - animations, transitions (their metadata is never read, so it
       cannot break rendering — the final static slide state always
       renders); embedded OLE objects (shown as a labeled placeholder)
   See file-support-policy.js's fidelity:'partial' flag, which stays
   correct even with this pass's improvements — this is a much closer
   practical approximation, not a pixel-perfect PowerPoint clone.
   ════════════════════════════════════════════════════════════ */
const PptxViewer = (function () {
  'use strict';

  // OOXML/theme/geometry/text-formatting primitives now live in the
  // shared app/js/viewers/pptx-common.js (used by this file, plus
  // pptx-shapes.js/pptx-charts.js/pptx-smartart.js) — aliased to `C`
  // here so the rest of this file reads the same as before.
  const C = PptxCommon;

  async function render(ctx) {
    const {
      fetchBytes, showLoading, showError, setInfoExtra, addSearchToggle, esc, dom, state,
      addToolBtn, addSep, addZoomControls, toggleFullscreen, setKeyHandler, onCleanup,
    } = ctx;
    showLoading('جارٍ تحليل عرض PowerPoint…');
    if (typeof JSZip === 'undefined') { showError('تعذّر تحميل عارض العروض', 'مكوّن العرض غير متاح.'); return; }
    try {
      const buf = await fetchBytes();
      const zip = await JSZip.loadAsync(buf);
      const slideFiles = Object.keys(zip.files)
        .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .sort((a, b) => parseInt(a.match(/slide(\d+)\.xml/)[1], 10) - parseInt(b.match(/slide(\d+)\.xml/)[1], 10));
      if (!slideFiles.length) throw new Error('no slides found');

      // Real slide canvas size in EMU — everything is positioned as a
      // percentage of this, so the aspect ratio (16:9, 4:3, or custom)
      // matches the source file instead of being hardcoded.
      let slideCx = 12192000, slideCy = 6858000; // PowerPoint's modern 16:9 default, used only if presentation.xml is missing/unreadable
      const presXdoc = await C.loadXml(zip, 'ppt/presentation.xml');
      if (presXdoc) {
        const sz = presXdoc.getElementsByTagName('p:sldSz')[0];
        const cx = sz && parseInt(sz.getAttribute('cx'), 10);
        const cy = sz && parseInt(sz.getAttribute('cy'), 10);
        if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) { slideCx = cx; slideCy = cy; }
      }
      const defaultSizePt = { title: 32, body: 18 };
      const inheritanceCache = { byLayout: {}, byTheme: {} };

      const slides = [];
      // Cheap signal for the high-fidelity fallback decision (see
      // app/js/viewers/pptx-high-fidelity.js) — NOT used for rendering
      // itself, so a lightweight raw-text scan alongside the real parse
      // is fine (no extra DOM parsing needed for the two things not
      // already tracked as shape kinds: visual effects and animations).
      const nativeCapabilities = {
        hasCharts: false, degradedChartCount: 0, hasSmartArt: false,
        hasUnsupportedObjects: false, hasEffects: false, hasAnimations: false,
      };
      for (const slidePath of slideFiles) {
        // A single bad/unusual slide (malformed XML, an OOXML structure
        // this parser doesn't expect) must not take down the whole
        // presentation — render it as a clearly-marked broken slide
        // instead of aborting the entire render() call.
        try {
          const xdoc = await C.loadXml(zip, slidePath);
          const { clrScheme, layoutXdoc, masterXdoc } = await C.resolveSlideInheritance(zip, slidePath, inheritanceCache);
          const txStyles = C.parseTxStyles(masterXdoc, clrScheme);
          const relMap = await C.getRelsMap(zip, slidePath);

          const rawXml = zip.file(slidePath) ? await zip.file(slidePath).async('text') : '';
          if (rawXml.includes('<a:effectLst') || rawXml.includes('<a:effectDag')) nativeCapabilities.hasEffects = true;
          if (rawXml.includes('<p:timing>')) nativeCapabilities.hasAnimations = true;

          const spTree = xdoc.getElementsByTagName('p:spTree')[0];
          const topLevelShapes = spTree ? Array.from(spTree.children) : [];
          // Shape/group/connector/chart/SmartArt extraction (including
          // real nested-group transform composition) lives in
          // pptx-shapes.js, which itself delegates to pptx-charts.js /
          // pptx-smartart.js for graphicFrame content it recognizes as a
          // chart or a diagram. Per-shape error isolation happens inside
          // extractShapes() itself now (one bad shape anywhere, including
          // inside a group, only drops that shape).
          const shapes = await PptxShapes.extractShapes(topLevelShapes, {
            slideCx, slideCy, clrScheme, txStyles, zip, relMap, esc, defaultSizePt,
            slidePath, transform: PptxShapes.IDENTITY_TRANSFORM,
          });
          shapes.forEach(sh => {
            if (sh.kind === 'chart') { nativeCapabilities.hasCharts = true; if (sh.degraded) nativeCapabilities.degradedChartCount++; }
            if (sh.kind === 'smartart') nativeCapabilities.hasSmartArt = true;
            if (sh.kind === 'unsupported-object') nativeCapabilities.hasUnsupportedObjects = true;
          });
          let title = '';
          const titleShape = shapes.find(sh => sh.kind === 'title');
          if (titleShape) title = titleShape.html.replace(/<[^>]+>/g, '');

          // Many real-world decks (like this one) are custom-designed
          // without using an actual "title" placeholder on most slides —
          // that's a legitimate authoring choice, not missing data, but
          // it left the thumbnail rail showing "(بدون عنوان)" for nearly
          // every slide even when the slide clearly has real content.
          // Falls back to the first non-empty text shape's own first
          // line, trimmed, so the rail is actually useful for navigation.
          if (!title) {
            const firstTextShape = shapes.find(sh => sh.kind === 'text' || sh.kind === 'title');
            if (firstTextShape) {
              const plain = firstTextShape.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              if (plain) title = plain.length > 60 ? plain.slice(0, 60) + '…' : plain;
            }
          }
          const bg = C.resolveSlideBackground(xdoc, layoutXdoc, masterXdoc, clrScheme);
          slides.push({ title, shapes, bg });
        } catch (slideErr) {
          console.warn('[pptx-viewer] failed to render slide', slidePath, slideErr);
          slides.push({
            title: '', bg: null,
            shapes: [{ kind: 'text', pos: null, anchor: 'center',
              html: `<div class="dv-slide-line" data-pt="${defaultSizePt.body}">⚠ تعذّر عرض محتوى هذه الشريحة</div>` }],
          });
        }
      }

      // ── DOM scaffold ──
      dom.content.className = 'dv-content dv-content-flush';
      dom.content.innerHTML = `<div class="dv-slides-wrap">
        <div class="dv-slides-rail" id="dv-slides-rail"></div>
        <div class="dv-slide-stage" id="dv-slide-stage"></div>
      </div>`;
      const wrap = dom.content.querySelector('.dv-slides-wrap');
      const rail = dom.content.querySelector('#dv-slides-rail');
      const stage = dom.content.querySelector('#dv-slide-stage');
      // Phase 6C: the high-fidelity fallback decision is computed once,
      // here, and reused both for the info-panel note below and for the
      // toolbar button itself (see PptxHighFidelity.attachButton near
      // the end of this function) — PptxHighFidelity owns what the
      // decision MEANS; this function only owns wiring it into its own
      // DOM once.
      const fidelityStrategy = (typeof PptxHighFidelity !== 'undefined')
        ? PptxHighFidelity.getPresentationRenderStrategy(nativeCapabilities)
        : { mode: 'native', reasons: [] };
      const fidelityNoteRow = fidelityStrategy.reasons.length
        ? `<div class="dv-info-row"><span class="k">ملاحظة</span><span class="v" style="font-size:.68rem;font-weight:500;color:#b5651d">${esc('قد يفيد العرض بجودة عالية لهذا الملف: ' + fidelityStrategy.reasons.join('؛ '))}</span></div>`
        : '';
      setInfoExtra(`<div class="dv-info-row"><span class="k">عدد الشرائح</span><span class="v">${slides.length}</span></div>
        <div class="dv-info-row"><span class="k">ملاحظة</span><span class="v" style="font-size:.68rem;font-weight:500">معاينة تقريبية تحاكي التصميم الأصلي (الخلفية والخطوط والألوان) — الرسوم المتحركة والتأثيرات المتقدمة غير مدعومة</span></div>${fidelityNoteRow}`);

      // ── presentation-specific state (owned entirely by this engine) ──
      let current = 0;
      let zoomLevel = 1;
      let presenting = false;

      function applyFontScale(canvasEl) {
        const widthPx = canvasEl.clientWidth;
        if (!widthPx) return;
        const pxPerPt = (widthPx / (slideCx / 914400)) / 72;
        canvasEl.querySelectorAll('[data-pt]').forEach(el => {
          const pt = parseFloat(el.getAttribute('data-pt'));
          if (Number.isFinite(pt)) el.style.fontSize = (pt * pxPerPt) + 'px';
        });
      }
      // Safety net for shapes whose text still overflows its box after
      // applyFontScale() — either because the source file had no stored
      // <a:normAutofit> value at all (extractAutofit() defaulted to no
      // shrink), or because the browser's font metrics for the
      // substituted font run slightly wider/taller than PowerPoint's own.
      // Shrinks every sized line inside that ONE shape together (so
      // relative sizes — e.g. a bigger heading vs. smaller body line —
      // are preserved) in small steps until it fits or hits an 8px
      // readability floor, at which point it stops and lets the shape's
      // overflow:hidden clip as an honest last resort rather than
      // continuing to shrink text into illegibility.
      function shrinkTextToFit(canvasEl) {
        canvasEl.querySelectorAll('.dv-slide-shape').forEach(shapeEl => {
          const lines = shapeEl.querySelectorAll('[data-pt]');
          if (!lines.length) return;
          const maxH = shapeEl.clientHeight;
          if (!maxH) return; // unconstrained (flow-fallback) shape — nothing to fit against
          let guard = 0;
          while (shapeEl.scrollHeight > maxH + 1 && guard < 8) {
            let shrunkAny = false;
            lines.forEach(el => {
              const cur = parseFloat(el.style.fontSize) || 0;
              if (cur <= 8) return;
              el.style.fontSize = Math.max(8, cur * 0.94) + 'px';
              shrunkAny = true;
            });
            if (!shrunkAny) break;
            guard++;
          }
        });
      }
      function layoutText(canvasEl) {
        applyFontScale(canvasEl);
        shrinkTextToFit(canvasEl);
      }

      function draw(i) {
        current = Math.max(0, Math.min(slides.length - 1, i));
        rail.querySelectorAll('.dv-slide-thumb').forEach((t, ti) => t.classList.toggle('active', ti === current));
        const activeThumb = rail.children[current];
        if (activeThumb) activeThumb.scrollIntoView({ block: 'nearest' });
        const s = slides[current];
        const canvasStyle = `aspect-ratio:${slideCx}/${slideCy};${s.bg ? `background:${s.bg};` : ''}transform:scale(${zoomLevel});`;
        let flowTop = 4; // percent; running offset for shapes with no explicit position (e.g. some placeholder text)
        const shapeHtml = s.shapes.map(shape => {
          const pos = shape.pos;
          let style;
          if (pos) {
            style = `left:${pos.left}%;top:${pos.top}%;width:${pos.width}%;height:${pos.height}%;`;
            style += PptxShapes.transformCss(pos);
          } else {
            style = `left:4%;top:${flowTop}%;width:92%;`;
            flowTop += shape.kind === 'title' ? 14 : 10;
          }
          if (shape.fill) style += `background:${shape.fill};`;
          if (shape.border) style += `border:${shape.border.widthPx}px solid ${shape.border.color};`;
          if (shape.geomCss && shape.geomCss.borderRadius) style += `border-radius:${shape.geomCss.borderRadius};`;
          if (shape.anchor) style += `display:flex;flex-direction:column;justify-content:${shape.anchor};`;
          const kindClass = {
            title: ' dv-slide-shape-title', image: ' dv-slide-shape-image',
            connector: ' dv-slide-shape-connector', chart: ' dv-slide-shape-chart',
            smartart: ' dv-slide-shape-smartart', 'unsupported-object': ' dv-slide-shape-unsupported',
          }[shape.kind] || '';
          return `<div class="dv-slide-shape${kindClass}" style="${style}">${shape.html}</div>`;
        }).join('');
        stage.innerHTML = `<div class="dv-slide-canvas" style="${canvasStyle}">${
          shapeHtml || '<div class="dv-slide-empty-text">لا يوجد محتوى قابل للاستخراج في هذه الشريحة</div>'
        }</div>`;
        const canvasEl = stage.querySelector('.dv-slide-canvas');
        layoutText(canvasEl);
        state.searchTarget = stage;
        updateNavUi();
      }

      function goTo(i) { draw(i); }

      // ── navigation toolbar ──
      const counterEl = document.createElement('span'); counterEl.className = 'dv-slide-counter';
      function updateNavUi() {
        counterEl.textContent = `${current + 1} / ${slides.length}`;
        rail.querySelectorAll('.dv-slide-thumb').forEach((t, ti) => t.classList.toggle('active', ti === current));
      }
      addToolBtn('⏮', 'الشريحة الأولى', () => goTo(0), { iconOnly: true });
      addToolBtn('◀', 'الشريحة السابقة', () => goTo(current - 1), { iconOnly: true });
      dom.toolbar.appendChild(counterEl);
      addToolBtn('▶', 'الشريحة التالية', () => goTo(current + 1), { iconOnly: true });
      addToolBtn('⏭', 'الشريحة الأخيرة', () => goTo(slides.length - 1), { iconOnly: true });
      addSep();
      addZoomControls((delta) => {
        if (delta === 0) zoomLevel = 1;
        else zoomLevel = Math.min(3, Math.max(0.3, zoomLevel + delta));
        const pctEl = dom.toolbar.querySelector('#dv-zoom-pct');
        if (pctEl) pctEl.textContent = Math.round(zoomLevel * 100) + '%';
        const canvasEl = stage.querySelector('.dv-slide-canvas');
        if (canvasEl) canvasEl.style.transform = `scale(${zoomLevel})`;
      }, 1);
      addToolBtn('↔ ملء العرض', 'ملاءمة العرض', () => {
        zoomLevel = 1;
        const pctEl = dom.toolbar.querySelector('#dv-zoom-pct');
        if (pctEl) pctEl.textContent = '100%';
        const canvasEl = stage.querySelector('.dv-slide-canvas');
        if (canvasEl) canvasEl.style.transform = 'scale(1)';
      });
      addToolBtn('▢ ملء الشريحة', 'ملاءمة الشريحة داخل الإطار', () => {
        const canvasEl = stage.querySelector('.dv-slide-canvas');
        if (!canvasEl) return;
        const naturalHeight = canvasEl.getBoundingClientRect().height / zoomLevel;
        zoomLevel = Math.max(0.3, Math.min(1, stage.clientHeight / naturalHeight));
        const pctEl = dom.toolbar.querySelector('#dv-zoom-pct');
        if (pctEl) pctEl.textContent = Math.round(zoomLevel * 100) + '%';
        canvasEl.style.transform = `scale(${zoomLevel})`;
      });
      addSep();
      const presentBtn = addToolBtn('🖵 عرض تقديمي', 'وضع العرض التقديمي (ملء الشاشة، إخفاء قائمة الشرائح)', togglePresent);

      // Phase 6C high-fidelity fallback — isolated in its own module;
      // this is the entire adapter-level surface pptx-viewer.js needs
      // (availability check, button, conversion, and the handoff to the
      // existing PDF viewer all happen inside PptxHighFidelity itself).
      if (typeof PptxHighFidelity !== 'undefined') {
        PptxHighFidelity.attachButton(ctx, { code: state.code, filename: state.file.name, strategy: fidelityStrategy });
      }

      function togglePresent() {
        presenting = !presenting;
        wrap.classList.toggle('dv-presenting', presenting);
        presentBtn.classList.toggle('dv-btn-active', presenting);
        if (presenting && !document.fullscreenElement) toggleFullscreen();
        else if (!presenting && document.fullscreenElement) toggleFullscreen();
      }

      // ── keyboard navigation (Left/Right, PageUp/Down, Home/End, Esc
      // exits presentation mode specifically before falling through to
      // the shell's default Esc-closes-viewer behavior) ──
      setKeyHandler((e) => {
        const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
        if (typing) return false;
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { goTo(current + 1); e.preventDefault(); return true; }
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') { goTo(current - 1); e.preventDefault(); return true; }
        if (e.key === 'Home') { goTo(0); e.preventDefault(); return true; }
        if (e.key === 'End') { goTo(slides.length - 1); e.preventDefault(); return true; }
        if (e.key === 'Escape' && presenting) { togglePresent(); e.preventDefault(); return true; }
        return false; // let the shell handle plain Escape (close), F (fullscreen), Ctrl/Cmd+F (search)
      });

      // Font sizes are computed from the canvas's actual rendered pixel
      // width (see applyFontScale) — a container resize (window resize,
      // entering/leaving fullscreen or presentation mode) changes that
      // width without necessarily re-running draw(), so it needs its own
      // recompute hook. Disposed via ctx.onCleanup — without that this
      // would leak exactly like the pre-Phase-4 PDF observers did.
      const resizeObserver = new ResizeObserver(() => {
        const canvasEl = stage.querySelector('.dv-slide-canvas');
        if (canvasEl) layoutText(canvasEl);
      });
      resizeObserver.observe(stage);
      onCleanup(() => resizeObserver.disconnect());

      slides.forEach((s, i) => {
        const t = document.createElement('div');
        t.className = 'dv-slide-thumb';
        t.innerHTML = `<span class="dv-slide-thumb-num">${i + 1}</span>${esc(s.title || '(بدون عنوان)')}`;
        t.addEventListener('click', () => draw(i));
        rail.appendChild(t);
      });
      draw(0);
      addSearchToggle();
    } catch (err) {
      console.error(err);
      showError('تعذّر عرض الشرائح داخل التطبيق', 'يمكن تحميل الملف وفتحه في برنامج العروض التقديمية.');
    }
  }

  return { render };
})();
