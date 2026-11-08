(() => new Promise((resolve) => {
  const describe = (el) => {
    if (!el || !el.tagName) return null;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '');
  };

  let lcp = 0;
  let lcpElement = null;
  let inp = 0;
  let interactions = 0;

  // web-vitals CLS: shifts are grouped into windows (gap < 1 s, span < 5 s) and the worst window counts.
  const SESSION_GAP_MS = 1000;
  const SESSION_SPAN_MS = 5000;
  let cls = 0;
  let windowValue = 0;
  let windowStart = 0;
  let lastShift = 0;

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      lcp = e.startTime;
      lcpElement = describe(e.element) || (e.url ? e.url.slice(0, 120) : null);
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      const startsNewWindow = windowValue === 0
        || e.startTime - lastShift > SESSION_GAP_MS
        || e.startTime - windowStart > SESSION_SPAN_MS;
      if (startsNewWindow) {
        windowValue = e.value;
        windowStart = e.startTime;
      } else {
        windowValue += e.value;
      }
      lastShift = e.startTime;
      cls = Math.max(cls, windowValue);
    }
  }).observe({ type: 'layout-shift', buffered: true });

  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.interactionId) continue;
      interactions += 1;
      inp = Math.max(inp, e.duration);
    }
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 });

  // Event timing hides interactions faster than 16 ms; first-input is always recorded, so it tells
  // "fast" apart from "no interaction happened".
  let firstInput = null;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) firstInput = { type: e.name, durationMs: Math.round(e.duration) };
  }).observe({ type: 'first-input', buffered: true });

  const EVENT_THRESHOLD_MS = 16;
  const inpStatus = () => {
    if (inp) return 'measured';
    if (!firstInput) return 'no interaction';
    return firstInput.durationMs < EVENT_THRESHOLD_MS ? 'fast (< 16 ms)' : 'first input only';
  };

  // LCP and CLS entries keep arriving shortly after load; 1.5s lets them settle.
  setTimeout(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    // web-vitals TTFB counts from navigation start (redirects, DNS, TLS included), minus prerender activation.
    const ttfb = nav ? Math.max(0, nav.responseStart - (nav.activationStart || 0)) : null;
    resolve(JSON.stringify({
      url: location.pathname,
      lcpMs: Math.round(lcp),
      lcpElement,
      cls: Math.round(cls * 1000) / 1000,
      inpMs: inp ? Math.round(inp) : (firstInput ? firstInput.durationMs : null),
      inpStatus: inpStatus(),
      firstInput,
      interactionsSeen: interactions,
      ttfbMs: ttfb === null ? null : Math.round(ttfb),
      redirectMs: nav ? Math.round(nav.redirectEnd - nav.redirectStart) : null,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav ? Math.round(nav.loadEventEnd) : null,
      requests: resources.length,
      transferKB: Math.round(resources.reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024),
    }, null, 2));
  }, 1500);
}))()
