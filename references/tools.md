# 도구

명령의 `<skill>`은 설치된 스킬 폴더로 바꿉니다. 모든 선택지와 출력은 각 도구의 `--help`를 먼저 봅니다.
실행 위치와 저장 위치는 [작업 파일](workdir.md)을 따르며 직접 지정한 출력 경로가 우선입니다.
기존 브라우저 도구로 페이지를 살펴볼 수 있습니다. 확인 자료는 가능하면 함께 온 캡처 도구로 만듭니다.
도구는 임시 브라우저를 열며 사용자의 브라우저 자료를 건드리지 않습니다.
아래 스크립트는 `node <skill>/bin/jstyle.mjs <하위 명령>`으로도 부를 수 있으며 인자를 그대로 넘깁니다.
`shoot`은 `shoot.mjs`, `media`는 `curate-media.mjs`, `image`는 `prep-image.mjs`, `measure`는 `measure_reference.mjs`, `check`는 `check.mjs`입니다.
Node·브라우저·설치 위치는 `jstyle doctor`로 확인합니다.
설치된 jstyle의 업데이트는 `jstyle update`로 합니다. git으로 받은 폴더에서는 `git pull`을 씁니다.
Node 22 또는 Chrome·Chromium·Edge가 없으면 환경의 다른 브라우저 도구로 같은 자료를 남깁니다.

## 캡처와 녹화

만든 내용을 잠깐 볼 때는 현재 화면 한 장만 찍습니다. 몇 군데를 모아 고친 뒤 찍고, 바뀌지 않은 화면은 거듭 찍지 않습니다.
마치기 전이나 다른 사람에게 보여 줄 때는 보통 넓은 화면·휴대폰과 대표 동작 1~2개면 충분합니다.
실제 버튼을 `--steps`로 누릅니다. 캡처 때문에 `?state=...` 같은 경로를 제품에 새로 만들지 않습니다.
동작 뒤에 나타나는 상태가 여럿이면 한 줄에 `이름: 동작` 하나씩 적은 파일을 `--steps-file`로 넘깁니다. 묶음마다 페이지를 다시 열고, 열지 못한 묶음은 `report.json`에 `failed`로 남기며 나머지를 계속 찍습니다.
다음 작업에서도 같은 상태를 열어야 하면 이 파일을 테스트나 디자인 문서 옆처럼 Git에 남는 위치에 둡니다. `.jstyle`은 Git에서 빠집니다.
sticky 헤더나 `100vh`·resize 감시가 있는 작업 화면에는 `--full`을 쓰지 않습니다.
움직임은 기본적으로 시간 표시가 있는 `--frames`나 실제 조작으로 봅니다.
실제 속도의 느낌을 판단해야 하고 영상을 재생할 수 있을 때만 `--record`를 씁니다.
한꺼번에 자료가 필요하면 `--evidence --frames <개수>`를 쓸 수 있습니다.
바뀐 부분의 자료만 다시 만들고, 그대로인 자료는 이전 것을 쓴다고 알립니다.

```text
node <skill>/scripts/shoot.mjs index.html --size desktop,mobile --out shots
node <skill>/scripts/shoot.mjs index.html --selector ".card" --out shots
node <skill>/scripts/shoot.mjs index.html --steps "click .open; wait 300" --out shots
node <skill>/scripts/shoot.mjs index.html --steps-file design/states.txt --out shots
node <skill>/scripts/shoot.mjs index.html --frames 8 --steps "scroll 600; scroll 600" --out shots
node <skill>/scripts/shoot.mjs index.html --mark "1=.page-head .btn; 2=.toggle-row" --out shots
node <skill>/scripts/shoot.mjs --stitch before.png --label 이전 --stitch after.png --label 이후 --out shots
```

