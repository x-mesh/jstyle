import assert from "node:assert/strict";
import { test } from "node:test";
import { createChrome } from "../scripts/chrome.mjs";

const pageUrl = new URL("../assets/kit/index.html", import.meta.url).href;

test("component kit: behaviors, keyboard, focus, and narrow reflow", { timeout: 60000 }, async () => {
  const browser = createChrome({ prefix: "jstyle-kit-test-" });
  let socket;
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  try {
    socket = new WebSocket(await browser.launch());
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const waitFor = async (expression) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.fail(`Condition not reached: ${expression}`);
    };
    const click = async (selector) => {
      const point = await evaluate(`(async () => {
        const element = document.querySelector(${JSON.stringify(selector)});
        element.scrollIntoView({block:'center'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = element.getBoundingClientRect();
        return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      })()`);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const key = async (value) => {
      const virtualKey = { ArrowRight: 39, ArrowDown: 40, End: 35, Escape: 27, Enter: 13 }[value];
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: value, code: value, windowsVirtualKeyCode: virtualKey, ...(value === "Enter" ? { text: "\r" } : {}) });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: value, code: value, windowsVirtualKeyCode: virtualKey });
    };
    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);
    const attr = (selector, name) => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute(${JSON.stringify(name)})`);

    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // A dark host (the Windows dark-theme CI job) must not switch the docs page; the dark scheme is tested explicitly.
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await cdp("Page.navigate", { url: pageUrl });
    await waitFor("document.readyState === 'complete' && window.jk && document.querySelectorAll('.doc-code').length > 0");
    assert.equal(await evaluate("document.querySelectorAll('.doc-nav a').length"), await evaluate("document.querySelectorAll('.doc-section').length"));
    assert.ok(await evaluate("document.querySelectorAll('#doc-icon-grid figure').length") > 40);
    assert.equal(await evaluate("[...document.querySelectorAll('.doc-code code')].some((code) => /data-doc-|doc-result/.test(code.textContent))"), false);

    await click("#tab-job");
    assert.equal(await attr("#tab-job", "aria-selected"), "true");
    assert.equal(await evaluate("document.querySelector('#panel-job').hidden"), false);
    assert.equal(await evaluate("document.querySelector('#panel-info').hidden"), true);
    await key("ArrowRight");
    assert.equal(await evaluate("document.activeElement.id"), "tab-docs");
    assert.equal(await evaluate("document.querySelector('#panel-docs').hidden"), false);

    await click("#kit-detail-tab-billing");
    assert.equal(await evaluate("document.querySelector('#kit-detail-panel-activity').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#kit-detail-panel-billing').hidden"), false);
    await key("ArrowLeft");
    assert.equal(await evaluate("document.activeElement.id"), "kit-detail-tab-docs");
    await click("#kit-detail-tab-activity");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.jk-detail-sheet-title')).display"), "grid");

    await click('[aria-controls="kit-acc-2"]');
    assert.equal(await evaluate("document.querySelector('#kit-acc-2').hidden"), false);
    await click('[aria-controls="kit-acc-1"]');
    assert.equal(await evaluate("document.querySelector('#kit-acc-1').hidden"), true);
    await click('[aria-controls="kit-org-2"]');
    assert.equal(await attr('[aria-controls="kit-org-2"]', "aria-expanded"), "true");
    assert.equal(await evaluate("document.querySelector('#kit-org-2').hidden"), false);
    await click('[aria-controls="kit-tree-1 kit-tree-2"]');
    assert.equal(await evaluate("['kit-tree-1', 'kit-tree-2'].every((id) => document.getElementById(id).hidden)"), true);

    await click('.jk-tokens .jk-token:nth-child(2) button');
    assert.equal(await evaluate("document.querySelectorAll('.jk-tokens .jk-token').length"), 2);
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "가입일 2024년 이후 조건 지우기");
    assert.match(await text("#kit-token-status"), /남은 조건 2개/);
    await click('.jk-tokens .jk-token:nth-child(2) button');
    await click('.jk-tokens .jk-token button');
    assert.equal(await evaluate("document.activeElement.hasAttribute('data-jk-fallback')"), true);

    const previewColors = `(() => { const p = document.getElementById('doc-theme-preview'); return [getComputedStyle(p.querySelector('.jk-btn-primary')).backgroundColor, getComputedStyle(p.querySelector('.jk-btn-primary')).color, getComputedStyle(p.querySelector('.jk-badge-done')).backgroundColor]; })()`;
    const [defaultButton, , defaultBadge] = await evaluate(previewColors);
    await click('[data-doc-theme-switch] [value="purple"]');
    assert.equal(await evaluate("document.getElementById('doc-theme-preview').dataset.jkTheme"), "purple");
    await waitFor(`${previewColors}[0] === 'rgb(145, 105, 255)'`);
    const [purpleButton, , purpleBadge] = await evaluate(previewColors);
    assert.equal(purpleButton, "rgb(145, 105, 255)");
    assert.notEqual(purpleButton, defaultButton);
    assert.equal(purpleBadge, defaultBadge);
    await click('[data-doc-theme-switch] [value="lime"]');
    assert.equal((await evaluate(previewColors))[1], "rgb(28, 42, 0)");
    await click('[data-doc-theme-switch] [value=""]');
    assert.equal(await evaluate("'jkTheme' in document.getElementById('doc-theme-preview').dataset"), false);

    await click('#menu .jk-menu [value="완료율"]');
    assert.equal(await attr('#menu .jk-menu [value="완료율"]', "aria-pressed"), "true");
    assert.equal(await text("#menu .doc-result"), "켜진 항목: 멤버, 응답, 완료율");
    await click('#lists .jk-choice-list [value="PDF 보고서"]');
    assert.equal(await evaluate("document.querySelectorAll('#lists .jk-choice-list [aria-pressed=true]').length"), 1);
    assert.equal(await attr('#lists .jk-choice-list [value="PDF 보고서"]', "aria-pressed"), "true");

    await click('#lists .jk-nav-list [role=option]');
    await key("ArrowDown");
    assert.equal(await evaluate("document.activeElement.dataset.value"), "2026년 7월 1일");
    assert.equal(await evaluate("document.querySelector('#lists .jk-nav-list [aria-selected=true]').dataset.value"), "2026년 7월 1일");

    assert.equal(await evaluate("document.querySelector('[data-jk-checkall]').indeterminate"), true);
    await click("[data-jk-checkall]");
    assert.equal(await evaluate("[...document.querySelectorAll('input[name=kit-docs]')].every((input) => input.checked)"), true);
    await click('input[name="kit-docs"]');
    assert.equal(await evaluate("document.querySelector('[data-jk-checkall]').indeterminate"), true);
    assert.equal(await text("#choices .doc-example:nth-of-type(2) .doc-result"), "2개 선택됨");

    await click("#kit-memo");
    await cdp("Input.insertText", { text: "노트북은 맥으로" });
    assert.equal(await text("#kit-memo-count"), "8 / 200");

    assert.equal(await evaluate("document.querySelector('[data-jk-bulk]').hidden"), true);
    await click('input[name="kit-tasks"]');
    await click('[data-jk-checkall="kit-tasks"]');
    assert.equal(await evaluate("document.querySelector('[data-jk-bulk]').hidden"), false);
    assert.equal(await text("[data-jk-bulk-count]"), "3");
    await click("[data-jk-bulk-clear]");
    assert.equal(await evaluate("document.querySelector('[data-jk-bulk]').hidden"), true);
    assert.equal(await evaluate("document.querySelector('[data-jk-checkall=kit-tasks]').checked"), false);

    await click('.jk-days [value="화"]');
    assert.equal(await evaluate("document.querySelectorAll('.jk-days [aria-pressed=true]').length"), 4);
    await click('.jk-month-grid [value="11월 9일"]');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.jk-month-grid [aria-pressed=true]')].map((b) => b.value)"), ["11월 9일"]);
    await click(".jk-switch input:not(:disabled)");
    assert.equal(await evaluate("document.querySelector('.jk-switch input').checked"), false);

    await click('[data-jk="dialog"]');
    assert.equal(await evaluate("document.querySelector('#kit-dialog').open"), true);
    await click('#kit-dialog [value="confirm"]');
    assert.equal(await evaluate("document.querySelector('#kit-dialog').open"), false);
    await waitFor("document.querySelector('#dialogs .doc-result').textContent === '대화 상자 닫힘: confirm'");
    assert.equal(await evaluate("document.activeElement.dataset.jk"), "dialog");
    await click('[data-jk="dialog"]');
    await key("Escape");
    assert.equal(await evaluate("document.querySelector('#kit-dialog').open"), false);

    await click('#table [data-jk="cycle"][data-status="todo"]');
    assert.equal(await evaluate("[...document.querySelectorAll('#table [data-jk=cycle]')].map((b) => b.dataset.status + ':' + b.textContent).join(',')"), "doing:진행 중,doing:진행 중,done:완료");
    await click('#table [data-jk="cycle"][data-status="done"]');
    assert.equal(await text("#table [data-jk=cycle]:nth-of-type(1)"), "진행 중");
    assert.equal(await text("#kit-done-count"), "0");

    await click('#lists [data-jk="append"] input');
    await key("Enter");
    assert.equal(await evaluate("document.querySelectorAll('#kit-templates li').length"), 2);
    await cdp("Input.insertText", { text: "분기 회고" });
    await key("Enter");
    assert.equal(await evaluate("[...document.querySelectorAll('#kit-templates li')].at(-1).textContent.trim()"), "분기 회고");
    assert.equal(await evaluate("document.querySelector('#lists [data-jk=append] input').value"), "");
    assert.match(await text("#kit-templates-status"), /모두 3개/);
    await click('#rules [data-jk="append"]');
    assert.equal(await evaluate("document.querySelectorAll('#kit-rules .jk-rule').length"), 2);
    assert.equal(await evaluate("document.activeElement.closest('#kit-rules') !== null"), true);

    await click('.jk-form-panel [type=submit]');
    assert.equal(await attr("#lay-range", "aria-invalid"), "true");
    assert.equal(await evaluate("document.getElementById('lay-range-error').hidden"), false);
    assert.equal(await evaluate("document.activeElement.id"), "lay-range");
    await evaluate("(() => { const s = document.getElementById('lay-range'); s.value = '지난 7일'; s.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.equal(await evaluate("document.getElementById('lay-range-error').hidden"), true);
    await click('.jk-form-panel [type=submit]');
    assert.match(await text("#layout .doc-result"), /모두 채웠습니다/);

    await click("#fx-trail .jk-fx-control");
    assert.equal(await attr("#fx-trail", "data-playing"), "true");
    assert.equal(await text("#fx-trail [data-jk-fx-label]"), "정지");
    assert.equal(await text("#fx-trail [data-jk-fx-icon]"), "Ⅱ");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#fx-trail .jk-fx-trail-card'), '::before').animationPlayState"), "running");
    await click("#fx-trail .jk-fx-control");
    assert.equal(await attr("#fx-trail", "data-playing"), "false");
    await click("#fx-stagger .jk-fx-control");
    assert.equal(await attr("#fx-stagger", "data-started"), "true");
    await waitFor("document.getElementById('fx-stagger').dataset.playing === 'false'");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#fx-stagger .jk-fx-entry-complete')).opacity"), "1");

    await waitFor("document.querySelector('#kit-prompt [data-jk-typing-text]').textContent.length > 0");
    await click('[data-jk="typing-toggle"]');
    assert.equal(await attr('[data-jk="typing-toggle"]', "aria-pressed"), "true");
    const phrases = (await attr("#kit-prompt", "data-jk-phrases")).split("|");
    assert.ok(phrases.includes(await text("#kit-prompt [data-jk-typing-text]")), "pausing shows the current phrase in full");
    await click('[aria-controls="kit-service-hero"] [value="orange"]');
    assert.equal(await attr("#kit-service-hero", "data-jk-theme"), "orange");

    await click("#lp-menu-button");
    assert.equal(await evaluate("document.getElementById('lp-menu').hidden"), false);
    await key("Escape");
    assert.equal(await evaluate("document.getElementById('lp-menu').hidden"), true);
    assert.equal(await evaluate("document.activeElement.id"), "lp-menu-button");
    await click("#lp-menu-button");
    await click(".jk-lp-reveal .jk-lp-title");
    assert.equal(await evaluate("document.getElementById('lp-menu').hidden"), true);

    assert.equal(await evaluate("document.getElementById('lp-faq-a2').inert"), true);
    await click("#lp-faq-q2");
    assert.equal(await evaluate("document.getElementById('lp-faq-a2').hasAttribute('data-open') && !document.getElementById('lp-faq-a2').inert"), true);

    await click("#lp-tab-team");
    assert.equal(await attr("#lp-tab-team", "aria-selected"), "true");
    assert.equal(await text("#lp-goal-count"), "목표 2개");
    await key("ArrowRight");
    assert.equal(await evaluate("document.activeElement.id"), "lp-tab-mine");
    await click('[aria-controls="lp-posts"] [data-jk-filter-value="article"]');
    assert.equal(await text("#lp-blog-count"), "글 2개");
    assert.equal(await evaluate("document.querySelectorAll('#lp-posts li:not([hidden])').length"), 2);

    assert.equal(await evaluate("getComputedStyle(document.getElementById('lp-email-error')).display"), "none");
    assert.equal(await evaluate("getComputedStyle(document.getElementById('lay-range-error')).display"), "none");
    await click("#lp-signup-form [type=submit]");
    assert.equal(await attr("#lp-email", "aria-invalid"), "true");
    await cdp("Input.insertText", { text: "name@" });
    await click("#lp-signup-form [type=submit]");
    assert.equal(await evaluate("document.getElementById('lp-email-error').hidden"), false);
    await evaluate("document.getElementById('lp-email').value = ''");
    await click("#lp-email");
    await cdp("Input.insertText", { text: "name@company.com" });
    await click("#lp-signup-form [type=submit]");
    assert.match(await text("#lp-signup-result"), /가정한 예제/);

    await evaluate("document.querySelector('[data-jk-reveal-line]').scrollIntoView({ block: 'center' })");
    await waitFor("document.querySelector('[data-jk-reveal-line]').hasAttribute('data-lit')");

    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await click("#fx-curtain .jk-fx-control");
    assert.equal(await attr("#fx-curtain", "data-playing"), "false");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('#fx-curtain .jk-fx-curtain-cover')).animationName"), "none");
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

    await evaluate("(() => { const host = document.createElement('div'); host.innerHTML = '<button type=\"button\" id=\"late\" data-jk=\"disclosure\" aria-expanded=\"false\" aria-controls=\"late-panel\">x</button><p id=\"late-panel\" hidden>y</p>'; document.querySelector('.doc-main').append(host); jk.init(host); jk.init(host); })()");
    await click("#late");
    assert.equal(await evaluate("document.querySelector('#late-panel').hidden"), false);

    assert.equal(await evaluate("document.documentElement.dataset.jkScheme"), "light");
    assert.equal(await attr('[data-doc-scheme] button[value="system"]', "aria-pressed"), "true");
    // A dark .jk region under a light page must not inherit light values through var()-based tokens.
    assert.deepEqual(await evaluate(`(() => {
      const region = document.createElement("div");
      region.className = "jk";
      region.dataset.jkScheme = "dark";
      document.querySelector(".doc-main").append(region);
      const read = (name) => getComputedStyle(region).getPropertyValue(name).trim();
      const values = [read("--jk-surface"), read("--jk-primary-text"), read("--jk-primary-tint")];
      region.remove();
      return values;
    })()`), ["#1b1c1f", "#64c563", "#233025"]);
    const surface = "getComputedStyle(document.querySelector('.doc-example')).backgroundColor";
    assert.equal(await evaluate(surface), "rgb(255, 255, 255)");
    await click('[data-doc-scheme] button[value="dark"]');
    assert.equal(await evaluate("document.documentElement.dataset.jkScheme"), "dark");
    assert.equal(await evaluate(surface), "rgb(27, 28, 31)");
    assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(15, 16, 18)");
    // Primary buttons keep white text on the same green in both schemes.
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.jk-btn-primary')).color"), "rgb(255, 255, 255)");
    await cdp("Page.reload");
    await waitFor("document.readyState === 'complete' && document.querySelectorAll('.doc-code').length > 0");
    assert.equal(await evaluate("document.documentElement.dataset.jkScheme"), "dark");
    assert.equal(await attr('[data-doc-scheme] button[value="dark"]', "aria-pressed"), "true");

    // 340px adds the margin that wider Windows Korean fonts take at 390px. Both schemes share the layout checks.
    for (const scheme of ["dark", "light"]) {
      await evaluate(`localStorage.setItem("jk-doc-scheme", "${scheme}")`);
      for (const width of [390, 340]) {
        await cdp("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
        await cdp("Page.reload");
        await waitFor("document.readyState === 'complete' && document.querySelectorAll('.doc-code').length > 0");
        assert.equal(await evaluate("document.documentElement.dataset.jkScheme"), scheme);
        assert.equal(await evaluate("document.documentElement.scrollWidth"), width);
        assert.deepEqual(await evaluate("[...document.querySelectorAll('.doc-main *')].filter((element) => element.getBoundingClientRect().right > innerWidth + 1 && !element.closest('.jk-table-wrap, .jk-grid-wrap, .jk-org-wrap, .jk-shell-nav ul, .jk-fx, .jk-lp-marquee, .jk-lp-app, .doc-code pre, .jk-tabs')).map((element) => element.className)"), [], `Overflow at ${width}px in ${scheme}`);
      }
    }

    assert.deepEqual(exceptions, []);
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    await browser.stop(socket);
  }
});
