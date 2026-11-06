# 업무 화면 컴포넌트 키트

목록, 표, 설정, 일정, 승인처럼 정보가 빽빽한 업무용 SaaS 화면을 만들 때 씁니다. 빌드 없는 HTML에서는 CSS와 JS를 그대로 붙이고, React·Vue 같은 프레임워크에서는 아래 "프레임워크에서 쓰기"를 따릅니다. 예시 문구는 프로젝트, 작업, 고객, 청구서 같은 일반 소재를 씁니다. 실행 예시와 복사할 코드는 [컴포넌트 키트](../../assets/kit/index.html)에 있습니다.

## 붙이는 방법

1. `assets/kit/kit.css`와 `assets/kit/kit.js`를 프로젝트로 복사합니다.
2. 키트 페이지의 `<svg class="jk-sprite">` 스프라이트를 문서 `<body>` 바로 안에 옮깁니다. `file://`에서는 외부 SVG 파일의 `<use href="파일#id">`가 막히므로 스프라이트는 문서 안에 둡니다.
3. 컴포넌트를 담는 요소에 `class="jk"`를 줍니다. 글꼴, 글자색, 줄 간격, 초점 표시, 한국어 줄바꿈이 이 범위에만 적용됩니다.
4. 키트 페이지에서 필요한 예시의 **코드 보기**를 열어 마크업을 복사합니다. `doc.css`와 `doc.js`는 문서 페이지 전용이므로 복사하지 않습니다.

## 프레임워크에서 쓰기

`kit.css`는 프레임워크와 관계없이 그대로 씁니다. 앱 진입점에서 한 번 불러오고, 마크업의 `class`는 `className`처럼 프레임워크 문법으로 옮깁니다. 아이콘 스프라이트는 앱 최상위나 HTML 셸에 한 번만 둡니다.

`kit.js`는 DOM을 직접 바꾸므로 프레임워크가 상태를 가진 화면에서는 쓰지 않습니다. `aria-selected`, `aria-expanded`, `aria-pressed`, `hidden`, 글자를 직접 고치고, `append`는 노드를 붙이며 `tokens`는 노드를 지웁니다. 프레임워크가 같은 요소를 렌더하면 프레임워크의 상태와 화면이 어긋납니다. 탭, 펼침, 선택, 목록 상자, 대화 상자, 토큰, 전체 선택, 일괄 처리, 상태 단추, 항목 추가, 폼 검사는 프레임워크 상태로 다시 만들고, 아래 "동작 속성" 표에 적힌 ARIA 속성과 키보드 동작을 그대로 렌더합니다. 그러면 `kit.css`의 상태 스타일이 그대로 맞습니다.

프레임워크가 다시 렌더하지 않는 정적 영역(꾸미기 효과, 설명용 예시)에만 `kit.js`를 붙일 수 있습니다.

- `kit.js`는 불러오는 즉시 `document`를 읽습니다. 서버 렌더링을 쓰면 HTML 셸의 `<script src="kit.js" defer>`나 클라이언트에서만 실행되는 코드에서 불러옵니다.
- 불러올 때 문서 전체를 한 번 연결하므로, 나중에 마운트된 마크업은 마운트 뒤에 `window.jk.init(container)`로 연결합니다. `init`은 넘긴 요소의 하위만 찾으므로 `data-jk`가 붙은 요소가 아니라 그 부모를 넘깁니다. 같은 요소를 다시 넘겨도 한 번만 연결됩니다.
- 연결을 푸는 함수는 없습니다. `data-jk-dismiss`가 있는 펼침, `data-jk-checkall`, `data-jk-bulk`는 `document`에 리스너를 남기므로 자주 마운트되고 해제되는 영역에는 쓰지 않습니다.
- `jk:change`는 사용자 정의 이벤트라 React의 `on...` 속성으로 받지 않습니다. ref에 `addEventListener`로 붙이고 정리 함수에서 뗍니다.

