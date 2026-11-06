# 도구

명령의 `<skill>`은 설치된 스킬 폴더로 바꿉니다. 모든 선택지와 출력은 각 도구의 `--help`를 먼저 봅니다.
실행 위치와 저장 위치는 [작업 파일](workdir.md)을 따르며 직접 지정한 출력 경로가 우선입니다.
기존 브라우저 도구로 페이지를 살펴볼 수 있습니다. 확인 자료는 가능하면 함께 온 캡처 도구로 만듭니다.
도구는 임시 브라우저를 열며 사용자의 브라우저 자료를 건드리지 않습니다.
아래 스크립트는 `node <skill>/bin/jstyle.mjs <하위 명령>`으로도 부를 수 있으며 인자를 그대로 넘깁니다.
`shoot`은 `shoot.mjs`, `media`는 `curate-media.mjs`, `image`는 `prep-image.mjs`, `measure`는 `measure_reference.mjs`입니다.
Node·브라우저·설치 위치는 `jstyle doctor`로 확인합니다.
Node 22 또는 Chrome·Chromium·Edge가 없으면 환경의 다른 브라우저 도구로 같은 자료를 남깁니다.

## 캡처와 녹화

만든 내용을 잠깐 볼 때는 현재 화면 한 장만 찍습니다. 몇 군데를 모아 고친 뒤 찍고, 바뀌지 않은 화면은 거듭 찍지 않습니다.
마치기 전이나 다른 사람에게 보여 줄 때는 보통 넓은 화면·휴대폰과 대표 동작 1~2개면 충분합니다.
실제 버튼을 `--steps`로 누릅니다. 캡처 때문에 `?state=...` 같은 경로를 제품에 새로 만들지 않습니다.
sticky 헤더나 `100vh`·resize 감시가 있는 작업 화면에는 `--full`을 쓰지 않습니다.
움직임은 기본적으로 시간 표시가 있는 `--frames`나 실제 조작으로 봅니다.
실제 속도의 느낌을 판단해야 하고 영상을 재생할 수 있을 때만 `--record`를 씁니다.
한꺼번에 자료가 필요하면 `--evidence --frames <개수>`를 쓸 수 있습니다.
바뀐 부분의 자료만 다시 만들고, 그대로인 자료는 이전 것을 쓴다고 알립니다.

```text
node <skill>/scripts/shoot.mjs index.html --size desktop,mobile --out shots
node <skill>/scripts/shoot.mjs index.html --selector ".card" --out shots
node <skill>/scripts/shoot.mjs index.html --steps "click .open; wait 300" --out shots
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
도구는 글 대비, 11px 미만 본문, 좁은 줄 간격, 투명한 채 멈춘 첫 화면을 `lint`에 적습니다.
경고가 없어도 실제 이미지를 봐야 합니다. 화면과 무관한 401·404 때문에 로그인이나 API 코드를 고치지 않습니다.

## 직접 다룰 수 있는 시안

기존 프로젝트의 컴포넌트·아이콘·스타일·기술을 먼저 씁니다. 새 도구를 반드시 더할 필요는 없습니다.
독립 시안은 보통 `index.html` 하나에 HTML·style·script를 모읍니다.
필요한 색·글자·간격·모서리 값을 CSS 변수로 정하고, 별도 빌드 체인을 더하지 않습니다.
최종 HTML이 쓰는 로컬 파일은 정식 위치에 두고, 작업 폴더의 임시 의존성을 그대로 연결하지 않습니다.
