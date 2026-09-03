/* ════════════════════════════════════════════════════════════
   PPTX SHARED PRIMITIVES — app/js/viewers/pptx-common.js
   ────────────────────────────────────────────────────────────
   OOXML path/relationship resolution, theme/color-scheme resolution,
   slide/layout/master inheritance, geometry, and text-formatting
   primitives shared by every PPTX-related engine file:
     - pptx-viewer.js   (shell orchestration + presentation UX)
     - pptx-shapes.js   (shape/group/connector geometry + text)
     - pptx-charts.js   (chart rendering)
     - pptx-smartart.js (SmartArt/diagram rendering)

   This file has NO dependency on any of the others — it only needs
   the browser's native DOMParser (already loaded before this script,
   same as every other viewer engine) and the JSZip instance the
   caller already has open. Exposed as window.PptxCommon.

   Extracted out of pptx-viewer.js (previously duplicated logic risk
   was exactly the class of bug the Phase 5-7.5 root-cause audit found
   for viewer.js/file-support-policy.js — a single shared copy is the
   fix, not a coincidence).
   ════════════════════════════════════════════════════════════ */
const PptxCommon = (function () {
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
  // master each have the same <p:cSld><p:bg> shape) — solid fill, a real
  // multi-stop CSS gradient (see buildGradientCss), or a scheme-color
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
      if (gradFill) { const g = buildGradientCss(gradFill, clrScheme); if (g) return g; }
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

  // ── geometry ───────────────────────────────────────────────────────

  function getXfrm(shapeOrFrameNode) {
    if (!shapeOrFrameNode) return null;
    // <p:sp>/<p:pic>/<p:cxnSp>'s own transform lives under <a:xfrm>, but
    // <p:graphicFrame> (tables, charts, SmartArt) uses <p:xfrm> instead —
    // a real, previously-undiscovered bug: checking only 'a:xfrm' silently
    // returned null for every graphicFrame, so tables were never using
    // their real slide position at all, only the "no position" flow
    // fallback meant for placeholder shapes with inherited-not-explicit
    // positions. Checking both tag names fixes real table (and now
    // chart/SmartArt) positioning.
    return shapeOrFrameNode.getElementsByTagName('a:xfrm')[0]
        || shapeOrFrameNode.getElementsByTagName('p:xfrm')[0];
  }
  // Converts a shape's <a:xfrm><a:off/><a:ext/></a:xfrm> (EMU units, the
  // OOXML measurement unit — 914400 per inch) into a position expressed as
  // a PERCENTAGE of the slide's real dimensions, plus its rotation/flip.
  // Percentages (not px) are what let the same shape land in the same
  // relative spot on the slide canvas regardless of how large that canvas
  // is actually rendered.
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
      flipH: xfrm.getAttribute('flipH') === '1',
      flipV: xfrm.getAttribute('flipV') === '1',
      // Raw EMU box too — group child-coordinate-space mapping (see
      // pptx-shapes.js mapGroupChildXfrm) needs the un-normalized values,
      // not just the slide-relative percentage.
      xEmu: x, yEmu: y, cxEmu: cx, cyEmu: cy,
    };
  }
  // A group's own <p:xfrm> additionally carries <a:chOff>/<a:chExt> — the
  // "child coordinate space" that its children's own xfrm values are
  // expressed in. This is what makes group children position correctly:
  // without it, a child's raw EMU coordinates are meaningless outside the
  // group's local (and possibly rescaled) coordinate system.
  function getGroupXfrm(grpSpPrNode, slideCxEmu, slideCyEmu) {
    const outer = getXfrmPercent(grpSpPrNode, slideCxEmu, slideCyEmu);
    const xfrm = getXfrm(grpSpPrNode);
    if (!outer || !xfrm) return null;
    const chOff = xfrm.getElementsByTagName('a:chOff')[0];
    const chExt = xfrm.getElementsByTagName('a:chExt')[0];
    const chOffX = chOff ? parseInt(chOff.getAttribute('x'), 10) : outer.xEmu;
    const chOffY = chOff ? parseInt(chOff.getAttribute('y'), 10) : outer.yEmu;
    const chExtCx = chExt ? parseInt(chExt.getAttribute('cx'), 10) : outer.cxEmu;
    const chExtCy = chExt ? parseInt(chExt.getAttribute('cy'), 10) : outer.cyEmu;
    return {
      outer,
      chOffX: Number.isFinite(chOffX) ? chOffX : outer.xEmu,
      chOffY: Number.isFinite(chOffY) ? chOffY : outer.yEmu,
      chExtCx: Number.isFinite(chExtCx) && chExtCx !== 0 ? chExtCx : outer.cxEmu,
      chExtCy: Number.isFinite(chExtCy) && chExtCy !== 0 ? chExtCy : outer.cyEmu,
    };
  }
  // Builds a real CSS linear-gradient() from OOXML's <a:gradFill> — all
  // stops (not just the first, unlike an earlier flat-color
  // approximation) with their actual positions/colors, and the actual
  // angle. OOXML angles are measured clockwise from 3 o'clock (east);
  // CSS linear-gradient() angles are measured clockwise from 12 o'clock
  // (north) — hence the +90° conversion below.
  function buildGradientCss(gradFillEl, clrScheme) {
    const stops = Array.from(gradFillEl.getElementsByTagName('a:gs'));
    if (!stops.length) return null;
    const parsed = stops.map(gs => {
      const posAttr = gs.getAttribute('pos'); // 0–100000 = 0–100%, in thousandths of a percent
      const pos = posAttr ? parseInt(posAttr, 10) / 1000 : 0;
      return { pos, color: resolveColor(gs, clrScheme) || '#000000' };
    }).sort((a, b) => a.pos - b.pos);
    const lin = gradFillEl.getElementsByTagName('a:lin')[0];
    let angleDeg = 90; // no <a:lin> (e.g. a radial/path gradient) — approximate as left-to-right
    const angAttr = lin && lin.getAttribute('ang');
    if (angAttr) angleDeg = (parseInt(angAttr, 10) / 60000 + 90) % 360;
    return `linear-gradient(${angleDeg}deg, ${parsed.map(s => `${s.color} ${s.pos}%`).join(', ')})`;
  }
  function extractShapeFill(spPrEl, clrScheme) {
    if (!spPrEl) return null;
    const noFill = spPrEl.getElementsByTagName('a:noFill')[0];
    if (noFill) return null;
    const solidFill = spPrEl.getElementsByTagName('a:solidFill')[0];
    if (solidFill) { const c = resolveColor(solidFill, clrScheme); if (c) return c; }
    const gradFill = spPrEl.getElementsByTagName('a:gradFill')[0];
    if (gradFill) { const g = buildGradientCss(gradFill, clrScheme); if (g) return g; }
    return null;
  }
  function extractShapeBorder(spPrEl, clrScheme) {
    const ln = spPrEl && spPrEl.getElementsByTagName('a:ln')[0];
    if (!ln) return null;
    if (ln.getElementsByTagName('a:noFill')[0]) return null;
    const solidFill = ln.getElementsByTagName('a:solidFill')[0];
    const color = solidFill && resolveColor(solidFill, clrScheme);
    if (!color) return null;
    const wEmu = parseInt(ln.getAttribute('w'), 10); // EMU; 12700 EMU = 1pt
    const widthPx = Number.isFinite(wEmu) ? Math.max(1, Math.round(wEmu / 12700)) : 1;
    return { color, widthPx };
  }
  // Maps an OOXML <a:prstGeom prst="..."> preset to a CSS approximation.
  // Only the shapes common enough in real decks to matter visually get a
  // real approximation (rounded corners, circles/ellipses, common
  // arrows); anything else safely falls back to a plain rectangle — the
  // fill/border/text still render, just not the exact outline, which is
  // far better than the shape disappearing entirely (the previous
  // behavior for any text-less autoshape).
  function extractGeometryCss(spPrEl) {
    const prstGeom = spPrEl && spPrEl.getElementsByTagName('a:prstGeom')[0];
    const prst = prstGeom ? prstGeom.getAttribute('prst') : 'rect';
    switch (prst) {
      case 'ellipse':
      case 'oval':
        return { borderRadius: '50%' };
      case 'roundRect':
      case 'round2SameRect':
      case 'round2DiagRect':
        return { borderRadius: '12%' }; // OOXML stores an exact corner-radius adjustment value (avLst/gd); a fixed proportional radius is a reasonable visual approximation without parsing it
      default:
        return {};
    }
  }
  const ANCHOR_TO_FLEX = { t: 'flex-start', ctr: 'center', b: 'flex-end' };
  function extractVerticalAnchor(spNode) {
    const bodyPr = spNode.getElementsByTagName('p:txBody')[0];
    const bp = bodyPr && bodyPr.getElementsByTagName('a:bodyPr')[0];
    const anchor = bp && bp.getAttribute('anchor');
    return ANCHOR_TO_FLEX[anchor] || 'flex-start';
  }
  // PowerPoint's own "shrink text on overflow" autofit
  // (<a:bodyPr><a:normAutofit fontScale="62500" lnSpcReduction="20000"/>) —
  // when a user's text no longer fits its box, PowerPoint itself computes
  // and stores exactly how much to shrink the font (fontScale) and tighten
  // line spacing (lnSpcReduction), both in thousandths of a percent.
  function extractAutofit(spNode) {
    const bodyPr = spNode.getElementsByTagName('p:txBody')[0];
    const bp = bodyPr && bodyPr.getElementsByTagName('a:bodyPr')[0];
    const normAutofit = bp && bp.getElementsByTagName('a:normAutofit')[0];
    if (!normAutofit) return { fontScale: 1, lnSpcReduction: 0 };
    const fs = normAutofit.getAttribute('fontScale');
    const lr = normAutofit.getAttribute('lnSpcReduction');
    const fontScale = fs ? parseInt(fs, 10) / 100000 : 1;
    const lnSpcReduction = lr ? parseInt(lr, 10) / 100000 : 0;
    return {
      fontScale: Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1,
      lnSpcReduction: Number.isFinite(lnSpcReduction) && lnSpcReduction >= 0 ? lnSpcReduction : 0,
    };
  }

  // ── paragraph / run text formatting ───────────────────────────────

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
  // Object.assign(default, override) composition elsewhere "just works".
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

  // ── master-level default text formatting (<p:txStyles>) ────────────
  // Real-world PPTX text very often has NO explicit font size on the run,
  // the paragraph's defRPr, or anywhere in the slide XML at all —
  // PowerPoint resolves it from the slide MASTER's <p:txStyles>
  // (<p:titleStyle>/<p:bodyStyle>/<p:otherStyle>, each with up to 9
  // outline-level <a:lvlNpPr><a:defRPr>) instead. This is a real
  // inheritance layer (paragraph run > paragraph defRPr > master txStyles
  // for this outline level > flat renderer default) — every lookup here
  // returns {} rather than throwing on a missing level/style block.
  function parseTxStyles(masterXdoc, clrScheme) {
    const empty = { title: [], body: [], other: [] };
    if (!masterXdoc) return empty;
    const txStyles = masterXdoc.getElementsByTagName('p:txStyles')[0];
    if (!txStyles) return empty;
    function parseBlock(tagName) {
      const block = txStyles.getElementsByTagName(tagName)[0];
      const levels = [];
      if (!block) return levels;
      for (let lvl = 1; lvl <= 9; lvl++) {
        const lvlEl = block.getElementsByTagName('a:lvl' + lvl + 'pPr')[0];
        const defRPr = lvlEl && lvlEl.getElementsByTagName('a:defRPr')[0];
        levels.push(getRunProps(defRPr, clrScheme)); // getRunProps already returns {} for a missing element
      }
      return levels;
    }
    return { title: parseBlock('p:titleStyle'), body: parseBlock('p:bodyStyle'), other: parseBlock('p:otherStyle') };
  }
  // Paragraph outline level (<a:pPr lvl="N">, 0-indexed) selects which
  // txStyles level applies; a missing/out-of-range level or an entirely
  // missing style block all safely resolve to {} (renderer default wins).
  function txStyleDefaultsFor(txStyles, isTitle, lvl) {
    const levels = isTitle ? txStyles.title : txStyles.body;
    return (levels && levels[lvl]) || {};
  }

  return {
    resolveOoxmlPath, dirOf, loadXml, getRelsMap, findRelByTypeSuffix,
    DEFAULT_SCHEME, parseClrScheme, resolveSchemeColor, resolveColor,
    resolveSlideInheritance, resolveOwnBackground, resolveSlideBackground,
    getXfrm, getXfrmPercent, getGroupXfrm, buildGradientCss,
    extractShapeFill, extractShapeBorder, extractGeometryCss,
    extractVerticalAnchor, extractAutofit,
    paragraphIsRtl, paragraphBulletPrefix, looksArabicLine, paragraphAlign,
    getRunProps, parseTxStyles, txStyleDefaultsFor,
  };
})();
