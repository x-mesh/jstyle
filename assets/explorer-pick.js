(() => {
  "use strict";
  // Element picker for jstyle explorer candidates. It runs inside a sandboxed
  // preview frame and stays idle until the explorer turns it on. Element
  // lookup and the summary format follow frame-mesh (src/core/engine.js
  // chatSelection, src/core/handoff.js elementPath) so an agent reads the same
  // shape from both tools.
  if (window.parent === window) return;
  const UNIT_TAGS = new Set(["li", "button", "img", "a", "input", "select", "textarea", "table", "tr", "td", "th", "figure", "video", "audio", "canvas", "svg", "iframe", "header", "footer", "nav", "main", "section", "article", "aside", "form", "fieldset", "details", "summary", "dialog", "ul", "ol", "dl", "blockquote", "pre", "hr"]);
  const REPLACED_TAGS = new Set(["img", "input", "button", "select", "textarea", "video", "audio", "canvas", "svg", "iframe", "object", "embed", "picture"]);
  const STYLE_KEYS = ["display", "width", "height", "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-bottom", "gap", "font-size", "font-weight", "line-height", "color", "background-color", "border-radius"];
  const TEXT_LEN = 400;
  const CHILDREN_MAX = 10;
  const MASK_MIN_SIZE = 24;
  const MASK_COVER_RATIO = 0.8;
  const UI = "data-jstyle-ui";
  const ACCENT = "#0d99ff";
  const SWALLOWED = ["mousedown", "mouseup", "auxclick", "dblclick", "submit", "touchstart", "touchend"];
  let on = false;
  let hover = null;
  let marks = [];
  let lastMarks = [];
  // The explorer shows this frame scaled down; outlines and labels grow by 1/scale so they stay readable.
  let scale = 1;
  const px = (value) => `${value / scale}px`;

  const post = (message) => window.parent.postMessage({ jstyle: "pick", ...message }, "*");
  // Same limits as jstyle serve, so one long id or a deep tree does not get the whole send refused.
  const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
  const clipPath = (text) => (text.length > 2000 ? `… ${text.slice(text.length - 1997)}` : text);

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const classes = Array.from(el.classList).slice(0, 2).map((name) => `.${name}`).join("");
    return clip(`${tag}${id}${classes}`, 300);
  }

  function elementPath(el) {
    const parts = [];
    for (let cur = el; cur && cur.tagName && cur.tagName.toLowerCase() !== "html"; cur = cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${tag}#${cur.id}`);
        break;
      }
      const parent = cur.parentElement;
      const same = parent ? Array.from(parent.children).filter((child) => child.tagName === cur.tagName) : [cur];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
    }
    return parts.join(" > ");
  }

  function hasVisibleBox(el) {
    const cs = getComputedStyle(el);
    const bg = cs.backgroundColor;
    const alpha = bg.startsWith("rgba") ? parseFloat(bg.slice(bg.lastIndexOf(",") + 1)) : 1;
    if (bg !== "transparent" && alpha > 0) return true;
    if (cs.backgroundImage !== "none" || cs.boxShadow !== "none") return true;
    return ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].some((key) => parseFloat(cs[key]) > 0);
  }

  const isUnit = (el) => el === document.body || UNIT_TAGS.has(el.tagName.toLowerCase()) || hasVisibleBox(el);

  // An empty absolute box that covers its parent, such as a link overlay, is passed through.
  function isMaskLike(el) {
    if (el === document.body || REPLACED_TAGS.has(el.tagName.toLowerCase())) return false;
    if (el.children.length || el.textContent.trim()) return false;
    const cs = getComputedStyle(el);
    if (cs.position !== "absolute" && cs.position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    if (r.width < MASK_MIN_SIZE || r.height < MASK_MIN_SIZE) return false;
    const ref = el.offsetParent || el.parentElement;
    if (!ref) return false;
    const rr = ref.getBoundingClientRect();
    return r.width >= rr.width * MASK_COVER_RATIO && r.height >= rr.height * MASK_COVER_RATIO;
  }

  function unitAt(x, y) {
    const hit = document.elementsFromPoint(x, y).find((node) => node.nodeType === 1 && document.body.contains(node) && !node.closest(`[${UI}]`) && !isMaskLike(node));
    for (let cur = hit; cur; cur = cur.parentElement) if (isUnit(cur)) return cur;
    return hit ?? null;
  }

  function childOutline(el) {
    const kids = [...el.children].filter((child) => !child.hasAttribute(UI) && child.tagName !== "SCRIPT" && child.tagName !== "STYLE");
    if (!kids.length) return undefined;
    const lines = kids.slice(0, CHILDREN_MAX).map((child) => {
      if (!child.checkVisibility()) return clip(`${describe(child)} (hidden)`, 300);
      const r = child.getBoundingClientRect();
      return clip(`${describe(child)} ${Math.round(r.width)}x${Math.round(r.height)} ${getComputedStyle(child).display}`, 300);
    });
    if (kids.length > CHILDREN_MAX) lines.push(`+${kids.length - CHILDREN_MAX}`);
    return lines;
  }

  function summary(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      label: describe(el),
      path: clipPath(elementPath(el)),
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      text: (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, TEXT_LEN) || undefined,
      parent: el.parentElement && el.parentElement !== document.documentElement ? { label: describe(el.parentElement), path: clipPath(elementPath(el.parentElement)) } : null,
      styles: Object.fromEntries(STYLE_KEYS.map((key) => [key, cs.getPropertyValue(key)])),
      children: childOutline(el),
    };
  }

  function tag(text, color) {
    const node = document.createElement("span");
    node.textContent = text;
    node.style.cssText = `position:absolute;left:${px(-2)};top:${px(-20)};padding:${px(1)} ${px(6)};border-radius:${px(3)};background:${color};color:#fff;font:600 ${px(11)}/${px(16)} ui-monospace,Menlo,Consolas,monospace;white-space:nowrap`;
    return node;
  }

  function box(color, label) {
    const node = document.createElement("div");
    node.setAttribute(UI, "");
    node.style.cssText = `position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;border:${px(2)} solid ${color};border-radius:${px(2)};background:${color}14`;
    if (label) node.append(tag(label, color));
    document.documentElement.append(node);
    return node;
  }

  function place(node, el) {
    const r = el.getBoundingClientRect();
    Object.assign(node.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }

  function find(path) {
    try {
      return document.querySelector(path);
    } catch {
      return null;
    }
  }

  function drawMarks(items) {
    marks.forEach((mark) => mark.node.remove());
    marks = [];
    for (const item of items) {
      const el = find(item.path);
      if (el) marks.push({ el, node: box("#7c3aed", String(item.n)) });
    }
    marks.forEach((mark) => place(mark.node, mark.el));
  }

  function setHover(el) {
    if (!el) {
      hover?.node.remove();
      hover = null;
      return;
    }
    if (hover?.el === el) return;
    hover?.node.remove();
    hover = { node: box(ACCENT, describe(el)), el };
    place(hover.node, el);
  }

  function setOn(value) {
    on = value;
    document.documentElement.style.cursor = on ? "crosshair" : "";
    if (!on) setHover(null);
  }

  const swallow = (event) => {
    if (!on) return;
    event.preventDefault();
    event.stopPropagation();
  };
  SWALLOWED.forEach((type) => addEventListener(type, swallow, true));
  addEventListener("pointermove", (event) => {
    if (on) setHover(unitAt(event.clientX, event.clientY));
  }, true);
  addEventListener("click", (event) => {
    if (!on) return;
    swallow(event);
    const el = unitAt(event.clientX, event.clientY);
    if (!el) return;
    // The explorer keeps comment mode on and anchors its note bubble to this box.
    const r = el.getBoundingClientRect();
    post({ type: "picked", element: summary(el), rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
  }, true);
  // A srcdoc document resolves "#..." against the explorer's own address, so following such a link
  // loads the explorer inside this frame; a <base href="about:srcdoc"> does not help, because Chrome
  // still loads the document again. The navigation is stopped and replayed as a fragment move within
  // about:srcdoc, unless the candidate cancels the click. The decision waits for the bubble phase so
  // that every way of cancelling (preventDefault, an inline "return false") is already applied.
  const fragmentOf = (event) => {
    // The path, not event.target, so that a link inside a shadow root is found too.
    const link = event.composedPath().find((node) => node instanceof Element && node.matches("a[href]"));
    const href = link?.getAttribute("href");
    return href?.startsWith("#") ? href : null;
  };
  const held = new WeakSet();
  function hold(event, href) {
    if (held.has(event) || event.defaultPrevented) return;
    held.add(event);
    const cancel = Event.prototype.preventDefault;
    let cancelled = false;
    // Listeners that run after this point still see their own cancel, which decides the replay.
    Object.defineProperty(event, "preventDefault", { value: () => { cancelled = true; } });
    Object.defineProperty(event, "defaultPrevented", { get: () => cancelled });
    Object.defineProperty(event, "returnValue", { get: () => !cancelled, set: (value) => { if (!value) cancelled = true; } });
    cancel.call(event);
    setTimeout(() => {
      if (cancelled) return;
      location.hash = href.slice(1);
      if (href === "#") scrollTo(0, 0);
    });
  }
  addEventListener("click", (event) => {
    const href = !on && fragmentOf(event);
    if (!href) return;
    // A candidate that stops the click keeps it from reaching the bubble listener below.
    for (const name of ["stopPropagation", "stopImmediatePropagation"]) {
      const stop = event[name];
      Object.defineProperty(event, name, { value: () => { stop.call(event); hold(event, href); } });
    }
    const bubble = Object.getOwnPropertyDescriptor(Event.prototype, "cancelBubble");
    Object.defineProperty(event, "cancelBubble", {
      get: () => bubble.get.call(event),
      set: (value) => {
        bubble.set.call(event, value);
        if (value) hold(event, href);
      },
    });
  }, true);
  addEventListener("click", (event) => {
    const href = !on && fragmentOf(event);
    if (href) hold(event, href);
  });
  addEventListener("keydown", (event) => {
    if (!on || event.key !== "Escape") return;
    swallow(event);
    post({ type: "cancel" });
  }, true);
  // While commenting, this frame takes the pointer, so board zoom gestures are handed to the explorer.
  addEventListener("wheel", (event) => {
    if (!on || !(event.shiftKey || event.ctrlKey)) return;
    event.preventDefault();
    post({ type: "wheel", dx: event.deltaX, dy: event.deltaY, ctrl: event.ctrlKey, x: event.clientX, y: event.clientY });
  }, { passive: false });
  const replace = () => {
    marks.forEach((mark) => place(mark.node, mark.el));
    if (hover) place(hover.node, hover.el);
  };
  addEventListener("scroll", replace, { capture: true, passive: true });
  addEventListener("resize", replace, { passive: true });
  addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.jstyle !== "explorer") return;
    if (event.data.type === "pick") setOn(Boolean(event.data.on));
    else if (event.data.type === "marks" && Array.isArray(event.data.items)) {
      lastMarks = event.data.items.filter((item) => typeof item?.path === "string");
      drawMarks(lastMarks);
    } else if (event.data.type === "scale" && event.data.k > 0 && event.data.k !== scale) {
      scale = event.data.k;
      drawMarks(lastMarks);
      if (hover) {
        const el = hover.el;
        setHover(null);
        setHover(el);
      }
    }
  });
  post({ type: "ready" });
})();
