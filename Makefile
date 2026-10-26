.PHONY: venv data test build synth deploy seed smoke ui-check publish-knowledge insights-smoke insights-ui-check teardown teardown-all

PY := .venv/bin/python

venv:            ## local Python env for tests/seed
	python3 -m venv .venv && $(PY) -m pip install -q -r requirements-dev.txt

data:            ## regenerate synthetic data + keyword index
	$(PY) data/generate.py && $(PY) data/build_index.py

test: data       ## offline unit tests (domain logic, interceptor)
	$(PY) -m pytest -q tests/test_domain.py tests/test_interceptor.py

build:           ## ARM64 runtime zips + Lambda bundles
	scripts/build.sh

synth: build
	cd infra && npx cdk synth --quiet

deploy:          ## preflight, build, bootstrap, deploy all stacks, seed data
	scripts/deploy.sh

seed:
	$(PY) scripts/seed.py

smoke:           ## CI-style end-to-end checks against the live deployment
	$(PY) -m pytest -v tests/test_smoke.py

ui-check:        ## headless browser: login at https://www.awsteach.com and complete a chat
	cd tests/ui && npm ci --no-audit --no-fund >/dev/null && node ui_check.mjs

publish-knowledge: ## regenerate projectknowledge.md from live AWS state + publish it and the source snapshot
	$(PY) scripts/publish_knowledge.py

insights-smoke:  ## live checks for TrialScout Insights (auth, API, chatbot, redaction, invocation logs)
	$(PY) -m pytest -v tests/test_insights_smoke.py

insights-ui-check: ## headless browser: login at https://insights.awsteach.com, tabs + chatbot
	cd tests/ui && npm ci --no-audit --no-fund >/dev/null && node insights_ui_check.mjs

teardown:        ## delete all TrialScout stacks + sweep leftovers (keeps CDK bootstrap)
	scripts/teardown.sh

teardown-all:    ## ...and the TrialScout-CDKToolkit bootstrap + its retained bucket
	scripts/teardown.sh --include-bootstrap