```jsx
function KitArea({ onChange, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    window.jk.init(root);
    const handle = (event) => onChange(event.detail);
    root.addEventListener("jk:change", handle);
    return () => root.removeEventListener("jk:change", handle);
  }, [onChange]);
  return <div ref={ref} className="jk">{children}</div>;
}
```

## 이름 규칙

- 클래스는 `jk-` 접두사, 토큰은 `--jk-` 접두사를 씁니다. 다른 프로젝트의 클래스나 토큰과 겹치지 않게 하려는 규칙입니다.
- 크기 변형은 `-xs`, `-s`, `-m`, `-l`, `-xl`을 붙입니다. 상태는 ARIA 속성(`aria-selected`, `aria-pressed`, `aria-expanded`, `aria-invalid`)이나 `is-` 클래스로 표시합니다.
- 색은 상태를 알릴 때만 씁니다. 주 동작과 완료는 초록, 진행 중은 노랑, 조건의 항목 이름은 갈색, 적용된 필터는 파랑, 숫자 강조는 청록, 필수 표시와 기한 지남은 빨강입니다.

## 동작 속성

`kit.js`는 `data-jk` 값에 따라 동작을 연결합니다. 상태가 바뀌면 해당 요소에서 `jk:change` 이벤트가 버블링되고, `event.detail`에 바뀐 값이 들어 있습니다.

| 속성 | 대상 | 동작 |
| --- | --- | --- |
| `data-jk="tabs"` | `role="tablist"` | 탭 선택, 패널 표시, 화살표·Home·End 이동 |
| `data-jk="disclosure"` | `aria-expanded`와 `aria-controls`가 있는 버튼 | 패널 펼침과 접힘. `aria-controls`에 id를 여러 개 적으면 모두 함께 접힙니다(목표 트리 표의 하위 행) |
| `data-jk="dialog"` | `aria-controls`로 `<dialog>`를 가리키는 버튼 | `showModal()`로 엽니다. 대화 상자 안의 `data-jk-close` 버튼이나 바깥 영역, Esc로 닫히고 초점은 연 버튼으로 돌아갑니다 |
| `data-jk="pressed"` | `aria-pressed` 버튼 묶음 | 각 버튼을 켜고 끕니다. `data-jk-mode="single"`이면 하나만 켜집니다 |
| `data-jk="tokens"` | `.jk-token` 묶음 | 토큰 지우기, 이웃 토큰이나 `data-jk-fallback` 요소로 초점 이동, `data-jk-status`가 가리키는 요소에 결과 안내 |
| `data-jk="listbox"` | `role="listbox"` | 항목 선택, 위아래 화살표·Enter·Space |
| `data-jk="count"` | `maxlength`가 있는 입력 | `data-jk-target`이 가리키는 요소에 글자 수 표시 |
| `data-jk-checkall="이름"` | 체크 상자 | 같은 `name`의 체크 상자를 모두 켜고 끄며, 일부만 켜지면 가로줄 상태 |
| `data-jk-bulk="이름"` | 일괄 처리 막대(`jk-bulkbar`) | 같은 `name`의 체크 상자가 하나라도 켜지면 나타나고, 안의 `data-jk-bulk-count`에 개수를 적습니다. `data-jk-bulk-clear` 버튼은 선택을 모두 풉니다 |
| `data-jk="cycle"` | `data-jk-values="값:글자,값:글자"`가 있는 상태 단추 | 누를 때마다 다음 값으로 바뀌고 `data-status`와 글자를 고칩니다 |
| `data-jk="append"` | 입력 하나가 있는 폼, 또는 단추 | `data-jk-template`의 `<template>`을 복제해 `data-jk-target` 끝에 붙입니다. 폼이면 입력값을 복제본의 `[data-jk-slot]`에 넣고 입력을 비웁니다. 빈 입력은 무시합니다 |
| `data-jk="validate"` | 폼 | 제출할 때 빈 `required` 항목에 `aria-invalid`를 달고, `aria-describedby`로 연결된 `[data-jk-error]` 문구를 보이고, 첫 항목으로 초점을 옮깁니다. 다 채우면 `jk:change`의 `detail.data`에 값을 담습니다 |