여러 HTML이나 폴더를 한 번에 입력하면 같은 브라우저에서 찍고 `sheet.png`를 만듭니다.
`--mask`는 글자를 가리고 `--sheet`는 상태를 나란히 놓습니다.
`--match-width`는 공통 물체의 원본 픽셀 너비, `--scale`은 알려진 배율, `--crop`은 크기를 맞춘 뒤의 자를 영역입니다.
같은 물체의 크기를 맞추지 않고 이미지를 각각 같은 너비로 줄여 비교하지 않습니다.
실제 저장·새로고침 후 읽기·실패 복구는 원래 화면의 입구에서 실행합니다.
입력과 클릭의 정확한 문법은 `--help`를 보고, 필요하면 `--dry-run`으로 브라우저를 열지 않고 확인합니다.
시간 초과 때는 도구가 한 번 더 시도합니다. 다시 실패하면 나온 명령과 원인을 알립니다.

## 실제 이미지 찾기

검색부터 받기까지 같은 작업 폴더에서 실행해야 결과 번호가 이어집니다.

```text
node <skill>/scripts/curate-media.mjs search "<검색어>" --kind texture --limit 6 --sheet --dir candidates
node <skill>/scripts/curate-media.mjs search "<검색어 묶음> | <다른 묶음>" --sheet --dir candidates
node <skill>/scripts/curate-media.mjs preview V1,T2 --sheet --dir candidates
node <skill>/scripts/curate-media.mjs fetch C1,T2 --dir assets --sheet
node <skill>/scripts/curate-media.mjs fetch T2 --maps all --resolution 1k --dir assets
```

`--kind`는 `all|texture|design|photo|blueprint|map|plate|science|video`입니다.
자료는 Poly Haven, 박물관·도서관 공개 자료, NASA 등에서 찾습니다. 제공처별 범위는 `--help`를 봅니다.
`all`은 여러 제공처를 섞고 `|`는 검색어 묶음을 나눕니다.
결과 번호는 `.curate-cache.json`에 보관합니다. `use=page`는 페이지에 쓸 수 있고, `check`는 원본을 먼저 봐야 하며, `reference`는 참고로만 씁니다.
CC BY/BY-SA의 이름 표시 의무를 지킵니다. `--use page`는 페이지용 결과만 남깁니다.
`search --sheet`와 `preview`는 번호·사용 범위·원본 크기가 담긴 PNG와 HTML 모음을 만듭니다.
제목만 보고 고르지 말고 실제 이미지를 봅니다. `look`의 가장자리 색·밝은 바탕·글을 놓을 빈 곳도 살펴봅니다.
`fetch --sheet`는 로컬 결과를 완전히 읽어 크기를 확인하고 영상의 첫 프레임도 만듭니다.
텍스처는 기본 1k Diffuse이며 `--maps all`은 Roughness와 OpenGL Normal JPG까지 크기와 MD5를 확인합니다.
받은 파일과 poster의 출처는 같은 폴더의 `SOURCES.md`에 남습니다.

```text
node <skill>/scripts/curate-media.mjs fetch "<URL>" --out assets/image.png --note "출처 설명"
```

## 결과 살펴보기

기본 상태가 로딩을 끝냈고 글자 가리기가 도형까지 덮지 않았는지 직접 봅니다.
정지한 마지막 상태는 최종 캡처로, 움직이는 과정은 해당 연속 그림이나 실제 조작으로 판단합니다.
빈 WebGL 캡처를 확인 근거로 쓰지 않습니다.
직접 브라우저 스크립트를 쓸 때는 임시 프로필과 `--use-mock-keychain --password-store=basic`을 씁니다.
도구는 다음을 `lint`에 적습니다.

- 읽기: WCAG AA에 못 미치는 글 대비(본문 4.5:1, 큰 글자 3:1), 11px 미만 본문, 좁은 줄 간격, 투명한 채 멈춘 첫 화면
- 배치: 말줄임표 없이 잘린 글자, 첫 화면에서 다른 글과 줄이 맞지 않는 왼쪽 시작점
- 조작: 24px보다 작고 주변 간격도 좁은 클릭 대상, 서로 겹친 클릭 대상
- 키트: 키트를 쓰는 화면에서 키트 색에 없는 글자·바탕·테두리 색. 스타일을 넣지 않은 브라우저 기본 링크·버튼 색도 여기에 나옵니다.
- 일관성: 키트를 쓰지 않는 화면에서 한 페이지에 쓰인 글자 크기가 12종 이상이거나 버튼 높이가 5종 이상인 경우. 사이트 평가의 [시각 기준](eval/visual.md)과 같은 집계(`style-audit.js`)를 씁니다. 키트를 쓰는 화면은 키트 자체의 크기 종류가 많아 세지 않고 `jstyle check`로 봅니다.

