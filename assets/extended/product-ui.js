"use strict";
(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const icon = (name, className = "") => `<svg class="pui-i ${className}" aria-hidden="true"><use href="#${name}"/></svg>`;

  const profileTabs = $$(".pui-tabs [role=tab]");
  const profilePanels = $$("#pui-profile [role=tabpanel]");
  function selectProfileTab(tab) {
    const panelId = tab.getAttribute("aria-controls");
    profileTabs.forEach((item) => { const active = item === tab; item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1; });
    profilePanels.forEach((panel) => { panel.hidden = panel.id !== panelId; });
    document.getElementById(panelId).setAttribute("aria-labelledby", tab.id);
  }
  profileTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectProfileTab(tab));
    tab.addEventListener("keydown", (event) => {
      const target = { ArrowRight: (index + 1) % profileTabs.length, ArrowLeft: (index + profileTabs.length - 1) % profileTabs.length, Home: 0, End: profileTabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      selectProfileTab(profileTabs[target]);
      profileTabs[target].focus();
    });
  });

  $$(".pui-count").forEach((button) => button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    document.getElementById(button.getAttribute("aria-controls")).hidden = !open;
    const name = button.parentElement.querySelector("strong").textContent;
    $("#pui-org-result").textContent = `${name} 하위 조직을 ${open ? "펼쳤습니다" : "접었습니다"}.`;
  }));
  $$(".pui-org-tools button").forEach((button) => button.addEventListener("click", () => {
    $$(".pui-org-tools button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  }));

  $$(".pui-metric-menu button").forEach((button) => button.addEventListener("click", () => {
    const on = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(on));
    $$(`#pui-org-cards [data-metric="${button.dataset.metric}"]`).forEach((chip) => { chip.hidden = !on; });
  }));

  const historyItems = $$(".pui-history-list [role=option]");
  function selectHistory(item) {
    historyItems.forEach((option) => { const active = option === item; option.setAttribute("aria-selected", String(active)); option.tabIndex = active ? 0 : -1; });
    $("#pui-history-heading").textContent = `${item.dataset.date} 조직도`;
    $("#pui-history-count").textContent = item.dataset.count;
    $("#pui-history-note").textContent = item.dataset.note;
    $("#pui-history-meta-date").textContent = item.dataset.date.replace(/년 |월 /g, ". ").replace("일", "");
  }
  historyItems.forEach((item, index) => {
    item.addEventListener("click", () => selectHistory(item));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectHistory(item); return; }
      const target = { ArrowDown: Math.min(index + 1, historyItems.length - 1), ArrowUp: Math.max(index - 1, 0) }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      selectHistory(historyItems[target]);
      historyItems[target].focus();
    });
  });

  const countView = () => {
    const count = $$("#pui-tokens .pui-token").length;
    $("#pui-view-result").textContent = `조건 ${count}개 · 구성원 ${[48, 31, 19, 12, 7][count] ?? 7}명`;
  };
  $("#pui-tokens").addEventListener("click", (event) => {
    const remove = event.target.closest(".pui-token button");
    if (!remove) return;
    const token = remove.closest(".pui-token");
    let next = token.nextElementSibling;
    if (next?.classList.contains("pui-divider")) next = next.nextElementSibling;
    token.remove();
    countView();
    (next?.querySelector("button") || next || $("#pui-tokens .pui-add")).focus();
  });
  $("#pui-view-save").addEventListener("click", () => { $("#pui-view-result").textContent = `"${$("#pui-view-name").value.trim() || "이름 없는 보기"}" 보기를 저장했다고 가정한 예제입니다.`; });
  $("#pui-view-cancel").addEventListener("click", () => { $("#pui-view-name").value = "Product Group 휴직 중 구성원"; $("#pui-view-desc").value = ""; countView(); });

  let ruleId = 4;
  $("#pui-rule-add").addEventListener("click", () => {
    const rules = $("#pui-rules");
    rules.lastElementChild.querySelector(".pui-conj").textContent = "이면서";
    ruleId += 1;
    const row = document.createElement("div");
    row.className = "pui-rule";
    row.innerHTML = `<label class="lnd-sr" for="pui-r${ruleId}f">항목</label><select id="pui-r${ruleId}f" class="pui-field"><option>재직상태</option><option>언어</option><option>학교</option></select><label class="lnd-sr" for="pui-r${ruleId}v">값</label><select id="pui-r${ruleId}v" class="pui-value"><option>'재직' 포함</option><option>'휴직' 포함</option></select><span class="pui-conj"></span>`;
    rules.append(row);
    row.querySelector("select").focus();
    $("#pui-rule-result").textContent = `조건 ${rules.children.length + 1}개`;
  });

  const activity = (html, done) => {
    const item = document.createElement("li");
    item.innerHTML = `${icon(done ? "i-check-circle" : "i-close", done ? "is-green" : "")}<p>${html}<small>방금</small></p>`;
    $("#pui-activity").append(item);
  };
  function finishRequest(label, modifier) {
    $("#pui-approval-badge").textContent = label;
    $("#pui-approval-badge").classList.add(modifier);
    $("#pui-request-cancel").disabled = true;
    $$(".pui-pill-action").forEach((button) => { button.disabled = true; });
  }
  $(".pui-approval-side").addEventListener("click", (event) => {
    const button = event.target.closest(".pui-pill-action");
    if (!button || button.disabled) return;
    const row = button.closest("li");
    const stage = button.closest(".pui-stage");
    const pill = document.createElement("em");
    pill.className = "pui-pill pui-pill-ok";
    pill.innerHTML = `${icon("i-check")}승인`;
    button.replaceWith(pill);
    activity(`<b>${row.querySelector("b").textContent}</b>님이 정보 변경 요청을 <b>승인</b>했어요.`, true);
    if (stage.querySelector(".pui-pill-action")) return;
    const step = stage.querySelector(".pui-step");
    step.textContent = `${stage.dataset.stage} 단계 완료`;
    step.className = "pui-step is-done";
    stage.classList.remove("is-active");
    const next = stage.nextElementSibling;
    if (!next?.classList.contains("pui-stage")) { finishRequest("승인완료", "is-done"); return; }
    next.classList.remove("is-waiting");
    next.classList.add("is-active");
    const nextStep = next.querySelector(".pui-step");
    nextStep.textContent = `${next.dataset.stage} 단계 진행 중`;
    nextStep.className = "pui-step is-active";
    next.querySelectorAll(".pui-pill").forEach((waiting) => {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "pui-pill pui-pill-action";
      action.textContent = "승인하기";
      waiting.replaceWith(action);
    });
    next.querySelector(".pui-pill-action").focus();
  });
  $("#pui-request-cancel").addEventListener("click", () => {
    finishRequest("요청취소", "is-cancel");
    activity("<b>서윤</b>님이 변경 요청을 취소했어요.", false);
  });

  $$("#pui-cert-types button").forEach((button) => button.addEventListener("click", () => {
    $$("#pui-cert-types button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    $("#pui-cert-form-title").textContent = `${button.dataset.cert} 발급`;
  }));
  const memo = $("#pui-memo");
  memo.addEventListener("input", () => { $("#pui-memo-count").textContent = `${memo.value.length}/60`; });
  $("#pui-cert-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const reason = $("#pui-reason");
    const missing = !reason.value;
    $("#pui-reason-error").hidden = !missing;
    reason.setAttribute("aria-invalid", String(missing));
    if (missing) { reason.focus(); $("#pui-cert-result").textContent = ""; return; }
    const now = new Date();
    const day = "일월화수목금토"[now.getDay()];
    const type = $('#pui-cert-types [aria-pressed="true"]').dataset.cert;
    const item = document.createElement("li");
    item.className = "is-new";
    item.innerHTML = `<b>${type} - ${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${day}) <em>승인 대기</em></b><span>${reason.value} · 승인 필요</span>`;
    $("#pui-issued").prepend(item);
    $("#pui-cert-result").textContent = "발급 신청을 보냈다고 가정한 예제입니다. 발급 내역 맨 위에 추가했어요.";
  });

  $$("#pui-docs .pui-acc button").forEach((button) => button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    document.getElementById(button.getAttribute("aria-controls")).hidden = !open;
  }));
  const docRows = $$(".pui-doc-list li");
  const countDocs = () => { $("#pui-docs-count").textContent = docRows.filter((row) => row.querySelector("input").checked).length; };
  docRows.forEach((row) => {
    const checkbox = row.querySelector("input");
    const pill = row.querySelector(".pui-req-pill");
    checkbox.addEventListener("change", () => {
      pill.disabled = !checkbox.checked;
      if (!checkbox.checked) pill.setAttribute("aria-pressed", "false");
      countDocs();
    });
    pill.addEventListener("click", () => pill.setAttribute("aria-pressed", String(pill.getAttribute("aria-pressed") !== "true")));
  });

  const statusLabel = { todo: "요청 전", doing: "진행중", done: "완료" };
  const nextStatus = { todo: "doing", doing: "done", done: "todo" };
  const statusButtons = $$("#pui-tasks .pui-status");
  const countDone = () => { $("#pui-done").textContent = statusButtons.filter((button) => button.dataset.s === "done").length; };
  function setStatus(button, status) {
    button.dataset.s = status;
    button.textContent = statusLabel[status];
    button.setAttribute("aria-label", `상태 ${statusLabel[status]}, 눌러서 ${statusLabel[nextStatus[status]]}(으)로 변경`);
  }
  statusButtons.forEach((button) => {
    setStatus(button, button.dataset.s);
    button.addEventListener("click", () => { setStatus(button, nextStatus[button.dataset.s]); countDone(); });
  });
  $("#pui-complete-all").addEventListener("click", (event) => {
    statusButtons.forEach((button) => setStatus(button, "done"));
    countDone();
    event.currentTarget.disabled = true;
    $(".pui-onboard-name .pui-tag").textContent = "온보딩 완료";
  });

  $("#pui-template-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#pui-template-input");
    const name = input.value.trim();
    if (!name) return;
    const item = document.createElement("li");
    item.innerHTML = `${icon("i-doc")}<span class="pui-template-name"></span><button type="button" class="pui-ghost-ico">${icon("i-more")}</button>`;
    item.querySelector(".pui-template-name").textContent = name;
    item.querySelector("button").setAttribute("aria-label", `${name} 더보기`);
    $("#pui-templates").append(item);
    input.value = "";
  });
})();