스위치, 점수 입력, 체크인, 이모지 평가, 선택 카드는 HTML 기본 입력(`checkbox`, `radio`)을 꾸민 것이라 스크립트가 필요 없습니다. 툴팁도 CSS만으로 hover와 초점에 나타납니다.

나중에 넣은 마크업은 `jk.init(요소)`로 연결합니다. 같은 요소를 두 번 넘겨도 한 번만 연결됩니다.

## 레이아웃

여러 열 배치는 모두 800px 아래에서 한 열로 쌓입니다. 측면과 처리 패널은 본문 아래로 내려갑니다.

| 클래스 | 배치 | 쓰는 곳 |
| --- | --- | --- |
| `jk-shell` | 왼쪽 메뉴 232px, 위쪽 막대 56px, 본문 | 앱 전체 틀. 좁은 화면에서는 메뉴가 위쪽 가로 스크롤 줄이 됩니다 |
| `jk-page` | 제목 줄과 본문, 최대 1080px | 본문 안 한 페이지. 제목은 `jk-page-title`, 메타 줄은 `jk-meta-line` |
| `jk-with-aside` | 본문과 오른쪽 측면 272px | 한 대상의 상세 정보와 요약 |
| `jk-master-detail` | 왼쪽 목록 300px과 상세 | 기록, 버전, 받은 편지함처럼 하나를 골라 보는 화면 |
| `jk-with-panel` | 본문과 오른쪽 처리 패널 300px | 요청 상세와 승인 단계 |
| `jk-form-preview` | 폼과 미리보기를 나란히 | 입력하면서 결과를 보는 화면, 모바일 화면 틀 `jk-phone` |
| `jk-board` | 왼쪽 메뉴 236px와 카드 격자 | 표시할 지표를 고르는 대시보드 |
| `jk-sticky-foot` | 스크롤 영역 아래에 붙는 동작 줄 | 긴 폼의 저장, 취소 |

## 꾸미기 (`decor.css`)

표지, 빈 화면, 소개 화면에만 쓰는 선택 파일입니다. `kit.css` 뒤에 붙입니다.

- 움직이는 배경 6종: `jk-fx-trail`(강조 테두리), `jk-fx-dots`(점 파동), `jk-fx-gradient`(부드러운 그라데이션), `jk-fx-spotlight`(스포트라이트), `jk-fx-rings`(동심원), `jk-fx-beams`(흐름선). 키트의 밝은 바탕과 카드 위에 그리고, 강조는 `--jk-primary`를 따르므로 `data-jk-theme`으로 색이 바뀝니다. 글 영역 쪽을 흐리게 덮으려면 무대에 `jk-fx-fade`를 더합니다.
- 시작 효과 3종: `jk-fx-stagger`(작업 행 순차 등장), `jk-fx-curtain`(테마 색 덮개 걷기), `jk-fx-reveal`(문장 드러내기). 무대에 `data-jk-entrance`를 붙이면 한 번 재생하고 마지막 장면에서 멈춥니다.
- 무대 `.jk-fx` 안에 그림(`.jk-fx-art`, `aria-hidden`, 오른쪽 장면은 `.jk-fx-scene`), 캡션(`.jk-fx-caption`: 표지 `.jk-fx-kicker`, 제목 `.jk-fx-title`, 설명), 재생 단추(`.jk-fx-control`, `data-jk="fx"`, `aria-controls`)를 둡니다. 속도는 `--jk-speed`, 높이는 `--jk-fx-height`로 바꿉니다.
- 효과는 스스로 재생하지 않습니다. 재생 중이어도 화면 밖에서는 멈추고, 동작 줄이기 설정에서는 배경이 멈추고 시작 효과는 완성된 모습으로 보입니다.
- 히어로 2종: `jk-hero`(가운데 정렬 메시지와 질문 입력 `jk-prompt`, `data-jk="typing"` + `data-jk-phrases`, 멈춤 단추 `data-jk="typing-toggle"`), `jk-hero-service`(왼쪽 정렬 약속 문장, 키트 주 버튼과 보조 버튼, 번호 바로 가기 `jk-anchor-list`).
- 소개 화면 블록 12종(`jk-lp-*`): 사이트 헤더와 메가 메뉴, 문제 제기 카드, 스크롤 따라 밝아지는 문단, 기능 소개와 제품 화면 틀, 겹쳐 놓은 답변 카드, FAQ, 칩 필터와 마커 썸네일, 고객 인용, 로고 띠, 세 기둥 카드, 마무리 CTA와 푸터, 가입 카드. 블록은 `.jk-lp`(흰 바탕) 또는 `.jk-lp jk-lp-soft`(회색 바탕)로 감싸고, 표지 `jk-lp-eyebrow`, 제목 `jk-lp-title`, 설명 `jk-lp-lead`, 단추 줄 `jk-lp-actions`를 공통으로 씁니다. 안의 단추, 표, 탭, 칩, 진행률은 키트 컴포넌트 그대로이고 강조는 `--jk-primary`를 따릅니다.
- 소개 블록용 동작: 메뉴는 `data-jk="disclosure" data-jk-dismiss`(Esc와 바깥 클릭으로 닫힘), FAQ 답은 `data-jk-animate`(부드럽게 펼침, 닫히면 초점이 들어가지 않음), 탭과 칩 필터는 `data-jk="filter"`와 `data-jk-filter-value` / `data-jk-filter`, 밝아지는 문단은 `data-jk="reveal"`과 `data-jk-reveal-line`, 가입 폼은 `data-jk="validate"`(이메일 형식도 검사, 성공 문구는 `data-jk-success`).

