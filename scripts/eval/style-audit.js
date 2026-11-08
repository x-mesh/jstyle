(() => {
  const MAX_ELEMENTS = 6000;
  const SPACING_GRID_PX = 4;
  const NEAR_COLOR_DISTANCE = 12;
  const TOP_N = 15;

  const tally = () => new Map();
  const add = (map, key) => { if (key !== null && key !== undefined && key !== '') map.set(key, (map.get(key) || 0) + 1); };
  const top = (map, n = TOP_N) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
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
  const isTransparent = (c) => { const p = toRgb(c); return !p || p.a === 0; };

  const fontSizes = tally();
  const fontFamilies = tally();
  const fontWeights = tally();
  const lineHeights = tally();
  const textColors = tally();
  const backgrounds = tally();
  const radii = tally();
  const shadows = tally();
  const spacing = tally();
  const buttonHeights = tally();
  const inputHeights = tally();
  let spacingTotal = 0;
  let spacingOffScale = 0;

  const buttonSelector = 'button, [role="button"], input[type="submit"], input[type="button"], a[class*="btn"], a[class*="button"]';
  const inputSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]), select';

  // Utility-CSS sites style links as buttons with no "btn" class: a filled or bordered box with padding.
  const looksLikeButton = (el, s) => el.tagName === 'A'
    && s.display !== 'inline'
    && parseFloat(s.paddingLeft) >= 8
    && (!isTransparent(s.backgroundColor) || parseFloat(s.borderTopWidth) > 0);

  let scanned = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (scanned >= MAX_ELEMENTS) break;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
    scanned += 1;

    if (hasOwnText(el)) {
      const size = parseFloat(s.fontSize);
      add(fontSizes, `${Math.round(size * 10) / 10}px`);
      add(fontFamilies, s.fontFamily.split(',')[0].replace(/["']/g, '').trim());
      add(fontWeights, s.fontWeight);
      const lh = parseFloat(s.lineHeight);
      add(lineHeights, Number.isFinite(lh) ? (Math.round((lh / size) * 100) / 100).toString() : s.lineHeight);
      add(textColors, s.color);
    }
    if (!isTransparent(s.backgroundColor)) add(backgrounds, s.backgroundColor);
    if (s.borderRadius !== '0px') add(radii, s.borderRadius);
    if (s.boxShadow !== 'none') add(shadows, s.boxShadow);

    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) {
      const v = parseFloat(s[prop]);
      if (!Number.isFinite(v) || v <= 0) continue;
      spacingTotal += 1;
      add(spacing, `${Math.round(v)}px`);
      if (Math.round(v) % SPACING_GRID_PX !== 0) spacingOffScale += 1;
    }

    if (el.matches(buttonSelector) || looksLikeButton(el, s)) add(buttonHeights, `${Math.round(r.height)}px`);
    else if (el.matches(inputSelector)) add(inputHeights, `${Math.round(r.height)}px`);
  }

  const distinctColors = [...new Set([...textColors.keys(), ...backgrounds.keys()])];
  const nearDuplicates = [];
  for (let i = 0; i < distinctColors.length; i += 1) {
    for (let j = i + 1; j < distinctColors.length; j += 1) {
      const a = toRgb(distinctColors[i]);
      const b = toRgb(distinctColors[j]);
      if (!a || !b) continue;
      const d = Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
      if (d > 0 && d < NEAR_COLOR_DISTANCE) nearDuplicates.push([distinctColors[i], distinctColors[j]]);
    }
  }

  return JSON.stringify({
    url: location.pathname,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    elementsScanned: scanned,
    distinct: {
      fontSizes: fontSizes.size,
      fontFamilies: fontFamilies.size,
      fontWeights: fontWeights.size,
      textColors: textColors.size,
      backgrounds: backgrounds.size,
      radii: radii.size,
      shadows: shadows.size,
      buttonHeights: buttonHeights.size,
      inputHeights: inputHeights.size,
    },
    fontSizes: top(fontSizes),
    fontFamilies: top(fontFamilies, 5),
    fontWeights: top(fontWeights, 6),
    lineHeightRatios: top(lineHeights, 8),
    colors: { text: top(textColors, 10), backgrounds: top(backgrounds, 10), nearDuplicates: nearDuplicates.slice(0, 10) },
    radii: top(radii, 10),
    shadows: top(shadows, 6),
    spacing: {
      top: top(spacing, 12),
      offScaleShare: spacingTotal ? Math.round((spacingOffScale / spacingTotal) * 100) / 100 : 0,
      gridPx: SPACING_GRID_PX,
    },
    controls: { buttonHeights: top(buttonHeights, 8), inputHeights: top(inputHeights, 8) },
  }, null, 2);
})()
