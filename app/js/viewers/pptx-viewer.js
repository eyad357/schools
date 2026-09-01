/* ════════════════════════════════════════════════════════════
   PRESENTATION (.pptx / .ppsx) VIEWER ENGINE — Phase 6A
   ────────────────────────────────────────────────────────────
   Specialized viewer engine (Phase 7.5 shell/engine split). The
   shell (viewer.js) doesn't know anything about OOXML slide
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
     - each shape's actual on-slide position/size/rotation (<a:xfrm>)
     - slide background, INCLUDING inheritance: slide -> slide layout ->
       slide master, with theme color-scheme (<a:clrScheme>) resolution
       for schemeClr/sysClr references, not just literal srgbClr
     - per-run text formatting: real font size (pt, converted to actual
       px from the rendered canvas width so it scales correctly), bold,
       italic, underline, text color (same theme-color resolution)
     - shape fill color and border (solidFill/ln), also theme-resolved
     - paragraph alignment, RTL direction/detection, bullets
     - vertical text anchor (top/middle/bottom) within a shape
     - simple tables
   Deliberately NOT attempted (documented limitation, not a bug):
     - real PowerPoint fonts (the browser substitutes its own)
     - gradient/picture slide backgrounds beyond a flat color
       approximation (a gradient's first stop; a picture background falls
       back to no background rather than a wrong guess)
     - shadows, 3D effects, non-rectangular autoshape geometry
     - animations, transitions, embedded charts/SmartArt graphics (their
       text, where present in the XML, is still extracted)
     - nested-group exact transforms (see extractGroup below)
   See file-support-policy.js's fidelity:'partial' flag, which stays
   correct even with this pass's improvements — this is a much closer
   practical approximation, not a pixel-perfect PowerPoint clone.
   ════════════════════════════════════════════════════════════ */