## 컴포넌트 목록

업무용 SaaS 제품 화면 13종의 캡처를 대조해 반복해서 나오는 형태만 골랐습니다. 특정 업무에 묶인 이름은 쓰지 않습니다.

- 기본: 버튼(주 동작, 그라데이션 주 동작, 회색 채움, 경고, 점선, 묶음), 태그(뜻별 채움 5색), 배지, 상태 알약, 칩, 아바타, 탭, 세그먼트, 기간 칩.
- 입력: 입력 필드, 선택 상자, 검색, 단위 입력, 체크 상자, 라디오, 스위치, 요일 선택, 선택 카드, 조건 문장, 필터 토큰, 필터 바, 상태별 개수 칩.
- 사람과 조직: 프로필 머리, 측면 정보, 사람 목록, 조직도(연결선), 들여쓰기 트리, 세로 도구 묶음.
- 데이터: 정보 행, 설정 행과 설정 카드, 표, 데이터 그리드(묶은 머리, 편집 칸), 문서 목록, 일괄 처리 막대.
- 지표: 지표 타일, 지표 카드, 꺾은선, 막대, 편차 막대, 등급 분포, 레이더, 범례, 데이터 툴팁, 진행률, 목표 상태 아이콘, 트리 표(`jk-tree-table`).
- 업무별: 점수 입력, 점수 타일(`jk-score-tiles`), 3×3 매트릭스, 금액 명세(`jk-statement`), 큰 금액, 날짜 넘기기, 달력, 주간 캘린더, 사람별 타임라인, 주간 배정표(`jk-slots`), 승인 라인 편집.
- 소통: 대화 상자, 편집 시트 머리, 툴팁, 안내 상자, 경고 띠, 추천 띠, 알림 목록, 알림 카드, 댓글과 반응, AI 요약, 체크인, 이모지 평가, 비공개 메모, 녹음 막대, 서식 도구 줄, 템플릿 변수, 멘션.
- 머리와 보조: 목록 머리(`jk-list-head`, 개수·보조 문구·오른쪽 동작), 상세 머리(`jk-detail-head`), 큰 제목과 메타 줄, 인라인 키-값 쌍(`jk-pairs`), 가린 값(`jk-mask`), 리더 별(`jk-star`), 도움말 단추(`jk-help`), 폼 패널(`jk-form-panel`)과 2열 선택지(`jk-options`), 모바일 머리(`jk-phone-head`), 갤러리(`jk-gallery`), 아이콘 두 줄 목록(`jk-icon-list`), 정의 목록 카드(`jk-def-cards`), 동작이 붙은 아코디언 행(`.has-action`), 순환하는 상태 단추.

