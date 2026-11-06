PYTHON ?= python3
HOST ?= 0.0.0.0
PORT ?= 8765
SERVE = $(PYTHON) scripts/serve.py --host $(HOST) --port $(PORT)

.DEFAULT_GOAL := help
.PHONY: help open effects cards landing product-ui kit explorer serve test

help: ## 사용 가능한 명령 표시
	@awk 'BEGIN {FS = ":.*## "} /^[a-z-]+:.*## / {printf "  make %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo "  변수: HOST=$(HOST) (127.0.0.1이면 이 컴퓨터에서만 접속), PORT=$(PORT)"

open: ## 패턴 라이브러리 열기
	@$(SERVE) assets/extended/index.html

effects: ## 꾸미기·시작 효과 보기 열기
	@$(SERVE) 'assets/extended/index.html#effects'

cards: ## 카드 패턴 보기 열기
	@$(SERVE) 'assets/extended/index.html#cards'

landing: ## 랜딩 연구 보기 열기
	@$(SERVE) 'assets/extended/index.html#landing'

product-ui: ## 제품 UI 연구 보기 열기
	@$(SERVE) 'assets/extended/index.html#product-ui'

kit: ## 컴포넌트 키트 열기
	@$(SERVE) assets/kit/index.html

explorer: ## 스타일 탐색기 열기
	@$(SERVE) assets/style-explorer.html

serve: ## 브라우저를 열지 않고 서버만 실행
	@$(SERVE) --no-open

test: ## 패턴과 리소스 테스트 실행
	node --check assets/extended/patterns.js
	node --check assets/kit/kit.js
	node --test tests/test_extended_patterns.mjs tests/test_kit.mjs
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py'
