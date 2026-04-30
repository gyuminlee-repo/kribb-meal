<!-- AUTO-GENERATED from CLAUDE.md by claude2codex.sh on 2026-04-30 -->
<!-- Source: /mnt/d/_workspace/cc/kribb-meal/.claude/CLAUDE.md -->
<!-- 편집은 CLAUDE.md를 수정하고 스크립트를 재실행. 직접 편집 금지. -->

# KRIBB Meal Bot

## Project
- KRIBB 구내식당 식단 크롤러 + 텔레그램 봇
- Playwright로 식단 페이지 크롤링 → Google Apps Script 백엔드 → 텔레그램 전송
- WSL2 cron으로 평일 자동 실행

## Git Convention
- Commit message format: `vX.X: summary in English`
- Minor (+0.1): bug fixes, small improvements
- Major (+1.0): major feature changes

## Code Security
- No hardcoded credentials (API keys, tokens) in code
- Use environment variables for secrets
- `.env` files must be in `.gitignore`

## Language
- Always respond in Korean