## 토큰

키트 페이지의 기초 섹션이 토큰 기준표입니다. 값은 페이지가 `kit.css`에서 바로 읽어 표시합니다.

- 색: 제품 화면 회색과 상태색(`--jk-ink`부터 `--jk-pink`), 짙은 바탕 단계(`--jk-base`, `--jk-solid-4`~`72`, `--jk-block`), 강조색 14종(`--jk-accent-*`). 짙은 바탕과 강조색은 표지, 그림, 차트에만 쓰고 흰 바탕 본문 글자에는 쓰지 않습니다.
- 테마: `--jk-brand`, `--jk-brand-strong`, `--jk-brand-soft` 세 단계입니다. 감싸는 요소에 `data-jk-theme="blue|purple|lime|yellow|orange"`를 주면 바뀌고, 지정하지 않으면 초록입니다. 컴포넌트는 `--jk-primary` 슬롯(주 버튼, 선택한 체크 상자·스위치·토글, 초점 테두리, 큰 버튼 그라데이션)을 읽으므로 테마를 바꾸면 함께 바뀝니다. 완료, 증가, 승인처럼 뜻이 있는 초록은 테마와 관계없이 초록으로 남습니다. 밝은 테마(lime, yellow)는 주 버튼 글자를 짙은 색(`--jk-on-primary`)으로 바꿉니다.
- 글자: 표지·소개용 다섯 단계(`--jk-text-cover-xl` 80px부터 `--jk-text-h6` 24px)와 제품 화면용 여섯 단계(`--jk-text-sub` 22px부터 `--jk-text-caption` 11px).
- 간격 `--jk-space-1`~`12`(4px 단위), 모서리 `--jk-radius-xs`~`xl`, 그림자 `--jk-shadow-control|card|popover|float|modal`, 움직임 `--jk-ease-out|soft|spring`과 `--jk-fast`(150ms)·`--jk-open`(180ms)·`--jk-panel`(240ms).

## 색과 대비

초록은 제품 캡처의 버튼 색 `#0abe3a`를 그대로 씁니다. 이 초록 위 흰 글자는 대비가 약 2.6:1로 WCAG AA에 못 미치지만, 제품과 같은 색을 우선했습니다. 초록을 글자색으로 쓸 때는 `--jk-green-text`(`#0a7d17`)를 씁니다. 그 밖에 글자가 올라가는 색은 WCAG AA(본문 4.5:1)를 넘도록 어둡게 바꿨습니다. 보조 글자는 `#96999c`에서 `#6e7276`으로 바꿨고, 빨강·파랑·청록 글자와 노란 배지 글자도 같은 기준으로 맞췄습니다.

주 버튼은 두 형태입니다. 32·40px 버튼은 단색이고 hover에서 `#09a834`로 어두워집니다. 48px 버튼(`jk-btn-primary jk-btn-xl`)은 hover에서 `#00cb2e`→`#00c8ba` 그라데이션으로 바뀝니다. 차트 계열색, 근무 블록 바탕처럼 글자를 올리지 않는 채움색은 잰 값을 그대로 씁니다.

## 지킬 점

- 아이콘만 있는 버튼에는 `aria-label`을 붙이고, 장식 아이콘에는 `aria-hidden="true"`를 붙입니다.
- 필수 표시 빨간 점(`jk-required`)은 색으로만 뜻을 전하므로 라벨 안에 `<span class="jk-sr"> (필수)</span>`를 함께 둡니다.
- 표는 `.jk-table-wrap`으로 감싸 좁은 화면에서 표 영역만 가로로 스크롤하게 합니다. 감싼 요소에는 `tabindex="0"`과 `role="region"`, 이름을 붙여 키보드로도 스크롤할 수 있게 합니다.
- 키트는 밝은 화면만 정의합니다. 어두운 화면이 필요하면 `--jk-` 토큰을 다시 정의합니다.
