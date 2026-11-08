(() => {
  const GENERIC_SUBMIT = /^(submit|send|ok|go|continue|next|confirm|확인|전송|제출|보내기|다음|계속)$/i;
  const REQUIRED_MARK = /\*|required|필수|\(req/i;
  const HINTS = [
    { kind: 'email', re: /e-?mail|이메일/i, types: ['email'], autocomplete: 'email' },
    { kind: 'tel', re: /phone|tel|mobile|휴대폰|전화|연락처/i, types: ['tel'], autocomplete: 'tel' },
    { kind: 'postal', re: /zip|postal|postcode|우편/i, types: ['text', 'tel'], inputmode: 'numeric', autocomplete: 'postal-code' },
    { kind: 'name', re: /(^|[^a-z])(full.?name|first.?name|last.?name|given|family|name)([^a-z]|$)|이름|성명/i, types: ['text'], autocomplete: 'name' },
    { kind: 'address', re: /address|street|주소/i, types: ['text'], autocomplete: 'street-address' },
    { kind: 'card', re: /card|cc-?num|카드/i, types: ['text', 'tel'], inputmode: 'numeric', autocomplete: 'cc-number' },
    { kind: 'number', re: /qty|quantity|amount|age|count|수량|금액|나이/i, types: ['number', 'tel'], inputmode: 'numeric' },
  ];

  const describe = (el) => el.tagName.toLowerCase() + (el.name ? `[name="${el.name}"]` : '') + (el.id ? `#${el.id}` : '');
  const text = (el) => (el?.innerText || el?.textContent || '').trim().replace(/\s+/g, ' ');
  const labelText = (el) => {
    const fromLabels = [...(el.labels || [])].map(text).join(' ');
    const fromAria = el.getAttribute('aria-label') || '';
    const fromLabelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => text(document.getElementById(id))).join(' ');
    return [fromLabels, fromAria, fromLabelledBy, el.title || ''].join(' ').trim();
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden'; };

  const fieldSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';
  const groups = new Map();
  for (const field of document.querySelectorAll(fieldSelector)) {
    if (!visible(field)) continue;
    const form = field.form || field.closest('form') || null;
    if (!groups.has(form)) groups.set(form, []);
    groups.get(form).push(field);
  }

  const forms = [...groups.entries()].map(([form, fields]) => {
    const unlabeled = [];
    const placeholderOnly = [];
    const typeMismatch = [];
    const missingAutocomplete = [];
    const requiredUnmarked = [];

    for (const f of fields) {
      const label = labelText(f);
      const placeholder = f.getAttribute('placeholder') || '';
      if (!label && placeholder) placeholderOnly.push({ field: describe(f), placeholder: placeholder.slice(0, 40) });
      else if (!label && !['checkbox', 'radio'].includes(f.type)) unlabeled.push(describe(f));

      const haystack = [f.name, f.id, f.getAttribute('autocomplete'), label, placeholder].join(' ');
      const hint = HINTS.find((h) => h.re.test(haystack));
      if (hint && f.tagName === 'INPUT') {
        const typeOk = hint.types.includes(f.type);
        const modeOk = !hint.inputmode || f.inputMode === hint.inputmode || f.type === 'number' || f.type === 'tel';
        if (!typeOk || !modeOk) typeMismatch.push({ field: describe(f), looksLike: hint.kind, type: f.type, inputmode: f.inputMode || null });
        const ac = (f.getAttribute('autocomplete') || '').trim();
        if (hint.autocomplete && (!ac || ac === 'off')) missingAutocomplete.push({ field: describe(f), suggest: hint.autocomplete });
      }

      const required = f.required || f.getAttribute('aria-required') === 'true';
      if (required && !REQUIRED_MARK.test(label + ' ' + placeholder)) requiredUnmarked.push(describe(f));
    }

    // Without a <form> there is no reliable way to tell which page button submits these fields.
    const submits = !form ? [] : [...form.querySelectorAll('button:not([type="button"]):not([type="reset"]), input[type="submit"]')]
      .filter(visible)
      .map((b) => (b.innerText || b.value || '').trim());
    return {
      form: form ? (form.getAttribute('action') || form.id || form.getAttribute('name') || 'form') : '(no <form>)',
      method: form ? (form.getAttribute('method') || 'get').toLowerCase() : null,
      fieldCount: fields.length,
      requiredCount: fields.filter((f) => f.required || f.getAttribute('aria-required') === 'true').length,
      submitLabels: submits.slice(0, 3),
      genericSubmit: submits.filter((s) => GENERIC_SUBMIT.test(s)),
      unlabeled,
      placeholderOnly,
      typeMismatch,
      missingAutocomplete,
      requiredUnmarked,
    };
  });

  return JSON.stringify({ url: location.pathname, formCount: forms.length, forms }, null, 2);
})()