키트 주색 위의 `--jk-on-primary` 글자는 키트가 정한 대비 예외라 적지 않습니다. 글자가 없는 채움(아이콘 타일, 차트 막대)과 `--jk-hue`처럼 키트 컴포넌트가 정한 자리로 고른 색도 적지 않습니다.
`lint` 항목은 고칠 후보입니다. 취소된 항목처럼 일부러 흐리게 둔 글은 까닭을 결과에 적고 남길 수 있습니다.
경고가 없어도 실제 이미지를 봐야 합니다. 화면과 무관한 401·404 때문에 로그인이나 API 코드를 고치지 않습니다.

## 스타일 규칙 검사

`jstyle check <화면 폴더>`는 브라우저 없이 스타일시트와 `<style>`, 마크업의 `style` 속성을 읽어 규칙을 어긴 곳을 줄 번호와 함께 적습니다. 마크업과 js·jsx·ts·tsx에서는 `class`·`className`·`classList`에 적은 `jk-` 클래스 이름을 읽습니다.
스타일만 있는 폴더가 아니라 마크업과 스크립트가 함께 있는 폴더를 줍니다. 키트 사용은 그 안의 `kit.css` 사본, `--jk-` 토큰, `jk-` 클래스로 판단하고 근거를 요약 줄에 적습니다. `--exclude`로 건너뛴 폴더의 사본도 근거로 봅니다. "키트 사용 안 함"으로 잘못 나오면 `--kit`을 붙입니다.
키트를 쓰는 프로젝트에서는 `--jk-*` 토큰 재정의, 직접 쓴 색, 6px 이상 모서리(px·rem), 키트에 없는 `jk-` 클래스를 오류로 봅니다. 키트에 없는 글자 크기, 직접 정한 글꼴, 제품이 만든 색 토큰은 경고입니다.
제품 스타일시트가 키트 클래스의 높이·안쪽 여백·글자·색·테두리·그림자를 바꾼 곳도 경고(`kit-restyle`)입니다. 너비와 바깥 여백 같은 배치는 보지 않습니다. 키트의 크기·모양 변형을 먼저 찾고, 없으면 제품 클래스를 따로 만듭니다.
안쪽·바깥 여백과 `gap`에 키트 간격 척도(`--jk-space-*`, 2~48px)에 없는 값을 쓴 곳도 경고(`raw-spacing`)입니다. 48px보다 큰 값, 음수, `calc()`는 보지 않습니다.
`style` 속성에서는 `--jk-hue`처럼 `--`로 시작하는 값과 키트 페이지가 인라인으로 쓰는 값을 허용하고, `<svg>` 안의 `style`은 읽지 않습니다. 키트 페이지의 마크업을 그대로 옮긴 화면은 걸리지 않습니다.
같은 규칙의 경고는 다섯 건까지 적고 나머지는 개수로 적습니다. 이번에 바꾼 줄의 경고가 줄여 적힌 쪽에 있을 수 있으므로, 개수 줄이 나오면 `--json`의 `findings`에서 바꾼 파일과 줄을 찾습니다.
`data-jk-theme`·`data-jk-scheme`에 키트가 정하지 않은 값(예: `bleu`, `drak`)을 적으면 오류(`unknown-theme`, `unknown-scheme`)입니다. 마크업 속성, JSX 속성, `setAttribute()`에 직접 쓴 값을 읽고, 스크립트 문자열 안의 `data-jk-theme="…"` 같은 글자도 속성으로 읽습니다. 변수로 넘긴 값은 읽지 않습니다. 따옴표 없는 값은 공백, 태그 끝, `]`까지 읽으므로 `blue.foo`는 `blue`로 보지 않고, `[data-jk-theme=blue]` 같은 선택자는 `blue`로 읽습니다. 키트 클래스가 값으로 칠하는 속성도 봅니다. 예를 들어 `jk-status`와 같은 태그의 `data-status`가 `doing`·`todo`·`done` 밖이면 오류(`unknown-value`)입니다. 키트 클래스가 없는 요소의 같은 속성은 보지 않습니다. 검사 폴더에 키트 사본이 있으면, 설치된 키트는 칠하지만 사본은 칠하지 않는 값도 오류(`missing-in-copy`)로 보고 다시 복사할 파일을 알려 줍니다. 테마와 스킴은 키트 사본만 봅니다. 제품 스타일시트의 `[data-jk-theme=purple] .logo`는 그 테마의 토큰을 정하지 않기 때문입니다. `.jk-status[data-status=done]`처럼 키트 클래스와 값을 함께 칠한 제품 규칙은 칠한 것으로 봅니다. 스타일이나 스크립트 안의 `[data-jk-theme=…]` 선택자는 값을 정하지 않으므로 오타만 보고 사본과 대조하지 않습니다.
`var(--jk-…)`로 읽는 토큰이 키트 어디에도 없으면 오류(`unknown-token`)이고, 설치된 키트에는 있지만 프로젝트의 사본에는 없으면 `missing-in-copy`입니다. 대체값을 함께 쓴 `var(--jk-x, 4px)`는 보지 않습니다. 키트 사본끼리도 봅니다. `decor.css` 사본이 읽는 토큰을 `kit.css` 사본이 정하지 않으면 그 사본에 `missing-in-copy`를 하나 적습니다.
오류마다 같은 값이나 가장 가까운 키트 토큰을 알려 줍니다. 가까운 토큰의 색이 눈에 띄게 다르면 역할이 맞는 토큰을 고릅니다.
없는 클래스는 설치된 키트, 프로젝트의 키트 사본, 검사한 스타일시트 어디에도 선택자가 없는 이름입니다. 오타는 가장 가까운 이름을 알려 줍니다. `className={…}` 표현식, `clsx`·`classNames`·`cn`·`cx` 호출, Vue의 `:class`, `${…}` 안의 문자열도 읽습니다. `jk-btn-${size}`처럼 조합한 이름은 그 형태에 맞는 클래스가 하나도 없을 때만 오류입니다. 변수에 담아 넘긴 이름은 읽지 않습니다. 마크업의 `<!-- -->` 주석에 적은 클래스와 `style`은 읽지 않습니다. 스크립트의 주석은 코드와 구분하지 않고 읽습니다. JavaScript를 해석하지 않고는 주석을 `//`나 `/*`가 든 문자열·정규식과 가려낼 수 없고, 잘못 지우면 실제 클래스를 놓쳐 키트 프로젝트가 통과하기 때문입니다. 주석의 예시 클래스가 오류로 나오면 그 이름을 고칩니다.
검사 폴더에 키트 사본이 있으면 설치된 키트에는 있지만 사본에는 없는 클래스도 오류(`missing-in-copy`)로 보고, 다시 복사할 파일을 알려 줍니다. `decor.css`를 붙이지 않고 소개 블록 클래스를 쓴 경우가 여기에 나옵니다.
키트 사본의 `--jk-` 토큰 값이 설치된 키트와 다르면 사본마다 경고 하나(`copy-differs`)를 적습니다. 버전이 다른 사본인지 직접 고친 사본인지는 구분하지 못하므로 다른 토큰 이름을 보고 판단합니다.
키트를 쓰지 않는 프로젝트에서는 토큰 정의 밖에서 직접 쓴 색만 경고합니다. `--tokens <토큰 파일>`을 주면 그 파일의 CSS 변수를 기준으로 삼아 직접 쓴 색과 모서리를 오류로, 토큰에 없는 글자 크기와 간격을 경고로 봅니다. 색은 hex 값만 읽고, 모서리는 이름에 `radius`가, 글자 크기는 `font-size`나 `text`가, 간격은 `spac`이 들어간 변수를 읽습니다. 기존 화면을 고칠 때는 이번에 바꾼 파일의 새 결과만 고치고, 원래 있던 경고를 한꺼번에 정리하지 않습니다.
JavaScript가 넣는 스타일과 JSX의 `style={{…}}`는 읽지 않으므로 그런 화면은 캡처로 확인합니다.
키트를 쓰는 저장소의 `AGENTS.md`·`CLAUDE.md`·Makefile·package.json·pre-commit·CI에 `jstyle check`가 없으면 요약 뒤에 알림을 적습니다. 종료 코드는 바꾸지 않으며 `--json`에서는 `wired`가 `false`입니다. 연결하는 방법은 [컴포넌트 키트](extended/kit.md)의 "붙이는 방법"에 있습니다.

