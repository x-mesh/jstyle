(() => {
  const CANDIDATES = 8;
  const viewportMeta = document.querySelector('meta[name="viewport"]')?.content ?? '';
  const deviceWidthLayout = matchMedia('(pointer: coarse)').matches && /width\s*=\s*device-width/.test(viewportMeta);
  const vw = deviceWidthLayout ? Math.min(window.innerWidth, screen.width) : window.innerWidth;
  // When overflow widens a phone's layout viewport the page is zoomed out; scale the fold back to the device's screen.
  const zoomOut = window.innerWidth / vw;
  const fold = Math.round(window.innerHeight / zoomOut);
  const scrollY = window.scrollY;

  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '');
  };
  const visible = (r, s) => r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  // Computed colours can be oklch()/lab()/color(); painting one pixel normalises any CSS colour to RGBA.
  const colorCanvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgbCache = new Map();
  const toRgb = (c) => {
    if (rgbCache.has(c)) return rgbCache.get(c);
    let out = null;
    const m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      out = { r, g, b, a };
    } else if (colorCanvas) {
      colorCanvas.clearRect(0, 0, 1, 1);
      colorCanvas.fillStyle = 'rgba(0, 0, 0, 0)';
      colorCanvas.fillStyle = c;
      colorCanvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCanvas.getImageData(0, 0, 1, 1).data;
      out = { r, g, b, a: a / 255 };
    }
    rgbCache.set(c, out);
    return out;
  };
  const filled = (c) => { const p = toRgb(c); return Boolean(p) && p.a > 0; };
  const pinned = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };

  // Prominence approximates "what the eye lands on": filled, large, near the top. The evaluator picks the real primary CTA.
  const actions = [];
  for (const el of document.querySelectorAll('a[href], button, [role="button"], input[type="submit"]')) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (!visible(r, s)) continue;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!label) continue;
    const top = Math.round(r.top + scrollY);
    const isFilled = filled(s.backgroundColor);
    const prominence = (isFilled ? 2 : 0) + Math.min(r.width * r.height / 4000, 3) + (top < fold ? 1 : 0) + (parseFloat(s.fontWeight) >= 600 ? 0.5 : 0);
    actions.push({
      el: describe(el),
      label,
      top,
      bottom: Math.round(r.bottom + scrollY),
      inFold: r.top + scrollY >= 0 && r.bottom + scrollY <= fold,
      pinned: pinned(el),
      filled: isFilled,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      prominence: Math.round(prominence * 10) / 10,
    });
  }
  actions.sort((a, b) => b.prominence - a.prominence);

  const headings = [...document.querySelectorAll('h1, h2')]
    .map((h) => ({ tag: h.tagName.toLowerCase(), text: h.innerText.trim().slice(0, 80), top: Math.round(h.getBoundingClientRect().top + scrollY) }))
    .filter((h) => h.text);

  let foldTextChars = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent) continue;
    const r = parent.getBoundingClientRect();
    if (r.top + scrollY < fold && r.bottom > 0 && getComputedStyle(parent).visibility !== 'hidden') foldTextChars += n.textContent.trim().length;
  }

  const filledActionsInFold = actions.filter((a) => a.inFold && a.filled).length;

  return JSON.stringify({
    url: location.pathname,
    viewport: `${vw}x${fold}`,
    layoutViewportExpanded: zoomOut > 1 ? window.innerWidth : 0,
    scrolledFromTop: scrollY > 0,
    fold,
    pageHeight: document.documentElement.scrollHeight,
    screensTall: Math.round((document.documentElement.scrollHeight / fold) * 10) / 10,
    h1: headings.filter((h) => h.tag === 'h1'),
    headingsInFold: headings.filter((h) => h.top < fold).slice(0, 5),
    foldTextChars,
    filledActionsInFold,
    actionCandidates: actions.slice(0, CANDIDATES),
  }, null, 2);
})()