const PptxViewer = (function () {
  'use strict';

  // ── OOXML path/relationship plumbing ──────────────────────────────

  // Resolves an OOXML relationship Target (e.g. "../media/image1.png") against
  // the directory of the file that referenced it (e.g. "ppt/slides"), the way
  // a real zip/relative-path resolver would — simple string concatenation
  // breaks on the leading "../" that PowerPoint always uses for media refs.
  function resolveOoxmlPath(baseDir, target) {
    const baseParts = baseDir.split('/').filter(Boolean);
    const targetParts = target.split('/').filter(Boolean);
    for (const part of targetParts) {
      if (part === '..') baseParts.pop();
      else if (part === '.') continue;
      else baseParts.push(part);
    }
    return baseParts.join('/');
  }
  function dirOf(path) { return path.split('/').slice(0, -1).join('/'); }

  const parser = new DOMParser();
  async function loadXml(zip, path) {
    const f = zip.file(path);
    if (!f) return null;
    return parser.parseFromString(await f.async('text'), 'application/xml');
  }
  async function getRelsMap(zip, ownerPath) {
    const relsPath = `${dirOf(ownerPath)}/_rels/${ownerPath.split('/').pop()}.rels`;
    const relsFile = zip.file(relsPath);
    if (!relsFile) return {};
    const xdoc = parser.parseFromString(await relsFile.async('text'), 'application/xml');
    const map = {};
    Array.from(xdoc.getElementsByTagName('Relationship')).forEach(r => {
      map[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type') || '' };
    });
    return map;
  }
  function findRelByTypeSuffix(relMap, suffix) {
    for (const id in relMap) if (relMap[id].type.endsWith(suffix)) return relMap[id];
    return null;
  }

  // ── theme / color-scheme resolution ───────────────────────────────

  // PowerPoint's default Office theme palette — used only when a deck's
  // own theme can't be resolved (e.g. a master/theme relationship is
  // missing), so a schemeClr reference still yields a plausible color
  // instead of nothing.
  const DEFAULT_SCHEME = {
    dk1: '#000000', lt1: '#FFFFFF', dk2: '#44546A', lt2: '#E7E6E6',
    accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000',
    accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72',
  };
  // <a:schemeClr val="tx1|tx2|bg1|bg2|..."> uses the "mapped" slot names
  // rather than the theme's own dk1/lt1/dk2/lt2 slot names. The standard
  // (and by far most common) mapping is tx1->dk1, bg1->lt1, tx2->dk2,
  // bg2->lt2; a deck can override this via <p:clrMap>/<p:clrMapOvr>, but
  // resolving a custom remap isn't attempted here — same tradeoff as the
  // gradient-background approximation below: the common case is handled
  // correctly, the rare case degrades to a reasonable default rather than
  // a wrong guess.
  const SCHEME_ALIAS = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };

  function parseClrScheme(themeXdoc) {
    if (!themeXdoc) return DEFAULT_SCHEME;
    const clrScheme = themeXdoc.getElementsByTagName('a:clrScheme')[0];
    if (!clrScheme) return DEFAULT_SCHEME;
    const scheme = {};
    ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].forEach(slot => {
      const el = clrScheme.getElementsByTagName('a:' + slot)[0];
      if (!el) return;
      const srgb = el.getElementsByTagName('a:srgbClr')[0];
      const sys = el.getElementsByTagName('a:sysClr')[0];
      if (srgb) scheme[slot] = '#' + srgb.getAttribute('val');
      else if (sys) scheme[slot] = '#' + (sys.getAttribute('lastClr') || '000000');
    });
    return Object.keys(scheme).length ? Object.assign({}, DEFAULT_SCHEME, scheme) : DEFAULT_SCHEME;
  }
  function resolveSchemeColor(name, clrScheme) {
    return clrScheme[SCHEME_ALIAS[name] || name] || null;
  }
  // Resolves whatever color node (a:srgbClr / a:schemeClr / a:sysClr) is
  // nested anywhere under a fill-like element (a:solidFill, a:ln, a
  // gradient stop, a:bgPr...). Ignores brightness/tint modifiers
  // (lumMod/lumOff/shade/tint) that can appear alongside a schemeClr —
  // a documented approximation, not an oversight.
  function resolveColor(fillEl, clrScheme) {
    if (!fillEl) return null;
    const srgb = fillEl.getElementsByTagName('a:srgbClr')[0];
    if (srgb) return '#' + srgb.getAttribute('val');
    const scheme = fillEl.getElementsByTagName('a:schemeClr')[0];
    if (scheme) return resolveSchemeColor(scheme.getAttribute('val'), clrScheme);
    const sys = fillEl.getElementsByTagName('a:sysClr')[0];
    if (sys) return '#' + (sys.getAttribute('lastClr') || '000000');
    return null;
  }

  // Resolves the slide->layout->master->theme chain for one slide and
  // returns its effective color scheme plus the layout/master XML (used
  // for background inheritance). Layout/master/theme are cached across
  // slides since most decks share one master+theme for every slide.
  async function resolveSlideInheritance(zip, slidePath, cache) {
    const slideRels = await getRelsMap(zip, slidePath);
    const layoutRel = findRelByTypeSuffix(slideRels, '/slideLayout');
    if (!layoutRel) return { clrScheme: DEFAULT_SCHEME, layoutXdoc: null, masterXdoc: null };
    const layoutPath = resolveOoxmlPath('ppt/slides', layoutRel.target);

    if (cache.byLayout[layoutPath]) return cache.byLayout[layoutPath];

    const layoutXdoc = await loadXml(zip, layoutPath);
    const layoutRels = await getRelsMap(zip, layoutPath);
    const masterRel = findRelByTypeSuffix(layoutRels, '/slideMaster');
    let masterXdoc = null, clrScheme = DEFAULT_SCHEME;
    if (masterRel) {
      const masterPath = resolveOoxmlPath(dirOf(layoutPath), masterRel.target);
      masterXdoc = await loadXml(zip, masterPath);
      const masterRels = await getRelsMap(zip, masterPath);
      const themeRel = findRelByTypeSuffix(masterRels, '/theme');
      if (themeRel) {
        const themePath = resolveOoxmlPath(dirOf(masterPath), themeRel.target);
        if (!cache.byTheme[themePath]) cache.byTheme[themePath] = parseClrScheme(await loadXml(zip, themePath));
        clrScheme = cache.byTheme[themePath];
      }
    }
    const result = { clrScheme, layoutXdoc, masterXdoc };
    cache.byLayout[layoutPath] = result;
    return result;
  }

  // Resolves ONE container's own background (a slide, its layout, or its
  // master each have the same <p:cSld><p:bg> shape) — solid fill,
  // gradient (approximated by its first stop's color), or a scheme-color
  // background reference. A picture/blip background is left unresolved
  // (see file header) rather than guessed.
  function resolveOwnBackground(xdoc, clrScheme) {
    const bg = xdoc && xdoc.getElementsByTagName('p:bg')[0];
    if (!bg) return null;
    const bgPr = bg.getElementsByTagName('p:bgPr')[0];
    if (bgPr) {
      const solidFill = bgPr.getElementsByTagName('a:solidFill')[0];
      if (solidFill) { const c = resolveColor(solidFill, clrScheme); if (c) return c; }
      const gradFill = bgPr.getElementsByTagName('a:gradFill')[0];
      if (gradFill) {
        const firstStop = gradFill.getElementsByTagName('a:gs')[0];
        const c = firstStop && resolveColor(firstStop, clrScheme);
        if (c) return c;
      }
    }
    const bgRef = bg.getElementsByTagName('p:bgRef')[0];
    if (bgRef) { const c = resolveColor(bgRef, clrScheme); if (c) return c; }
    return null;
  }
  // Slide -> layout -> master inheritance, in that order — the first
  // container that actually declares a background wins, matching how
  // PowerPoint itself resolves "use background from theme/master" slides.
  function resolveSlideBackground(slideXdoc, layoutXdoc, masterXdoc, clrScheme) {
    return resolveOwnBackground(slideXdoc, clrScheme)
        || resolveOwnBackground(layoutXdoc, clrScheme)
        || resolveOwnBackground(masterXdoc, clrScheme)
        || null;
  }

  // ── shape geometry / text formatting ──────────────────────────────

  function getXfrm(shapeOrFrameNode) {
    return shapeOrFrameNode && shapeOrFrameNode.getElementsByTagName('a:xfrm')[0];
  }
  // Converts a shape's <a:xfrm><a:off/><a:ext/></a:xfrm> (EMU units, the
  // OOXML measurement unit — 914400 per inch) into a position expressed as
  // a PERCENTAGE of the slide's real dimensions, plus its rotation. Percentages
  // (not px) are what let the same shape land in the same relative spot on
  // the slide canvas regardless of how large that canvas is actually rendered.
  function getXfrmPercent(shapeNode, slideCxEmu, slideCyEmu) {
    const xfrm = getXfrm(shapeNode);
    if (!xfrm) return null;
    const off = xfrm.getElementsByTagName('a:off')[0];
    const ext = xfrm.getElementsByTagName('a:ext')[0];
    if (!off || !ext) return null;
    const x = parseInt(off.getAttribute('x'), 10);
    const y = parseInt(off.getAttribute('y'), 10);
    const cx = parseInt(ext.getAttribute('cx'), 10);
    const cy = parseInt(ext.getAttribute('cy'), 10);
    if (![x, y, cx, cy].every(Number.isFinite)) return null;
    const rotRaw = xfrm.getAttribute('rot'); // 60,000ths of a degree
    const rotDeg = rotRaw ? parseInt(rotRaw, 10) / 60000 : 0;
    return {
      left: (x / slideCxEmu) * 100, top: (y / slideCyEmu) * 100,
      width: (cx / slideCxEmu) * 100, height: (cy / slideCyEmu) * 100,
      rotDeg,
    };
  }
  function extractShapeFill(spPrEl, clrScheme) {
    const solidFill = spPrEl && spPrEl.getElementsByTagName('a:solidFill')[0];
    return solidFill ? resolveColor(solidFill, clrScheme) : null;
  }
  function extractShapeBorder(spPrEl, clrScheme) {
    const ln = spPrEl && spPrEl.getElementsByTagName('a:ln')[0];
    if (!ln) return null;
    const solidFill = ln.getElementsByTagName('a:solidFill')[0];
    const color = solidFill && resolveColor(solidFill, clrScheme);
    if (!color) return null;
    const wEmu = parseInt(ln.getAttribute('w'), 10); // EMU; 12700 EMU = 1pt
    const widthPx = Number.isFinite(wEmu) ? Math.max(1, Math.round(wEmu / 12700)) : 1;
    return { color, widthPx };
  }
  const ANCHOR_TO_FLEX = { t: 'flex-start', ctr: 'center', b: 'flex-end' };
  function extractVerticalAnchor(spNode) {
    const bodyPr = spNode.getElementsByTagName('p:txBody')[0];
    const bp = bodyPr && bodyPr.getElementsByTagName('a:bodyPr')[0];
    const anchor = bp && bp.getAttribute('anchor');
    return ANCHOR_TO_FLEX[anchor] || 'flex-start';
  }

  // A paragraph is RTL if pPr explicitly says so, OR — since PowerPoint
  // exports from Arabic-locale authors don't always set rtl="1" on every
  // paragraph — if the extracted text itself is predominantly Arabic
  // script. Explicit markup wins; script sniffing is only a fallback.
  function paragraphIsRtl(pNode, text) {
    const pPr = pNode.getElementsByTagName('a:pPr')[0];
    if (pPr && pPr.getAttribute('rtl') === '1') return true;
    if (pPr && pPr.getAttribute('rtl') === '0') return false;
    return /[\u0600-\u06FF\u0750-\u077F]/.test(text);
  }
  function paragraphBulletPrefix(pNode) {
    const pPr = pNode.getElementsByTagName('a:pPr')[0];
    if (!pPr) return '';
    if (pPr.getElementsByTagName('a:buNone').length) return '';
    const buChar = pPr.getElementsByTagName('a:buChar')[0];
    if (buChar && buChar.getAttribute('char')) return buChar.getAttribute('char') + ' ';
    if (pPr.getElementsByTagName('a:buAutoNum').length) return '• ';
    return '';
  }
  function looksArabicLine(text) { return /[\u0600-\u06FF\u0750-\u077F]/.test(text); }
  const ALGN_TO_CSS = { l: 'left', ctr: 'center', r: 'right', just: 'justify' };
  function paragraphAlign(pNode) {
    const pPr = pNode.getElementsByTagName('a:pPr')[0];
    const algn = pPr && pPr.getAttribute('algn');
    return ALGN_TO_CSS[algn] || '';
  }
  // Reads sz (hundredths of a point)/bold/italic/underline/color off a single
  // <a:rPr> or <a:defRPr> element. Returns {} for a missing element so
  // Object.assign(default, override) composition below "just works".
  function getRunProps(rPrEl, clrScheme) {
    const props = {};
    if (!rPrEl) return props;
    const sz = rPrEl.getAttribute('sz');
    if (sz) props.sizePt = parseInt(sz, 10) / 100;
    if (rPrEl.getAttribute('b') === '1') props.bold = true;
    if (rPrEl.getAttribute('i') === '1') props.italic = true;
    const u = rPrEl.getAttribute('u');
    if (u && u !== 'none') props.underline = true;
    const solidFill = rPrEl.getElementsByTagName('a:solidFill')[0];
    if (solidFill) { const c = resolveColor(solidFill, clrScheme); if (c) props.color = c; }
    return props;
  }

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
      const presXdoc = await loadXml(zip, 'ppt/presentation.xml');
      if (presXdoc) {
        const sz = presXdoc.getElementsByTagName('p:sldSz')[0];
        const cx = sz && parseInt(sz.getAttribute('cx'), 10);
        const cy = sz && parseInt(sz.getAttribute('cy'), 10);
        if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) { slideCx = cx; slideCy = cy; }
      }
      const defaultSizePt = { title: 32, body: 18 };
      const inheritanceCache = { byLayout: {}, byTheme: {} };

      function extractTextShape(sp, clrScheme) {
        const paras = Array.from(sp.getElementsByTagName('a:p'));
        const ph = sp.getElementsByTagName('p:ph')[0];
        const isTitle = !!(ph && /title|ctrTitle/i.test(ph.getAttribute('type') || ''));
        const lines = [];
        for (const p of paras) {
          const pPr = p.getElementsByTagName('a:pPr')[0];
          const defRPr = pPr && pPr.getElementsByTagName('a:defRPr')[0];
          const paraDefaults = getRunProps(defRPr, clrScheme);
          const runs = Array.from(p.getElementsByTagName('a:r'));
          const spans = [];
          let lineText = '';
          for (const r of runs) {
            const tEl = r.getElementsByTagName('a:t')[0];
            const text = tEl ? tEl.textContent : '';
            if (!text) continue;
            const rPr = r.getElementsByTagName('a:rPr')[0];
            const props = Object.assign({}, paraDefaults, getRunProps(rPr, clrScheme));
            spans.push({ text, props });
            lineText += text;
          }
          if (!lineText.trim()) continue;
          const sizePt = (spans.find(s => s.props.sizePt) || {}).props.sizePt || (isTitle ? defaultSizePt.title : defaultSizePt.body);
          lines.push({
            spans, sizePt,
            rtl: paragraphIsRtl(p, lineText),
            align: paragraphAlign(p),
            bullet: paragraphBulletPrefix(p),
          });
        }
        if (!lines.length) return null;
        const pos = getXfrmPercent(sp.getElementsByTagName('p:spPr')[0], slideCx, slideCy);
        const fill = extractShapeFill(sp.getElementsByTagName('p:spPr')[0], clrScheme);
        const border = extractShapeBorder(sp.getElementsByTagName('p:spPr')[0], clrScheme);
        const anchor = extractVerticalAnchor(sp);
        const html = lines.map(l => {
          const spansHtml = l.spans.map(s => {
            let style = '';
            if (s.props.bold) style += 'font-weight:700;';
            if (s.props.italic) style += 'font-style:italic;';
            if (s.props.underline) style += 'text-decoration:underline;';
            if (s.props.color) style += `color:${s.props.color};`;
            return style ? `<span style="${style}">${esc(s.text)}</span>` : esc(s.text);
          }).join('');
          return `<div class="dv-slide-line" data-pt="${l.sizePt}"${l.rtl ? ' dir="rtl"' : ''}${l.align ? ` style="text-align:${l.align}"` : ''}>${esc(l.bullet)}${spansHtml}</div>`;
        }).join('');
        return { kind: isTitle ? 'title' : 'text', pos, html, isTitle, fill, border, anchor };
      }

      async function extractImageShape(pic, relMap) {
        const pos = getXfrmPercent(pic.getElementsByTagName('p:spPr')[0], slideCx, slideCy);
        const blip = pic.getElementsByTagName('a:blip')[0];
        const rId = blip && blip.getAttribute('r:embed');
        const target = rId && relMap[rId] && relMap[rId].target;
        if (!target) return null;
        const mediaPath = resolveOoxmlPath('ppt/slides', target);
        const mf = zip.file(mediaPath);
        if (!mf) return null;
        const base64 = await mf.async('base64');
        const ext = mediaPath.split('.').pop().toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/png';
        return { kind: 'image', pos, html: `<img src="data:${mime};base64,${base64}" alt="">` };
      }

      function extractTable(graphicFrame, clrScheme) {
        const tbl = graphicFrame.getElementsByTagName('a:tbl')[0];
        if (!tbl) return null;
        const rows = Array.from(tbl.getElementsByTagName('a:tr'));
        if (!rows.length) return null;
        const rowsHtml = rows.map(tr => {
          const cells = Array.from(tr.getElementsByTagName('a:tc'));
          const cellsHtml = cells.map(tc => {
            const text = Array.from(tc.getElementsByTagName('a:t')).map(t => t.textContent).join(' ');
            const tcPr = tc.getElementsByTagName('a:tcPr')[0];
            const fill = tcPr && extractShapeFill(tcPr, clrScheme);
            return `<td${fill ? ` style="background:${fill}"` : ''}>${esc(text)}</td>`;
          }).join('');
          return `<tr>${cellsHtml}</tr>`;
        }).join('');
        // <p:graphicFrame>'s own xfrm is a direct child, not under p:spPr
        // (unlike <p:sp>/<p:pic>) — OOXML puts it directly under
        // <p:xfrm> at the graphicFrame level.
        const pos = getXfrmPercent(graphicFrame, slideCx, slideCy);
        return { kind: 'table', pos, html: `<table class="dv-slide-table">${rowsHtml}</table>` };
      }

      const slides = [];
      for (const slidePath of slideFiles) {
        const xdoc = await loadXml(zip, slidePath);
        const { clrScheme, layoutXdoc, masterXdoc } = await resolveSlideInheritance(zip, slidePath, inheritanceCache);
        const relMap = await getRelsMap(zip, slidePath);

        const spTree = xdoc.getElementsByTagName('p:spTree')[0];
        const topLevelShapes = spTree ? Array.from(spTree.children) : [];
        const shapes = [];
        let title = '';
        for (const node of topLevelShapes) {
          const tag = node.tagName;
          if (tag === 'p:sp') {
            const shape = extractTextShape(node, clrScheme);
            if (shape) {
              if (shape.isTitle && !title) title = shape.html.replace(/<[^>]+>/g, '');
              shapes.push(shape);
            }
          } else if (tag === 'p:pic') {
            const img = await extractImageShape(node, relMap);
            if (img) shapes.push(img);
          } else if (tag === 'p:graphicFrame') {
            const table = extractTable(node, clrScheme);
            if (table) shapes.push(table);
          } else if (tag === 'p:grpSp') {
            // Grouped shapes: nested transforms would need full group
            // coordinate-space math to position exactly, which isn't
            // worth the complexity for a preview — instead, resolve the
            // group's own bounding box (its <p:grpSpPr><a:xfrm>) and stack
            // its children's text inside it. Approximate, but every
            // group's text still appears roughly where the group itself
            // sits on the slide, rather than being silently dropped.
            const groupPos = getXfrmPercent(node.getElementsByTagName('p:grpSpPr')[0], slideCx, slideCy);
            const innerParas = Array.from(node.getElementsByTagName('a:p'));
            const innerLines = innerParas
              .map(p => Array.from(p.getElementsByTagName('a:t')).map(t => t.textContent).join(''))
              .filter(t => t.trim());
            if (innerLines.length) {
              const html = innerLines.map(t => `<div class="dv-slide-line" data-pt="${defaultSizePt.body}"${looksArabicLine(t) ? ' dir="rtl"' : ''}>${esc(t)}</div>`).join('');
              shapes.push({ kind: 'text', pos: groupPos, html, anchor: 'flex-start' });
            }
          }
        }

        const bg = resolveSlideBackground(xdoc, layoutXdoc, masterXdoc, clrScheme);
        slides.push({ title, shapes, bg });
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
      setInfoExtra(`<div class="dv-info-row"><span class="k">عدد الشرائح</span><span class="v">${slides.length}</span></div>
        <div class="dv-info-row"><span class="k">ملاحظة</span><span class="v" style="font-size:.68rem;font-weight:500">معاينة تقريبية تحاكي التصميم الأصلي (الخلفية والخطوط والألوان) — الرسوم المتحركة والتأثيرات المتقدمة غير مدعومة</span></div>`);

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
            if (pos.rotDeg) style += `transform:rotate(${pos.rotDeg}deg);`;
          } else {
            style = `left:4%;top:${flowTop}%;width:92%;`;
            flowTop += shape.kind === 'title' ? 14 : 10;
          }
          if (shape.fill) style += `background:${shape.fill};`;
          if (shape.border) style += `border:${shape.border.widthPx}px solid ${shape.border.color};`;
          if (shape.anchor) style += `display:flex;flex-direction:column;justify-content:${shape.anchor};`;
          const kindClass = shape.kind === 'title' ? ' dv-slide-shape-title' : shape.kind === 'image' ? ' dv-slide-shape-image' : '';
          return `<div class="dv-slide-shape${kindClass}" style="${style}">${shape.html}</div>`;
        }).join('');
        stage.innerHTML = `<div class="dv-slide-canvas" style="${canvasStyle}">${
          shapeHtml || '<div class="dv-slide-empty-text">لا يوجد محتوى قابل للاستخراج في هذه الشريحة</div>'
        }</div>`;
        const canvasEl = stage.querySelector('.dv-slide-canvas');
        applyFontScale(canvasEl);
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
        if (canvasEl) applyFontScale(canvasEl);
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
