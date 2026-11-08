// No `await` here: some eval harnesses re-wrap code containing `await` and drop the return value.
(() => {
  // Pinned version keeps rule IDs and impact levels stable across eval runs.
  const AXE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.0/axe.min.js';
  const MAX_INCOMPLETE = 15;
  const load = () => window.axe ? Promise.resolve() : new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = AXE_SRC;
    s.onload = resolve;
    s.onerror = () => reject(new Error('axe-core failed to load (CSP or network)'));
    document.head.appendChild(s);
  });
  const summarise = (v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    wcag: v.tags.filter((t) => /^wcag\d/.test(t)),
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    sample: v.nodes[0]?.html?.slice(0, 200),
  });
  return load()
    // `incomplete` holds checks axe could not decide (e.g. contrast over images) — they need a human look.
    .then(() => window.axe.run(document, { resultTypes: ['violations', 'incomplete'] }))
    .then((results) => {
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      const violations = results.violations.map((v) => {
        counts[v.impact] = (counts[v.impact] || 0) + 1;
        return summarise(v);
      });
      const needsReview = results.incomplete.slice(0, MAX_INCOMPLETE).map(summarise);
      return JSON.stringify({
        url: location.pathname,
        axeVersion: window.axe.version,
        counts,
        violations,
        needsReviewCount: results.incomplete.length,
        needsReview,
      }, null, 2);
    })
    .catch((e) => JSON.stringify({ error: String(e.message || e) }));
})()
