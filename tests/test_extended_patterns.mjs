import assert from "node:assert/strict";
import { test } from "node:test";
import { createChrome } from "../scripts/chrome.mjs";

const pageUrl = new URL("../assets/extended/index.html", import.meta.url).href;

test("independent patterns: inputs, recovery, focus, reflow, and reduced motion", { timeout: 60000 }, async () => {
  const browser = createChrome({ prefix: "jstyle-pattern-test-" });
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
    const key = async (value, code) => {
      const virtualKey = { Tab: 9, Escape: 27, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 }[value];
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: value, code, windowsVirtualKeyCode: virtualKey });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: value, code, windowsVirtualKeyCode: virtualKey });
    };
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: pageUrl });
    await waitFor("document.readyState === 'complete' && document.querySelector('#effects-result')?.textContent === '효과 정지됨'");
    assert.equal(await evaluate("document.querySelectorAll('#cards article').length"), 25);
    await click('[data-view="cards"]');
    await waitFor("!document.querySelector('#cards').hidden");
    await click('[data-category="state"]');
    assert.equal(await evaluate("document.querySelectorAll('#cards article:not([hidden])').length"), 3);
    await click('#pattern-search');
    await cdp('Input.insertText', {text:'존재하지않는패턴'});
    assert.equal(await evaluate("document.querySelector('#no-patterns').hidden"), false);
    await click('#reset-patterns');
    assert.equal(await evaluate("document.activeElement.id"), 'pattern-search');
    assert.equal(await evaluate("document.querySelectorAll('#cards article:not([hidden])').length"), 25);
    await click("#task-done");
    assert.equal(await evaluate("document.querySelector('#task-result').textContent"), "완료");
    await click('[name="plan"][value="팀"]');
    assert.equal(await evaluate("document.querySelector('#plan-result').textContent"), "함께 쓰기를 골랐습니다.");
    await click("#task-create");
    await click("#task-create");
    assert.equal(await evaluate("document.querySelectorAll('#new-tasks li').length"), 2);
    await click("#drawer-toggle");
    assert.equal(await evaluate("document.querySelector('#drawer-content').hidden"), false);
    await key("Tab", "Tab");
    assert.equal(await evaluate("document.activeElement.closest('#drawer-content') !== null"), true);
    await click("#drawer-toggle");
    assert.equal(await evaluate("document.querySelector('#drawer-content').hidden"), true);
    await key("Tab", "Tab");
    assert.equal(await evaluate("document.activeElement.id"), "dialog-open");
    await click("#dialog-open");
    assert.equal(await evaluate("document.querySelector('#review-dialog').open"), true);
    assert.equal(await evaluate("document.activeElement.closest('dialog')?.id"), "review-dialog");
    await key("Tab", "Tab");
    await key("Tab", "Tab");
    assert.equal(await evaluate("document.activeElement.closest('dialog')?.id"), "review-dialog");
    await key("Escape", "Escape");
    await waitFor("!document.querySelector('#review-dialog').open");
    assert.equal(await evaluate("document.activeElement.id"), "dialog-open");
    await click("#name-form button");
    assert.equal(await evaluate("document.activeElement.id"), "task-name");
    assert.equal(await evaluate("document.querySelector('#task-name').getAttribute('aria-invalid')"), "true");
    await cdp("Input.insertText", { text: "키보드 검토" });
    await click("#name-form button");
    assert.equal(await evaluate("document.querySelector('#name-result').textContent"), "작업 이름: 키보드 검토");
    assert.equal(await evaluate("document.querySelector('#name-error').hidden"), true);
    await click("#state-load");
    assert.equal(await evaluate("document.querySelector('#state-load').disabled"), true);
    await waitFor("document.querySelector('#state-result').textContent.includes('불러오지 못했습니다')");
    await click("#state-load");
    await waitFor("document.querySelector('#state-result').textContent.startsWith('불러왔습니다')");
    assert.equal(await evaluate("document.querySelector('#state').getAttribute('aria-busy')"), "false");
    await click('#files-tab');
    assert.equal(await evaluate("document.querySelector('#files-panel').hidden"), false);
    await key('Home', 'Home');
    assert.equal(await evaluate("document.activeElement.id"), 'overview-tab');
    assert.equal(await evaluate("document.querySelector('#overview-panel').hidden"), false);
    await click('#quantity-down');
    assert.equal(await evaluate("document.querySelector('#quantity-down').disabled"), true);
    for (let index = 0; index < 7; index++) await click('#quantity-up');
    assert.equal(await evaluate("document.querySelector('#quantity-value').textContent"), '8명');
    assert.equal(await evaluate("document.querySelector('#quantity-up').disabled"), true);
    await click('#assignee-search');
    await cdp('Input.insertText', {text:'서윤'});
    assert.equal(await evaluate("document.querySelectorAll('#assignee-list li:not([hidden])').length"), 1);
    await cdp('Input.insertText', {text:'없음'});
    assert.equal(await evaluate("document.querySelector('#assignee-result').textContent"), '일치하는 담당자가 없습니다.');
    await click('#review-alerts');
    assert.equal(await evaluate("document.querySelector('#preferences-result').textContent"), '살펴봐 달라는 알림을 받지 않습니다.');
    await click('#archive-task');
    assert.equal(await evaluate("document.activeElement.id"), 'undo-archive');
    await click('#undo-archive');
    assert.equal(await evaluate("document.querySelector('#archive-item').hidden"), false);
    assert.equal(await evaluate("document.activeElement.id"), 'archive-task');
    await click('.tag-choices input[value="폼"]');
    assert.equal(await evaluate("document.querySelector('#tag-result').textContent"), '탐색, 폼 · 2개 선택');
    await click('[data-view="effects"]');
    await waitFor("!document.querySelector('#effects').hidden");
    await click('button[data-effect="dots"]');
    assert.equal(await evaluate("document.querySelector('#effect-art svg circle') !== null"), true);
    await click('button[data-effect="gradient"]');
    assert.equal(await evaluate("document.querySelector('#effect-code').textContent.includes('aurora-drift')"), true);
    await click('#effect-source summary');
    await evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async () => { throw new Error('denied'); }}})");
    await click('#copy-code');
    await waitFor("document.querySelector('#copy-result').textContent.includes('복사하지 못했습니다')");
    await evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => { window.copiedCode = text; }}})");
    await click('#copy-code');
    await waitFor("document.querySelector('#copy-result').textContent.includes('복사했습니다')");
    assert.equal(await evaluate("window.copiedCode === document.querySelector('#effect-code').textContent"), true);
    for (const effect of ['trail', 'dots', 'gradient', 'spotlight', 'rings', 'beams', 'stagger', 'curtain', 'reveal']) {
      await click(`button[data-effect="${effect}"]`);
      const source = await evaluate("document.querySelector('#effect-code').textContent");
      const exported = await send('Target.createTarget', {url:'data:text/html;charset=utf-8,' + encodeURIComponent(source)});
      const attached = await send('Target.attachToTarget', {targetId:exported.targetId, flatten:true});
      try {
        const result = await send('Runtime.evaluate', {expression:`(async () => {
          if (document.readyState !== 'complete') await new Promise(resolve => window.addEventListener('load', resolve, {once:true}));
          const sample = document.querySelector('.effect-sample');
          const button = document.querySelector('#play');
          const before = getComputedStyle(sample).getPropertyValue('--play-state').trim();
          button.click();
          return {before, after:getComputedStyle(sample).getPropertyValue('--play-state').trim(), effect:sample.classList.contains('fx-${effect}')};
        })()`, returnByValue:true, awaitPromise:true}, attached.sessionId);
        assert.equal(result.exceptionDetails, undefined);
        assert.deepEqual(result.result.value, {before:'paused',after:'running',effect:true});
      } finally {
        await send('Target.closeTarget', {targetId:exported.targetId});
      }
    }
    for (const effect of ['stagger', 'curtain', 'reveal']) {
      await click(`button[data-effect="${effect}"]`);
      await click('#effects-toggle');
      const initialTransform = await evaluate("getComputedStyle(document.querySelector('.entry-complete')).transform");
      await waitFor(`getComputedStyle(document.querySelector('.entry-complete')).transform !== ${JSON.stringify(initialTransform)}`);
      await waitFor("document.querySelector('#effects-result').textContent === '시작 효과 완료'");
      assert.equal(await evaluate("document.querySelector('#play-label').textContent"), '다시 재생');
      await click('#effects-restart');
      await waitFor("document.querySelector('#effects-result').textContent === '시작 효과 완료'");
    }
    await click('button[data-effect="gradient"]');
    await click("#effects-toggle");
    assert.equal(await evaluate("document.querySelector('#effects').classList.contains('playing')"), true);
    const movingTransform = await evaluate("getComputedStyle(document.querySelector('.aurora-one')).transform");
    await waitFor(`getComputedStyle(document.querySelector('.aurora-one')).transform !== ${JSON.stringify(movingTransform)}`);
    await click('#effects-toggle');
    await waitFor("!document.querySelector('#effects').classList.contains('playing')");
    const pausedTransforms = await evaluate("(async () => { const sample = () => getComputedStyle(document.querySelector('.aurora-one')).transform; await Promise.all(document.querySelector('.effect-sample').getAnimations({subtree:true}).map(animation => animation.ready)); await new Promise(resolve => requestAnimationFrame(resolve)); const before = sample(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return [before, sample()]; })()");
    assert.equal(pausedTransforms[0], pausedTransforms[1]);
    await click('#effects-toggle');
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await waitFor("document.querySelector('#effects-result').textContent.includes('동작 감소')");
    assert.equal(await evaluate("document.querySelector('#effects').classList.contains('playing')"), false);
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.aurora-one')).animationName"), "none");
    for (const width of [1440, 720, 390, 320]) {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `Page overflow at ${width}px`);
      if (width <= 800) {
        await evaluate("(() => { const picker = document.querySelector('#effect-picker'); picker.value = 'reveal'; picker.dispatchEvent(new Event('change', {bubbles:true})); })()");
        assert.equal(await evaluate("document.querySelector('#effect-stage').dataset.effect"), 'reveal');
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.entry-complete')).animationName"), 'none');
      }
      await click('[data-view="cards"]');
      await waitFor("!document.querySelector('#cards').hidden");
      assert.equal(await evaluate("[...document.querySelectorAll('article')].every(e=>e.scrollWidth<=e.clientWidth)"), true, `Card overflow at ${width}px`);
      await click('[data-view="effects"]');
      await waitFor("!document.querySelector('#effects').hidden");
    }
    await cdp("Page.reload");
    await waitFor("document.readyState === 'complete' && document.querySelector('#effects-result')?.textContent.includes('동작 감소')");
    assert.equal(await evaluate("document.querySelector('#new-tasks').children.length"), 0);
    assert.deepEqual(exceptions, []);
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    await browser.stop(socket);
  }
});
