"use strict";
const select = (selector) => document.querySelector(selector);
select("#task-done").addEventListener("change", (event) => {
  select("#task-result").textContent = event.target.checked ? "완료" : "진행 전";
});
document.querySelectorAll('[name="plan"]').forEach((radio) => {
  radio.addEventListener("change", () => { select("#plan-result").textContent = radio.value === "개인" ? "혼자 쓰기를 골랐습니다." : "함께 쓰기를 골랐습니다."; });
});
select("#connection-check").addEventListener("click", () => {
  select("#connection-result").textContent = navigator.onLine ? "브라우저는 온라인 상태입니다. 서버 연결은 별도 확인이 필요합니다." : "브라우저가 오프라인 상태입니다.";
});
select("#task-create").addEventListener("click", () => {
  const item = document.createElement("li");
  item.textContent = "새 작업";
  select("#new-tasks").append(item);
  select("#empty h3").textContent = "작업 목록";
  select("#task-create").textContent = "작업 추가";
  select("#create-result").textContent = `${select("#new-tasks").children.length}개 작업`;
});
select("#drawer-toggle").addEventListener("click", (event) => {
  const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  select("#drawer-content").hidden = expanded;
  event.currentTarget.textContent = expanded ? "상세 열기" : "상세 닫기";
});
const dialog = select("#review-dialog");
select("#dialog-open").addEventListener("click", () => dialog.showModal());
dialog.addEventListener("close", () => select("#dialog-open").focus());
select("#name-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = select("#task-name");
  const name = input.value.trim();
  const valid = name.length > 0 && name.length <= 60;
  select("#name-error").hidden = valid;
  select("#name-error").textContent = valid ? "" : "작업 이름을 1~60자로 입력하세요.";
  input.setAttribute("aria-invalid", String(!valid));
  select("#name-result").textContent = valid ? `작업 이름: ${name}` : "";
  if (!valid) input.focus();
});
let attempts = 0;
select("#state-load").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  select("#state").setAttribute("aria-busy", "true");
  select("#state-result").textContent = "불러오는 중";
  attempts += 1;
  await new Promise((resolve) => setTimeout(resolve, 350));
  select("#state-result").textContent = attempts === 1 ? "불러오지 못했습니다. 다시 시도하세요." : "불러왔습니다. 작업 3개를 확인할 수 있습니다.";
  button.textContent = attempts === 1 ? "다시 시도" : "다시 불러오기";
  button.disabled = false;
  select("#state").setAttribute("aria-busy", "false");
});
const tabs = [...document.querySelectorAll('.pattern-tabs [role="tab"]')];
function selectTab(tab) {
  tabs.forEach((item) => {
    const active = item === tab;
    item.setAttribute("aria-selected", String(active));
    item.tabIndex = active ? 0 : -1;
    document.getElementById(item.getAttribute("aria-controls")).hidden = !active;
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    const target = {ArrowRight:(index + 1) % tabs.length, ArrowLeft:(index + tabs.length - 1) % tabs.length, Home:0, End:tabs.length - 1}[event.key];
    if (target === undefined) return;
    event.preventDefault();
    selectTab(tabs[target]);
    tabs[target].focus();
  });
});
let reviewerCount = 2;
function changeReviewerCount(delta) {
  reviewerCount = Math.min(8, Math.max(1, reviewerCount + delta));
  select("#quantity-value").textContent = `${reviewerCount}명`;
  select("#quantity-down").disabled = reviewerCount === 1;
  select("#quantity-up").disabled = reviewerCount === 8;
}
select("#quantity-down").addEventListener("click", () => changeReviewerCount(-1));
select("#quantity-up").addEventListener("click", () => changeReviewerCount(1));
select("#assignee-search").addEventListener("input", (event) => {
  const query = event.target.value.trim().normalize("NFKC").toLocaleLowerCase();
  const people = [...document.querySelectorAll('#assignee-list li')];
  people.forEach((person) => { person.hidden = !person.textContent.normalize("NFKC").toLocaleLowerCase().includes(query); });
  const count = people.filter((person) => !person.hidden).length;
  select("#assignee-result").textContent = count ? `${count}명` : "일치하는 담당자가 없습니다.";
});
select("#review-alerts").addEventListener("change", (event) => {
  select("#preferences-result").textContent = event.target.checked ? "살펴봐 달라는 알림을 받습니다." : "살펴봐 달라는 알림을 받지 않습니다.";
});
select("#archive-task").addEventListener("click", () => {
  select("#archive-item").hidden = true;
  select("#archive-notice").hidden = false;
  select("#archive-result").textContent = "메뉴 살펴보기를 접어뒀습니다.";
  select("#undo-archive").focus();
});
select("#undo-archive").addEventListener("click", () => {
  select("#archive-item").hidden = false;
  select("#archive-notice").hidden = true;
  select("#archive-result").textContent = "메뉴 살펴보기를 복원했습니다.";
  select("#archive-task").focus();
});
document.querySelectorAll('.tag-choices input').forEach((checkbox) => checkbox.addEventListener("change", () => {
  const values = [...document.querySelectorAll('.tag-choices input:checked')].map((item) => item.value);
  select("#tag-result").textContent = values.length ? `${values.join(', ')} · ${values.length}개 선택` : "선택한 영역이 없습니다.";
}));
const dotField = Array.from({ length: 17 * 13 }, (_, index) => {
  const x = index % 17;
  const y = Math.floor(index / 17);
  const distance = Math.hypot(x - 8, y - 6);
  return `<circle cx="${x * 25 + 10}" cy="${y * 25 + 10}" r="2" style="--delay:${(-distance * .18).toFixed(2)}s;--brightness:${(.25 + .75 * (1 - Math.min(distance / 11, 1))).toFixed(2)}"/>`;
}).join("");
const entryStyles = `.entry-frame { position: absolute; width: 270px; height: 240px; right: 10%; top: calc(50% - 120px); }
@media (max-width:480px) { .entry-frame { width: 230px; height: 180px; right: calc(50% - 115px); top: auto; bottom: 30px; } }`;
const effectDefinitions = {
  trail: {
    name: "빛 궤적", number: "01", title: "다음 아이디어의<br>시작점.", caption: "작업의 중심에, 한 줄기의 빛.",
    purpose: "시선을 모으는 경계",
    description: "중요한 카드나 고른 곳에 쓰세요. 빛은 테두리를 따라 움직이고 콘텐츠는 그대로 유지됩니다.",
    tech: "conic-gradient · transform\n동작 감소 설정에서는 정지",
    markup: '<div class="trail-halo"></div><div class="orbit-card"><div class="orbit-content"><span class="orbit-symbol">O</span><span class="orbit-label">ORBITAL</span><strong>모든 아이디어가<br>모이는 곳.</strong><div class="orbit-lines"><i></i><i></i><i></i></div><span class="orbit-meta">WORKSPACE 2.4 <b>↗</b></span></div></div>',
    css: `.fx-trail { background: radial-gradient(ellipse at 73% 55%, #282c4b 0, #10141e 60%); }
.trail-halo { position: absolute; width: 380px; height: 300px; right: 0; top: 15%; background: radial-gradient(ellipse, #a18bf538, transparent 66%); }
.orbit-card { position: absolute; width: 250px; height: 205px; right: 12%; top: 24%; border-radius: 20px; overflow: hidden; transform: rotate(-8deg); box-shadow: 0 30px 70px #0008, 0 0 55px #8979df18; }
.orbit-card::before { content: ""; position: absolute; inset: -100%; background: conic-gradient(from 30deg, #2f3548 0deg, #2f3548 170deg, #746edc 220deg, #d5efff 250deg, #c7a5fc 265deg, #343951 300deg); animation: orbit calc(7s / var(--speed, 1)) linear infinite; animation-play-state: var(--play-state, paused); }
.orbit-content { position: absolute; inset: 1.5px; border-radius: 19px; padding: 22px; background: linear-gradient(135deg, #252c3a, #141925); color: #edf0fb; font-family: system-ui, sans-serif; }
.orbit-symbol { display: inline-grid; place-items: center; width: 22px; height: 22px; border: 1px solid #9eaac4; border-radius: 50%; font-size: 12px; }
.orbit-label { font: 8px ui-monospace, monospace; letter-spacing: .12em; margin-left: 8px; color: #b8c2d6; }
.orbit-content strong { display: block; margin: 15px 0; font-size: 19px; line-height: 1.4; font-weight: 500; }
.orbit-lines { display: flex; gap: 5px; }
.orbit-lines i { width: 28px; height: 4px; background: #6b759b; border-radius: 4px; }
.orbit-lines i:nth-child(2) { width: 46px; background: #c7baee; }
.orbit-lines i:nth-child(3) { width: 19px; background: #505a76; }
.orbit-meta { display: flex; justify-content: space-between; margin-top: 19px; color: #aab4cd; font: 8px ui-monospace, monospace; letter-spacing: .08em; }
@keyframes orbit { to { transform: rotate(360deg); } }
@media (max-width: 480px) { .orbit-card { width: 240px; height: 205px; top: auto; right: calc(50% - 120px); bottom: 58px; } .trail-halo { top: auto; bottom: 10px; right: calc(50% - 190px); } }`
  },
  dots: {
    name: "점 파동", number: "02", title: "작은 움직임이<br>만드는 깊이.", caption: "하나의 점에서 시작되는 파동.",
    purpose: "정보를 가리지 않는 리듬",
    description: "넓은 배경이나 대기 화면에 깊이를 더하세요. 점마다 다른 위상으로 움직여 중심에서 바깥으로 파동이 퍼집니다.",
    tech: "SVG circle · opacity\n동작 감소 설정에서는 정지",
    markup: `<div class="dot-aura"></div><svg class="dot-field" viewBox="0 0 420 320" fill="#9fe5d5" preserveAspectRatio="xMidYMid meet">${dotField}</svg><div class="dot-center"></div>`,
    css: `.fx-dots { background: radial-gradient(ellipse at 72% 47%, #173438, #10191f 58%); }
.dot-aura { position: absolute; width: 300px; height: 300px; right: 8%; top: 12%; background: radial-gradient(circle, #65c5b51a, transparent 70%); }
.dot-field { position: absolute; right: 0; top: 6%; width: 58%; height: 88%; mask-image: radial-gradient(ellipse, #000 20%, transparent 72%); }
.dot-field circle { transform-box: fill-box; transform-origin: center; opacity: var(--brightness); animation: dot-wave calc(4s / var(--speed, 1)) ease-in-out infinite; animation-delay: calc(var(--delay) / var(--speed, 1)); animation-play-state: var(--play-state, paused); }
.dot-center { position: absolute; width: 70px; height: 70px; right: calc(29% - 35px); top: calc(50% - 35px); border: 1px solid #8ddbc150; border-radius: 50%; background: radial-gradient(circle, #8ddbc122, transparent); box-shadow: 0 0 60px #8ddbc111; }
@keyframes dot-wave { 0%, 100% { opacity: .18; transform: scale(.6); } 45% { opacity: 1; transform: scale(1.5); } }
@media (max-width: 480px) { .dot-field { width: 110%; height: 64%; top: auto; bottom: 16px; right: -5%; } .dot-center { right: calc(50% - 35px); top: auto; bottom: 128px; } .dot-aura { right: calc(50% - 150px); top: auto; bottom: 15px; } }`
  },
  gradient: {
    name: "오로라", number: "03", title: "경계 없이<br>흐르는 생각.", caption: "서로 다른 색이 만나는 순간.",
    purpose: "넓은 면에 더하는 온도",
    description: "시작 화면이나 브랜드 영역에 사용하세요. 세 겹의 색이 서로 다른 속도로 흐르며 깊이를 만듭니다.",
    tech: "radial-gradient · transform\n동작 감소 설정에서는 정지",
    markup: '<div class="aurora aurora-one"></div><div class="aurora aurora-two"></div><div class="aurora aurora-three"></div><div class="aurora-shade"></div>',
    css: `.fx-gradient { background: #141a2a; }
.aurora { position: absolute; width: 90%; height: 140%; border-radius: 50%; filter: blur(35px); animation: aurora-drift calc(12s / var(--speed, 1)) ease-in-out infinite alternate; animation-play-state: var(--play-state, paused); }
.aurora-one { right: -25%; top: -65%; background: radial-gradient(ellipse, #8c9cdb 0, #625a9d 30%, transparent 67%); transform: rotate(-30deg); }
.aurora-two { right: -24%; bottom: -95%; background: radial-gradient(ellipse, #e4b284 5%, #a56787 32%, transparent 68%); animation-delay: -5s; animation-direction: alternate-reverse; }
.aurora-three { right: 2%; bottom: -70%; width: 55%; background: radial-gradient(ellipse, #86bdb6 0, #5b6a92 34%, transparent 65%); animation-delay: -9s; }
.aurora-shade { position: absolute; inset: 0; background: linear-gradient(90deg, #10141ed9 0, #10141e66 30%, transparent 65%); }
@keyframes aurora-drift { to { transform: translate(-12%, 10%) rotate(25deg) scale(1.12); } }
@media (max-width: 480px) { .aurora-one { width: 160%; right: -70%; top: -35%; } .aurora-two { width: 150%; bottom: -65%; right: -50%; } .aurora-three { width: 120%; right: 0; bottom: -65%; } .aurora-shade { background: linear-gradient(#10141e88, transparent 70%); } }`
  },
  spotlight: {
    name: "스포트라이트", number: "04", title: "중요한 순간에<br>머무는 빛.", caption: "한 곳에 시선을 모으는 조명.",
    purpose: "주인공 하나를 강조하는 조명",
    description: "제품 카드나 핵심 메시지를 강조할 때 사용하세요. 따뜻한 조명이 천천히 이동하고 카드의 위치는 유지됩니다.",
    tech: "radial-gradient · transform\n동작 감소 설정에서는 정지",
    markup: '<div class="spot-light"></div><div class="spot-card"><span>ORBITAL / COLLECTION</span><strong>좋은 생각을<br>잃지 않도록.</strong><div class="spot-orb"></div><small>YOUR NEXT IDEA</small></div>',
    css: `.fx-spotlight { background: #191916; }
.spot-light { position: absolute; width: 600px; height: 600px; right: -8%; top: -28%; background: radial-gradient(ellipse, #e2be8c38, #c5a7860c 45%, transparent 65%); animation: spotlight-drift calc(8s / var(--speed, 1)) ease-in-out infinite alternate; animation-play-state: var(--play-state, paused); }
.spot-card { position: absolute; right: 12%; top: 20%; width: 230px; height: 230px; padding: 23px; border-radius: 5px; color: #e4d4b9; border: 1px solid #8c7f624f; background: linear-gradient(135deg, #484234, #252722); transform: rotate(5deg); box-shadow: 0 24px 50px #0004; font-family: system-ui, sans-serif; }
.spot-card > span, .spot-card small { font: 8px ui-monospace, monospace; letter-spacing: .1em; }
.spot-card strong { display: block; font-size: 23px; font-weight: 450; line-height: 1.35; margin: 22px 0 10px; }
.spot-orb { position: absolute; right: 18px; bottom: 20px; width: 65px; height: 65px; border-radius: 50%; background: radial-gradient(circle at 30% 25%, #e0d3ab, #888468 38%, #353c33 75%); box-shadow: 8px 10px 18px #0003; }
.spot-card small { position: absolute; bottom: 25px; }
@keyframes spotlight-drift { to { transform: translate(-22%, 12%) rotate(12deg); } }
@media (max-width:480px) { .spot-card { width: 205px; height: 175px; top: auto; right: calc(50% - 102px); bottom: 32px; padding: 18px; } .spot-card strong { font-size: 18px; margin: 12px 0; } .spot-orb { width: 48px; height: 48px; } .spot-light { right: -90%; top: -25%; } }`
  },
  rings: {
    name: "동심원", number: "05", title: "작은 신호가<br>넓게 퍼지도록.", caption: "중심에서 시작되는 잔잔한 울림.",
    purpose: "연결과 반응을 표현하는 파동",
    description: "연결 대기나 상태 소개에 사용하세요. 세 개의 링이 시간차를 두고 퍼집니다. 실제 연결 상태를 대신하지는 않습니다.",
    tech: "border · transform · opacity\n동작 감소 설정에서는 정지",
    markup: '<div class="ripple-field"><i></i><i></i><i></i><div class="ripple-core"><span>O</span></div></div>',
    css: `.fx-rings { background: radial-gradient(ellipse at 72% 50%, #223b49, #111c25 65%); }
.ripple-field { position: absolute; width: 290px; height: 290px; right: 8%; top: calc(50% - 145px); }
.ripple-field > i { position: absolute; inset: 0; border: 1px solid #99c4db70; border-radius: 50%; animation: ripple-spread calc(5s / var(--speed, 1)) ease-out infinite; animation-play-state: var(--play-state, paused); }
.ripple-field > i:nth-child(2) { animation-delay: calc(-1.65s / var(--speed, 1)); }
.ripple-field > i:nth-child(3) { animation-delay: calc(-3.3s / var(--speed, 1)); }
.ripple-core { position: absolute; inset: calc(50% - 34px); border-radius: 50%; border: 1px solid #8ab3c86b; display: grid; place-items: center; background: linear-gradient(135deg, #314d5e, #172d3a); box-shadow: 0 0 65px #80c2dc18; }
.ripple-core span { color: #c6e4f0; font: 30px Georgia, serif; }
@keyframes ripple-spread { from { transform: scale(.24); opacity: .8; } to { transform: scale(1.2); opacity: 0; } }
@media (max-width:480px) { .ripple-field { width: 220px; height: 220px; top: auto; right: calc(50% - 110px); bottom: 12px; } }`
  },
  beams: {
    name: "빛줄기", number: "06", title: "흐름에 방향을<br>더하는 선.", caption: "어둠을 가로지르는 세 줄기의 빛.",
    purpose: "공간에 방향을 만드는 빛줄기",
    description: "넓은 시작 화면의 배경에 사용하세요. 선마다 다른 속도로 이동하며, 메시지와 겹치는 왼쪽 영역은 어둡게 유지합니다.",
    tech: "linear-gradient · transform\n동작 감소 설정에서는 정지",
    markup: '<div class="beam-field"><i></i><i></i><i></i><div class="beam-disc"></div></div><div class="beam-shade"></div>',
    css: `.fx-beams { background: #10141e; }
.beam-field { position: absolute; width: 65%; height: 170%; top: -35%; right: -4%; transform: rotate(28deg); overflow: hidden; }
.beam-field > i { position: absolute; width: 1px; height: 72%; top: -10%; left: 25%; background: linear-gradient(transparent, #aac8e0, #e6edff, transparent); box-shadow: 0 0 12px 2px #8bafeb30; animation: beam-slide calc(5s / var(--speed, 1)) ease-in-out infinite alternate; animation-play-state: var(--play-state, paused); }
.beam-field > i:nth-child(2) { left: 52%; top: 20%; animation-delay: -2s; background: linear-gradient(transparent, #e0c4e4, transparent); }
.beam-field > i:nth-child(3) { left: 77%; top: -30%; animation-delay: -4s; }
.beam-disc { position: absolute; left: 28%; top: 39%; width: 150px; height: 150px; border-radius: 50%; border: 1px solid #b4c8e840; background: linear-gradient(130deg, #a0b7e221, #10141e); box-shadow: -15px -10px 50px #7893cb15; }
.beam-shade { position: absolute; inset: 0; background: linear-gradient(90deg, #10141e, transparent 65%); }
@keyframes beam-slide { to { transform: translateY(25%); opacity: .45; } }
@media (max-width:480px) { .beam-field { top: 12%; right: -15%; width: 100%; height: 120%; } .beam-disc { width: 110px; height: 110px; } .beam-shade { background: linear-gradient(#10141e 5%, transparent 65%); } }`
  },
  stagger: {
    name: "순차 등장", number: "07", mode: "entrance", title: "하나씩,<br>자연스러운 순서로.", caption: "시작 효과 · 세 장의 카드가 차례로 등장합니다.",
    purpose: "읽는 순서를 만드는 첫 등장",
    description: "대시보드나 온보딩의 첫 화면에 쓰세요. 세 카드는 80ms 간격으로 등장한 뒤 멈춥니다. 처음부터 버튼으로 다시 볼 수 있습니다.",
    tech: "transform · opacity · 1회 재생\n동작 감소 설정에서는 완성 상태",
    markup: '<div class="entry-frame stagger-frame"><div class="stagger-card"><span>01</span><div><strong>아이디어 모으기</strong><small>시작할 준비가 됐어요</small></div><b>✓</b></div><div class="stagger-card"><span>02</span><div><strong>함께 살펴보기</strong><small>세 명의 의견을 한곳에</small></div><b>✓</b></div><div class="stagger-card entry-complete"><span>03</span><div><strong>다음 단계로</strong><small>좋은 작업을 이어가세요</small></div><b>↗</b></div></div>',
    css: entryStyles + `.fx-stagger { background: radial-gradient(ellipse at 75% 50%, #3b3531, #1c1b1b 65%); }
.stagger-frame { display: grid; align-content: center; gap: 12px; }
.stagger-card { display: flex; align-items: center; gap: 12px; padding: 16px; border-radius: 9px; background: #ede8e1; color: #3c3731; box-shadow: 0 8px 20px #0002; font-family: system-ui, sans-serif; }
.stagger-card > span { font: 10px ui-monospace, monospace; color: #8b7766; }
.stagger-card strong { display: block; font-size: 13px; line-height: 1.35; font-weight: 550; }
.stagger-card small { display: block; font-size: 10px; line-height: 1.3; color: #796e64; margin-top: 4px; }
.stagger-card b { margin-left: auto; font-weight: 400; color: #7d6f5f; }
.fx-stagger[data-started=true] .stagger-card { animation: entry-rise calc(.5s / var(--speed, 1)) cubic-bezier(.22,1,.36,1) both; animation-play-state: var(--play-state, paused); }
.fx-stagger[data-started=true] .stagger-card:nth-child(2) { animation-delay: calc(.08s / var(--speed, 1)); }
.fx-stagger[data-started=true] .stagger-card:nth-child(3) { animation-delay: calc(.16s / var(--speed, 1)); }
@keyframes entry-rise { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width:480px) { .stagger-frame { gap: 8px; } .stagger-card { padding: 11px 13px; } .stagger-card small { font-size: 9px; } }`
  },
  curtain: {
    name: "커튼 열기", number: "08", mode: "entrance", title: "새로운 장면을<br>여는 순간.", caption: "시작 효과 · 화면을 덮은 면이 걷힙니다.",
    purpose: "장면의 시작을 알리는 전환",
    description: "짧은 소개나 새 작업 공간의 첫 화면에 사용하세요. 덮개만 이동하고 실제 콘텐츠는 자리를 유지합니다. 반복 자동 재생은 하지 않습니다.",
    tech: "transform · transform-origin\n동작 감소 설정에서는 완성 상태",
    markup: '<div class="entry-frame curtain-frame"><div class="curtain-page"><span>ORBITAL / 2.4</span><strong>O.</strong><p>좋은 작업의 시작.</p></div><div class="curtain-cover entry-complete"><span>ORBITAL</span></div></div>',
    css: entryStyles + `.fx-curtain { background: radial-gradient(ellipse at 72% 50%, #3c3340, #1b1822 65%); }
.curtain-frame { border-radius: 4px; overflow: hidden; box-shadow: 0 20px 55px #0004; }
.curtain-page { position: absolute; inset: 0; padding: 24px; background: #ece4dc; color: #493a36; font-family: system-ui, sans-serif; }
.curtain-page > span { font: 9px ui-monospace, monospace; letter-spacing: .1em; }
.curtain-page strong { display: block; font: italic 95px/1.1 Georgia, serif; margin-top: 12px; }
.curtain-page p { font-size: 13px; margin: 12px 0 0; }
.curtain-cover { position: absolute; inset: 0; background: #ad8167; color: #2c2424; display: grid; place-items: center; transform: scaleX(0); transform-origin: right; font: 11px ui-monospace, monospace; letter-spacing: .2em; }
.fx-curtain[data-started=true] .curtain-cover { animation: curtain-open calc(.7s / var(--speed, 1)) cubic-bezier(.76,0,.24,1) both; animation-play-state: var(--play-state, paused); }
@keyframes curtain-open { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (max-width:480px) { .curtain-page { padding: 19px; } .curtain-page strong { font-size: 68px; margin-top: 4px; } }`
  },
  reveal: {
    name: "문장 드러내기", number: "09", mode: "entrance", title: "말하고 싶은 것을<br>한 줄씩.", caption: "시작 효과 · 세 문장이 순서대로 드러납니다.",
    purpose: "첫 메시지에 읽는 순서 부여",
    description: "소개 문구나 온보딩 제목에 사용하세요. 문장이 줄의 경계 안에서 올라오며, 동작을 줄이면 처음부터 모든 문장을 보여 줍니다.",
    tech: "overflow · transform · 1회 재생\n동작 감소 설정에서는 완성 상태",
    markup: '<div class="entry-frame reveal-frame"><span class="reveal-label">A SPACE FOR YOUR NEXT IDEA</span><div class="reveal-line"><span class="reveal-text">모으고.</span></div><div class="reveal-line"><span class="reveal-text">집중하고.</span></div><div class="reveal-line"><span class="reveal-text entry-complete">완성하고.</span></div></div>',
    css: entryStyles + `.fx-reveal { background: radial-gradient(ellipse at 72% 50%, #343b4a, #141a26 65%); }
.reveal-frame { display: flex; flex-direction: column; justify-content: center; padding-left: 24px; border-left: 1px solid #a2afc950; color: #e6e8ec; font-family: system-ui, sans-serif; }
.reveal-label { font: 8px ui-monospace, monospace; letter-spacing: .08em; color: #a6b1c6; margin-bottom: 20px; }
.reveal-line { overflow: hidden; }
.reveal-text { display: block; font-size: 37px; line-height: 1.4; font-weight: 450; letter-spacing: -.04em; }
.reveal-line:last-child { color: #d4b89a; }
.fx-reveal[data-started=true] .reveal-text { animation: text-reveal calc(.55s / var(--speed, 1)) cubic-bezier(.22,1,.36,1) both; animation-play-state: var(--play-state, paused); }
.fx-reveal[data-started=true] .reveal-line:nth-of-type(2) .reveal-text { animation-delay: calc(.1s / var(--speed, 1)); }
.fx-reveal[data-started=true] .reveal-line:nth-of-type(3) .reveal-text { animation-delay: calc(.2s / var(--speed, 1)); }
@keyframes text-reveal { from { transform: translateY(105%); } to { transform: translateY(0); } }
@media (max-width:480px) { .reveal-text { font-size: 30px; } .reveal-label { margin-bottom: 12px; } }`
  }

};
const sampleStyles = `.effect-sample { position: relative; isolation: isolate; width: 100%; height: 420px; overflow: hidden; --speed: 1; --play-state: paused; }
@media (prefers-reduced-motion: reduce) { .effect-sample *, .effect-sample *::before { animation: none !important; } }`;
const effectSheet = document.createElement("style");
effectSheet.textContent = sampleStyles + Object.values(effectDefinitions).map((effect) => effect.css).join("\n");
document.head.append(effectSheet);
let selectedEffect = "trail";
let effectsRequested = false;
let entryFinished = false;
let effectVisible = true;
let copyVersion = 0;
const motion = matchMedia("(prefers-reduced-motion: reduce)");