```text
node <skill>/bin/jstyle.mjs check web/ --exclude vendor
node <skill>/bin/jstyle.mjs check src/ --tokens src/styles/tokens.css
```

## 사이트 평가 자료

`jstyle eval`은 [사이트 평가](eval/site-eval.md)의 근거를 남깁니다. 공개된 주소를 임시 브라우저로 열고 보기만 합니다.
누르기·입력·제출·로그인을 하지 않고, `robots.txt`의 금지 경로를 건너뛰며, 같은 사이트 요청 사이를 1초 띄웁니다.
768px 미만은 터치·휴대폰 UA·DPR 3으로 휴대폰을 흉내 냅니다. 캡처 도구의 `<600` 기준과 다릅니다.

```text
node <skill>/bin/jstyle.mjs eval https://example.com /pricing /signup --mode site --funnel /pricing,/signup --keyboard
node <skill>/bin/jstyle.mjs eval https://example.com --mode quick --dark --links
node <skill>/bin/jstyle.mjs eval https://example.com --dry-run
```

너비마다 `layout-detect.js`를 실행하고, 1440·375에서 첫 화면 캡처·`fold-check.js`·axe·전체 캡처를 남깁니다.
1440에서는 head 정보·임시 글·`form-audit.js`·`style-audit.js`·`perf-capture.js`도 남깁니다. `quick`은 시작 페이지만 깊게 봅니다.
결과는 출력 폴더의 `evidence.json`과 PNG입니다. `gates`는 차단 조건의 단서이고 `coverage`는 보지 못한 범위입니다.
페이지 목록은 평가하는 사람이 정합니다. 도구는 사이트를 훑어 페이지를 찾지 않습니다.
`--keyboard`는 시작·전환 페이지 1440에서 Tab을 눌러 초점 순서, 초점 표시가 없어 보이는 요소(잘라 낸 캡처), 화면 밖 초점, 본문 바로가기, 갇힘을 `keyboard`에 남깁니다.
Escape로 닫기, 메뉴 열기, INP를 위한 조작, 로그인된 앱은 환경의 브라우저 도구로 하고 `scripts/eval/*.js`를 붙여 넣어 같은 값을 얻습니다.
axe-core는 실행할 때 cdnjs에서 페이지로 받아 옵니다. CSP가 막으면 `axe.error`에 남습니다.
`--dark`의 `darkScheme`은 1440 첫 화면의 배경·글자색이 밝은 모드와 달라졌는지입니다. `false`면 사이트가 어두운 모드를 지원하지 않으므로 어두운 캡처로 L4를 보지 않습니다.

## 직접 다룰 수 있는 시안

기존 프로젝트의 컴포넌트·아이콘·스타일·기술을 먼저 씁니다. 새 도구를 반드시 더할 필요는 없습니다.
독립 시안은 보통 `index.html` 하나에 HTML·style·script를 모읍니다.
필요한 색·글자·간격·모서리 값을 CSS 변수로 정하고, 별도 빌드 체인을 더하지 않습니다.
최종 HTML이 쓰는 로컬 파일은 정식 위치에 두고, 작업 폴더의 임시 의존성을 그대로 연결하지 않습니다.
