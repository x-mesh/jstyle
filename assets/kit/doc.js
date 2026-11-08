"use strict";
(() => {
  // Snippets are read from the live demo before kit.js runs, so they show the initial markup.
  const dedent = (text) => {
    const lines = text.replace(/^\n+|\s+$/g, "").split("\n");
    const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^ */)[0].length));
    return lines.map((line) => line.slice(indent)).join("\n");
  };
  document.querySelectorAll(".doc-example:not([data-doc-nocode])").forEach((example, index) => {
    const demo = example.querySelector(".doc-demo");
    const code = dedent(demo.innerHTML).replace(/ data-doc-[a-z-]+="[^"]*"/g, "");
    const details = document.createElement("details");
    details.className = "doc-code";
    details.innerHTML = `<summary>코드 보기</summary><div class="doc-code-body"><button type="button" class="jk-btn doc-copy">복사</button><pre><code id="doc-code-${index}"></code></pre></div>`;
    details.querySelector("code").textContent = code;
    details.querySelector(".doc-copy").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "복사됨";
      } catch {
        button.textContent = "복사 실패";
      }
      setTimeout(() => { button.textContent = "복사"; }, 1600);
    });
    example.append(details);
  });

  // Foundation boards print the live token values so the table cannot drift from kit.css.
  const luminance = (hex) => {
    const digits = hex.length === 3 ? [...hex].map((d) => d + d) : hex.match(/../g);
    const [r, g, b] = digits.map((d) => parseInt(d, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  // Black or white, whichever has the higher WCAG contrast. Mid-tone theme colors reach 4.5:1 only with pure black.
  const isLight = (value) => {
    const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hex) return true;
    const bg = luminance(hex[1]);
    return (bg + 0.05) / 0.05 >= 1.05 / (bg + 0.05);
  };
  const printTokens = () => document.querySelectorAll("[data-token]").forEach((element) => {
    const token = element.dataset.token;
    const value = getComputedStyle(element).getPropertyValue(token).trim();
    const label = element.querySelector("code") || element;
    if (element.matches(".doc-theme span")) {
      element.style.setProperty("--c", `var(${token})`);
      element.style.color = isLight(value) ? "#000" : "#fff";
      element.textContent = value;
      return;
    }
    element.style.setProperty(element.matches(".doc-sw") ? "--c" : "--v", `var(${token})`);
    label.textContent = value;
  });

  // Docs-only scheme switch. The inline <head> script applies the saved choice before the first paint.
  const schemeGroup = document.querySelector("[data-doc-scheme]");
  const systemDark = matchMedia("(prefers-color-scheme: dark)");
  const savedScheme = () => {
    try { return localStorage.getItem("jk-doc-scheme") || "system"; } catch { return "system"; }
  };
  const applyScheme = (choice) => {
    const dark = choice === "dark" || (choice === "system" && systemDark.matches);
    document.documentElement.dataset.jkScheme = dark ? "dark" : "light";
    schemeGroup.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(button.value === choice)));
    printTokens();
  };
  schemeGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button[value]");
    if (!button) return;
    try { localStorage.setItem("jk-doc-scheme", button.value); } catch { /* Private windows can block storage; the choice still applies to this visit. */ }
    applyScheme(button.value);
  });
  systemDark.addEventListener("change", () => { if (savedScheme() === "system") applyScheme("system"); });
  applyScheme(savedScheme());

  const links = [...document.querySelectorAll(".doc-nav a")];
  const sections = links.map((link) => document.querySelector(link.getAttribute("href")));
  const observer = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry) => {
      links.forEach((link, index) => link.setAttribute("aria-current", String(sections[index] === entry.target)));
    });
  }, { rootMargin: "0px 0px -70% 0px" });
  sections.forEach((section) => observer.observe(section));

  document.addEventListener("jk:change", (event) => {
    if (event.target.hasAttribute("data-doc-theme-switch")) {
      const preview = document.getElementById(event.target.getAttribute("aria-controls") || "doc-theme-preview");
      // jk:change falls back to the label when value is empty, so read the pressed button's own value.
      const theme = event.target.querySelector("[aria-pressed=true]")?.value;
      if (theme) preview.dataset.jkTheme = theme;
      else delete preview.dataset.jkTheme;
      return;
    }
    const output = event.target.closest(".doc-example")?.querySelector("[data-doc-result]");
    if (!output) return;
    const { detail } = event;
    if (event.target.dataset.jk === "pressed") output.textContent = `켜진 항목: ${detail.values.join(", ") || "없음"}`;
    else if (event.target.dataset.jk === "listbox") output.textContent = `선택: ${detail.value}`;
    else if (event.target.dataset.jkCheckall) output.textContent = `${detail.checked}개 선택됨`;
    else if (event.target.tagName === "DIALOG") output.textContent = `대화 상자 닫힘: ${detail.value || "바깥 영역"}`;
    else if (event.target.dataset.jk === "validate") output.textContent = detail.valid ? "필수 항목을 모두 채웠습니다. 실제 화면에서는 여기서 보냅니다." : `빈 필수 항목 ${detail.invalid}개로 보내지 않았습니다.`;
    else if (event.target.dataset.jk === "cycle") {
      const table = event.target.closest("table");
      document.getElementById("kit-done-count").textContent = String(table.querySelectorAll('[data-status="done"]').length);
      output.textContent = `상태를 ${detail.label}(으)로 바꿨습니다.`;
    }
  });
})();