function effectSource() {
  const effect = effectDefinitions[selectedEffect];
  const speed = Number(select("#effect-speed").value) / 100;
  return `<!doctype html>
<html lang="ko">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${effect.name}</title>
<style>
${sampleStyles}
${effect.css}
</style>
<div class="effect-sample fx-${selectedEffect}" aria-hidden="true" style="--speed:${speed}">${effect.markup}</div>
<button type="button" id="play" aria-pressed="false">효과 재생</button>
<script>
const sample = document.querySelector('.effect-sample');
const button = document.querySelector('#play');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const entrance = ${effect.mode === "entrance"};
let requested = false;
let finished = false;
function update() {
  sample.style.setProperty('--play-state', requested && !document.hidden && !reduced.matches ? 'running' : 'paused');
  button.setAttribute('aria-pressed', String(requested));
  button.textContent = finished ? '다시 재생' : requested ? '효과 정지' : '효과 재생';
}
button.addEventListener('click', () => {
  if (entrance && (!sample.dataset.started || finished)) {
    sample.dataset.started = 'false';
    void sample.offsetWidth;
    sample.dataset.started = 'true';
    finished = false;
    requested = true;
  } else requested = !requested;
  update();
});
sample.addEventListener('animationend', event => {
  if (entrance && event.target.classList.contains('entry-complete')) {
    requested = false;
    finished = true;
    update();
  }
});
document.addEventListener('visibilitychange', update);
reduced.addEventListener('change', update);
update();
<` + "/script>\n</html>";
}
function updateSource() {
  copyVersion += 1;
  select("#effect-code").textContent = effectSource();
  select("#copy-result").textContent = "";
  select("#copy-code").textContent = "코드 복사";
  select("#copy-code").disabled = false;
}
function updateEffects() {
  const active = effectsRequested && !motion.matches && !document.hidden && effectVisible && !select("#effects").hidden;
  select("#effects").classList.toggle("playing", active);
  select(".effect-sample").style.setProperty("--play-state", active ? "running" : "paused");
  select("#effects-toggle").setAttribute("aria-pressed", String(effectsRequested));
  select("#play-label").textContent = entryFinished ? "다시 재생" : effectsRequested ? "정지" : "재생";
  select("#play-icon").textContent = effectsRequested ? "Ⅱ" : "▷";
  select("#effects-result").textContent = motion.matches ? "동작 감소 설정으로 정지됨" : entryFinished ? "시작 효과 완료" : active ? "효과 재생 중" : "효과 정지됨";
}
function chooseEffect(id) {
  const effect = effectDefinitions[id];
  selectedEffect = id;
  select("#effect-picker").value = id;
  entryFinished = false;
  select("#effects-restart").hidden = effect.mode !== "entrance";
  select("#effect-stage").dataset.effect = id;
  select("#effect-art").innerHTML = `<div class="effect-sample fx-${id}">${effect.markup}</div>`;
  select(".effect-sample").style.setProperty("--speed", Number(select("#effect-speed").value) / 100);
  const sample = select(".effect-sample");
  if (effect.mode === "entrance" && effectsRequested) sample.dataset.started = "true";
  sample.addEventListener("animationend", (event) => {
    if (effect.mode === "entrance" && event.target.classList.contains("entry-complete")) {
      effectsRequested = false;
      entryFinished = true;
      updateEffects();
    }
  });
  select("#effect-name").textContent = effect.name;
  select("#effect-number").textContent = effect.number;
  select("#stage-title").innerHTML = effect.title;
  select("#stage-description").textContent = effect.caption;
  select("#effect-purpose").textContent = effect.purpose;
  select("#effect-description").textContent = effect.description;
  select("#effect-tech").textContent = effect.tech;
  document.querySelectorAll("[data-effect]").forEach((button) => {
    if (button.tagName === "BUTTON") button.setAttribute("aria-pressed", String(button.dataset.effect === id));
  });
  updateSource();
  updateEffects();
}
let currentView = "effects";
function setView() {
  const fragment = location.hash.slice(1);
  if (fragment === "cards" || fragment === "effects") currentView = fragment;
  else if (patternCards.some((card) => card.id === fragment)) currentView = "cards";
  const view = currentView;
  select("#effects").hidden = view !== "effects";
  select("#cards").hidden = view !== "cards";
  select("#effect-navigation").hidden = view !== "effects";
  document.querySelectorAll("[data-view]").forEach((link) => {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  updateEffects();
}
document.querySelectorAll("button[data-effect]").forEach((button) => button.addEventListener("click", () => chooseEffect(button.dataset.effect)));
function restartEntrance() {
  const sample = select(".effect-sample");
  sample.dataset.started = "false";
  void sample.offsetWidth;
  sample.dataset.started = "true";
  entryFinished = false;
  effectsRequested = true;
  updateEffects();
}
select("#effects-toggle").addEventListener("click", () => {
  if (effectDefinitions[selectedEffect].mode === "entrance" && (!select(".effect-sample").dataset.started || entryFinished)) restartEntrance();
  else { effectsRequested = !effectsRequested; updateEffects(); }
});
select("#effects-restart").addEventListener("click", restartEntrance);
select("#effect-picker").addEventListener("change", (event) => chooseEffect(event.target.value));
select("#effect-speed").addEventListener("input", (event) => {
  const speed = Number(event.target.value) / 100;
  select("#speed-value").textContent = `${speed}×`;
  select(".effect-sample").style.setProperty("--speed", speed);
  updateSource();
});
select("#copy-code").addEventListener("click", async () => {
  const version = copyVersion;
  const button = select("#copy-code");
  let copyTimeout;
  button.disabled = true;
  button.textContent = "복사 중…";
  select("#copy-result").textContent = "클립보드에 복사하고 있습니다.";
  try {
    // Clipboard permission can leave the browser promise pending without a visible result.
    await Promise.race([
      navigator.clipboard.writeText(effectSource()),
      new Promise((_, reject) => { copyTimeout = setTimeout(() => reject(new Error("Clipboard response timed out")), 4000); })
    ]);
    if (version === copyVersion) {
      button.textContent = "복사됨";
      select("#copy-result").textContent = "현재 효과의 코드를 복사했습니다.";
    }
  } catch {
    if (version === copyVersion) {
      button.textContent = "다시 복사";
      select("#copy-result").textContent = "복사하지 못했습니다. ‘코드 선택’을 누른 뒤 직접 복사해 주세요.";
    }
  } finally {
    clearTimeout(copyTimeout);
    if (version === copyVersion) button.disabled = false;
  }
});
select("#select-code").addEventListener("click", () => {
  const range = document.createRange();
  range.selectNodeContents(select("#effect-code"));
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  select("#effect-code").parentElement.focus();
  select("#copy-result").textContent = "코드를 선택했습니다. Ctrl+C 또는 ⌘C로 복사하세요.";
});
let category = "all";
const patternCards = [...document.querySelectorAll("#cards article")];
const searchIndex = new Map(patternCards.map((card) => [card, card.textContent.normalize("NFKC").toLocaleLowerCase()]));
function filterPatterns() {
  const query = select("#pattern-search").value.trim().normalize("NFKC").toLocaleLowerCase();
  let count = 0;
  patternCards.forEach((card) => {
    const visible = (category === "all" || card.dataset.category === category) && searchIndex.get(card).includes(query);
    card.hidden = !visible;
    if (visible) count += 1;
  });
  select("#pattern-count").textContent = `${count}개 패턴`;
  select("#no-patterns").hidden = count !== 0;
  select("#reset-patterns").hidden = category === "all" && !query;
  document.querySelectorAll("button[data-category]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.category === category)));
}
document.querySelectorAll("button[data-category]").forEach((button) => button.addEventListener("click", () => { category = button.dataset.category; filterPatterns(); }));
select("#pattern-search").addEventListener("input", filterPatterns);
select("#reset-patterns").addEventListener("click", () => {
  category = "all";
  select("#pattern-search").value = "";
  filterPatterns();
  select("#pattern-search").focus();
});
window.addEventListener("hashchange", setView);
document.addEventListener("visibilitychange", updateEffects);
motion.addEventListener("change", updateEffects);
chooseEffect(selectedEffect);
setView();
new IntersectionObserver(([entry]) => {
  effectVisible = entry.isIntersecting;
  updateEffects();
}, { threshold: .1 }).observe(select("#effect-stage"));
