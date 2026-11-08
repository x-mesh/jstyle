(() => {
  const MIN_TARGET_AA = 24;
  const MIN_TARGET_PLATFORM = 44;
  const MIN_FONT_PX = 12;
  const COLLAPSED_MAIN_PX = 200;
  const MOBILE_MAX_PX = 768;

  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '');
  };
  const root = document.documentElement;
  const viewportMeta = document.querySelector('meta[name="viewport"]')?.content ?? null;
  // Mobile browsers widen the layout viewport to fit overflowing content, so innerWidth stops meaning
  // "the phone's width". With width=device-width on a touch device, the screen width is the intended one.
  const deviceWidthLayout = matchMedia('(pointer: coarse)').matches && /width\s*=\s*device-width/.test(viewportMeta || '');
  const vw = deviceWidthLayout ? Math.min(window.innerWidth, screen.width) : window.innerWidth;
  const layoutViewportExpanded = window.innerWidth > vw ? window.innerWidth : 0;
  const pageOverflow = Math.max(root.scrollWidth, window.innerWidth) - vw;
  const clipsX = (style) => style.overflowX !== 'visible';
  const rootClips = clipsX(getComputedStyle(root)) || clipsX(getComputedStyle(document.body));

  // Elements inside a carousel or any horizontal scroll/clip container are off-screen by design.
  const containerCache = new Map();
  const insideClippingContainer = (el) => {
    const chain = [];
    let node = el.parentElement;
    let result = false;
    while (node && node !== document.body && node !== root) {
      if (containerCache.has(node)) { result = containerCache.get(node); break; }
      chain.push(node);
      if (clipsX(getComputedStyle(node))) { result = true; break; }
      node = node.parentElement;
    }
    for (const n of chain) containerCache.set(n, result);
    return result;
  };

  // WCAG 2.5.8 exempts links that sit inside a run of text.
  const isInlineTextLink = (el, style) => {
    if (el.tagName !== 'A' || !style.display.startsWith('inline') || style.display === 'inline-block') return false;
    const parent = el.parentElement;
    if (!parent) return false;
    const ownText = (el.innerText || '').trim().length;
    return (parent.innerText || '').trim().length > ownText + 20;
  };

  const offscreen = [];
  const clippedByRoot = [];
  const verticalStacks = [];
  const targets = [];
  const textOverflow = [];
  const hiddenScroll = [];
  const tinyText = [];
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;

    if (r.right > vw + 1 && style.position !== 'fixed' && !insideClippingContainer(el)) {
      const entry = { el: describe(el), right: Math.round(r.right), vw };
      (rootClips ? clippedByRoot : offscreen).push(entry);
    }

    const text = (el.innerText || '').trim();
    if (text.length >= 5 && r.width < 30 && r.height > r.width * 3 && el.children.length === 0) {
      verticalStacks.push({ el: describe(el), width: Math.round(r.width), height: Math.round(r.height), text: text.slice(0, 30) });
    }

    const interactive = el.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link]');
    if (interactive && vw < MOBILE_MAX_PX && !isInlineTextLink(el, style)) {
      targets.push({ el, r, label: (text || el.getAttribute('aria-label') || '').slice(0, 30) });
    }

    const scrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';
    if (scrollable && el.scrollWidth > el.clientWidth + 1) {
      hiddenScroll.push({ el: describe(el), boxWidth: el.clientWidth, contentWidth: el.scrollWidth, hiddenPx: el.scrollWidth - el.clientWidth });
    }
    if (hasOwnText(el) && !scrollable && style.textOverflow !== 'ellipsis' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      textOverflow.push({
        el: describe(el),
        boxWidth: el.clientWidth,
        textWidth: el.scrollWidth,
        clipped: style.overflowX !== 'visible',
        pastViewport: Math.round(r.left + el.scrollWidth) > vw,
        text: text.slice(0, 30),
      });
    }

    if (el.children.length === 0 && text.length > 0 && parseFloat(style.fontSize) < MIN_FONT_PX) {
      tinyText.push({ el: describe(el), fontSize: style.fontSize, text: text.slice(0, 30) });
    }
  }

  // WCAG 2.5.8 spacing exception: an undersized target passes if a 24 px circle on its centre
  // touches no other target and no other undersized target's circle.
  const SPACING_RADIUS = MIN_TARGET_AA / 2;
  const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const distanceToRect = (pt, r) => Math.hypot(Math.max(r.left - pt.x, 0, pt.x - r.right), Math.max(r.top - pt.y, 0, pt.y - r.bottom));
  const undersized = (t) => t.r.width < MIN_TARGET_AA || t.r.height < MIN_TARGET_AA;
  const related = (a, b) => a.el.contains(b.el) || b.el.contains(a.el);
  const passesBySpacing = (t) => {
    const c = centre(t.r);
    return targets.every((o) => {
      if (o === t || related(o, t)) return true;
      if (undersized(o)) { const oc = centre(o.r); return Math.hypot(c.x - oc.x, c.y - oc.y) >= MIN_TARGET_AA; }
      return distanceToRect(c, o.r) >= SPACING_RADIUS;
    });
  };
  const tinyTargets = [];
  let spacedOk = 0;
  for (const t of targets) {
    if (t.r.width >= MIN_TARGET_PLATFORM && t.r.height >= MIN_TARGET_PLATFORM) continue;
    let level = 'below-44';
    if (undersized(t)) {
      if (passesBySpacing(t)) { spacedOk += 1; continue; }
      level = 'below-24-AA';
    }
    tinyTargets.push({ el: describe(t.el), w: Math.round(t.r.width), h: Math.round(t.r.height), level, label: t.label });
  }

  const landmark = document.querySelector('main, [role="main"]');
  const fallbackMain = () => {
    const candidates = [...document.querySelectorAll('article, #main, #content, .main, .content, [class*="content"]')];
    return candidates.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0] || null;
  };
  const mainEl = landmark || fallbackMain();
  const mainWidth = mainEl ? Math.round(mainEl.getBoundingClientRect().width) : null;
  const collapsedMain = mainEl && vw >= MOBILE_MAX_PX && mainWidth > 0 && mainWidth < COLLAPSED_MAIN_PX
    ? [{ el: describe(mainEl), width: mainWidth }]
    : [];

  return JSON.stringify({
    viewport: `${vw}x${Math.round(window.innerHeight * vw / window.innerWidth)}`,
    layoutViewportExpanded,
    media: {
      pointerCoarse: matchMedia('(pointer: coarse)').matches,
      hoverNone: matchMedia('(hover: none)').matches,
      darkScheme: matchMedia('(prefers-color-scheme: dark)').matches,
      dpr: window.devicePixelRatio,
    },
    viewportMeta,
    zoomBlocked: viewportMeta ? /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(viewportMeta) : false,
    horizontalPageScroll: pageOverflow > 1 ? pageOverflow : 0,
    rootClipsOverflowX: rootClips,
    clippedByRoot: clippedByRoot.slice(0, 15),
    clippedByRootCount: clippedByRoot.length,
    offscreen: offscreen.slice(0, 15),
    verticalTextStacks: verticalStacks.slice(0, 15),
    mainLandmark: landmark ? describe(landmark) : null,
    mainCandidate: mainEl ? describe(mainEl) : null,
    collapsedMain,
    tinyTouchTargets: tinyTargets.slice(0, 20),
    tinyTouchTargetCount: tinyTargets.length,
    tinyTouchTargetsBelowAA: tinyTargets.filter((t) => t.level === 'below-24-AA').length,
    undersizedButSpaced: spacedOk,
    textOverflow: textOverflow.slice(0, 15),
    textOverflowCount: textOverflow.length,
    horizontalScrollBoxes: hiddenScroll.slice(0, 10),
    tinyText: tinyText.slice(0, 10),
  }, null, 2);
})()
