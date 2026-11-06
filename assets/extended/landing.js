"use strict";
(() => {
  const $ = (selector) => document.querySelector(selector);
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const swatch = (name, value) => `<span class="lnd-swatch"><i style="background:${value}"></i><b>${name}</b>${value}</span>`;
  const swatchGroups = {
    "#lnd-swatch-base": [["base", "#111"], ["solid 4", "#262627"], ["solid 8", "#2f2f30"], ["solid 24", "#535354"], ["solid 48", "#89898a"], ["solid 72", "#bfbfc0"], ["block", "#f5f5f7"], ["white 72%", "rgb(255 255 255 / .72)"]],
    "#lnd-swatch-point": [["green", "#0f4"], ["lime", "#e7ff12"], ["yellow", "#ffc526"], ["orange", "#ff6523"], ["brown", "#f48200"], ["coral", "#fc8b8b"], ["pink", "#ff748e"], ["bright pink", "#ff70e0"], ["lilac", "#dc9bff"], ["purple", "#9572ff"], ["cosmic", "#5b94ff"], ["blue", "#2f82ff"], ["sky", "#12d3ff"], ["cyan", "#00ffd4"]],
    "#lnd-swatch-ui": [["ink", "#242a30"], ["text", "#3e4449"], ["sub", "#61666a"], ["hint", "#96999c"], ["disabled", "#cacccd"], ["fill", "#f6f6f7"], ["danger", "#f24b17"], ["success", "#09bb1b"]],
  };
  Object.entries(swatchGroups).forEach(([target, items]) => { $(target).innerHTML = items.map(([name, value]) => swatch(name, value)).join(""); });
  const themes = [["에이전트", "#288ffe", "#1570ef", "#afd2ff"], ["구성원", "#9169ff", "#7828ff", "#c8b4ff"], ["성장", "#c8f832", "#28d25f", "#dcffaa"], ["정산", "#f8cd2d", "#fff591", "#ffffc8"], ["비용", "#ff6432", "#f04b46", "#ffd2a5"]];
  $("#lnd-swatch-theme").innerHTML = themes.map(([name, ...colors]) => `<div class="lnd-theme-row"><span>${name}</span>${colors.map((color) => `<i style="background:${color}">${color}</i>`).join("")}</div>`).join("");
  const typeScale = [["Cover XL · 80 / 700", 80, 700, "-.03em"], ["Cover · 52 / 600", 52, 600, "-.02em"], ["Heading 1 · 48 / 700", 48, 700, "-.02em"], ["Heading 3 · 36 / 700", 36, 700, "-.02em"], ["Heading 6 · 24 / 700", 24, 700, "-.01em"], ["Sub 1 · 22 / 600", 22, 600, "-.01em"], ["Main body · 17 / 600", 17, 600, "0"], ["Body 1 · 15 / 600", 15, 600, "0"], ["Body 3 · 13.5 / 400", 13.5, 400, "0"], ["Caption · 11 / 500", 11, 500, "-.01em"]];
  $("#lnd-type-scale").innerHTML = typeScale.map(([label, size, weight, tracking]) => `<li><small>${label}</small><span style="font-size:${size}px;font-weight:${weight};letter-spacing:${tracking}">팀을 제대로 아는 작업 공간</span></li>`).join("");

  const navDemo = $(".lnd-nav-demo");
  const menuButton = $("#lnd-menu-button");
  const menu = $("#lnd-menu");
  function setMenu(open, returnFocus) {
    menu.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
    navDemo.classList.toggle("is-open", open);
    if (!open && returnFocus) menuButton.focus();
  }
  menuButton.addEventListener("click", () => setMenu(menu.hidden, false));
  navDemo.addEventListener("keydown", (event) => { if (event.key === "Escape" && !menu.hidden) setMenu(false, true); });
  document.addEventListener("click", (event) => { if (!menu.hidden && !menu.contains(event.target) && event.target !== menuButton) setMenu(false, false); });
  menu.addEventListener("focusout", (event) => { if (!navDemo.contains(event.relatedTarget)) setMenu(false, false); });

  const prompts = ["우리 팀에서 다음 분기 리더 후보를 추려 줘.", "지난달 회의에서 정한 할 일만 모아 줘.", "마감이 가장 늦어진 목표와 원인을 알려 줘."];
  const promptText = $("#lnd-prompt-text");
  const promptToggle = $("#lnd-prompt-toggle");
  let promptIndex = 0, promptLength = 0, promptDeleting = false, promptTimer = 0, promptPaused = false;
  function typePrompt() {
    const full = prompts[promptIndex];
    if (motion.matches || promptPaused) { promptText.textContent = full; return; }
    promptLength += promptDeleting ? -1 : 1;
    promptText.textContent = full.slice(0, promptLength);
    let delay = promptDeleting ? 28 : 70;
    if (!promptDeleting && promptLength === full.length) { promptDeleting = true; delay = 1800; }
    else if (promptDeleting && promptLength === 0) { promptDeleting = false; promptIndex = (promptIndex + 1) % prompts.length; delay = 400; }
    promptTimer = setTimeout(typePrompt, delay);
  }
  promptToggle.addEventListener("click", () => {
    promptPaused = !promptPaused;
    promptToggle.setAttribute("aria-pressed", String(promptPaused));
    promptToggle.textContent = promptPaused ? "입력 다시 보기" : "입력 멈추기";
    clearTimeout(promptTimer);
    if (!promptPaused) { promptLength = 0; promptDeleting = false; }
    typePrompt();
  });
  motion.addEventListener("change", () => { clearTimeout(promptTimer); typePrompt(); });
  typePrompt();

  document.querySelectorAll('[name="lnd-theme"]').forEach((radio) => radio.addEventListener("change", () => {
    $("#lnd-service-stage").dataset.lndTheme = radio.value;
    $("#lnd-theme-result").textContent = `${radio.nextElementSibling.textContent} 테마`;
  }));

  const revealLines = [...document.querySelectorAll(".lnd-reveal-line")];
  const revealObserver = new IntersectionObserver((entries) => entries.forEach((entry) => entry.target.classList.toggle("is-lit", entry.isIntersecting)), { rootMargin: "-38% 0px -38% 0px" });
  revealLines.forEach((line) => revealObserver.observe(line));

  const goalTabs = [...document.querySelectorAll(".lnd-app-tabs [role=tab]")];
  const goalRows = [...document.querySelectorAll("#lnd-goal-table tbody tr")];
  function selectGoalTab(tab) {
    goalTabs.forEach((item) => { const active = item === tab; item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1; });
    $("#lnd-goal-table").setAttribute("aria-labelledby", tab.id);
    const scope = { "lnd-tab-mine": "mine", "lnd-tab-team": "team" }[tab.id];
    goalRows.forEach((row) => { row.hidden = Boolean(scope) && row.dataset.owner !== scope; });
    $("#lnd-goal-count").textContent = `목표 ${goalRows.filter((row) => !row.hidden).length}개`;
  }
  goalTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectGoalTab(tab));
    tab.addEventListener("keydown", (event) => {
      const target = { ArrowRight: (index + 1) % goalTabs.length, ArrowLeft: (index + goalTabs.length - 1) % goalTabs.length, Home: 0, End: goalTabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      selectGoalTab(goalTabs[target]);
      goalTabs[target].focus();
    });
  });

  document.querySelectorAll(".lnd-faq-list button").forEach((button) => button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    document.getElementById(button.getAttribute("aria-controls")).classList.toggle("is-open", open);
  }));

  const chips = [...document.querySelectorAll("[data-lnd-cat]:is(button)")];
  const posts = [...document.querySelectorAll(".lnd-posts li")];
  chips.forEach((chip) => chip.addEventListener("click", () => {
    const category = chip.dataset.lndCat;
    chips.forEach((item) => item.setAttribute("aria-pressed", String(item === chip)));
    posts.forEach((post) => { post.hidden = category !== "all" && post.dataset.lndCat !== category; });
    $("#lnd-blog-count").textContent = `글 ${posts.filter((post) => !post.hidden).length}개`;
  }));

  $("#lnd-signup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#lnd-email");
    const value = input.value.trim();
    const message = !value ? "회사 이메일을 입력해 주세요." : !input.checkValidity() ? "이메일 형식을 확인해 주세요. 예: name@company.com" : "";
    $("#lnd-email-error").textContent = message;
    $("#lnd-email-error").hidden = !message;
    input.setAttribute("aria-invalid", String(Boolean(message)));
    $("#lnd-signup-result").textContent = message ? "" : `${value}로 체험 안내를 보냈다고 가정한 예제입니다. 실제로 전송하지 않습니다.`;
    if (message) input.focus();
  });
})();
