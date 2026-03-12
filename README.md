# KRIBB Meal Bot

KRIBB 인트라넷 식단을 자동 크롤링하여 텔레그램 봇으로 배포하는 시스템.

## 구조

```
[KRIBB 내부망 WSL]                    [Google Apps Script]         [Telegram]
cron 08:30 → Playwright 크롤링         1분마다 폴링
  → Apps Script에 POST ──────────→    → 명령어 응답 ──────────→  사용자
    (식단 데이터 전달)                   → 브로드캐스트              /breakfast
                                                                   /lunch
                                                                   /dinner
                                                                   /meal
```

- KRIBB 내부망에서 `api.telegram.org`이 차단되어 있어 Google Apps Script를 중계 서버로 사용
- WSL에서 Playwright로 인트라넷 로그인 + 크롤링 → Apps Script에 데이터 전송
- Apps Script가 텔레그램 봇 메시지 폴링 및 응답 처리

## 파일 구성

| 파일 | 설명 |
|------|------|
| `kribb-meal-bot.mjs` | 메인 스크립트. 크롤링 + Apps Script 전송 + 스케줄러 |
| `kribb-meal-check.mjs` | 크롤링 단독 실행 (디버그/확인용) |
| `apps-script-code.js` | Google Apps Script에 배포할 코드 |

## 세팅 가이드

### 1. 사전 요구사항

- Node.js 20+
- Playwright (`npm install playwright`)
- Playwright Chromium 브라우저 (`npx playwright install chromium`)
- WSL2 환경 (KRIBB 내부망 접속 필요)
- Google 계정 (Apps Script용)
- 텔레그램 계정

### 2. 환경변수 설정

프로젝트 루트(또는 실행 디렉토리)에 `.env` 파일 생성:

```
KRIBB_ID=인트라넷아이디
KRIBB_PW=인트라넷비밀번호
APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXXX/exec
```

### 3. 텔레그램 봇 생성

1. 텔레그램에서 `@BotFather` 검색 → `/newbot`
2. 봇 이름/username 설정
3. 발급된 **Bot Token** 복사 (Apps Script 코드에 사용)

### 4. Google Apps Script 배포

1. [script.google.com](https://script.google.com) 접속
2. 새 프로젝트 생성 → 이름: `KRIBB-Meal-Bot`
3. `apps-script-code.js` 내용을 전체 복사하여 붙여넣기
   - GitHub Raw 버튼으로 복사하면 인코딩 문제 방지
4. 1번째 줄 `'YOUR_BOT_TOKEN'`을 실제 봇 토큰으로 교체
5. **Ctrl+S** 저장
6. **배포** → **새 배포** → 유형: **웹 앱** → 액세스: **모든 사용자** → **배포**
7. 발급된 웹 앱 URL을 `.env`의 `APPS_SCRIPT_URL`에 입력
8. 상단 함수 드롭다운에서 **`setup`** 선택 → **▶ 실행**
   - 권한 승인 팝업이 나오면 허용
   - 실행 로그에 `Setup complete`가 나오면 성공
   - `setup`은 기존 웹훅을 제거하고, 1분 간격 폴링 트리거를 등록함

### 5. 동작 확인

```bash
# 식단 크롤링 + Apps Script 데이터 업데이트 (브로드캐스트 없음)
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs test

# 텔레그램에서 봇에게 /meal 전송 → 1분 내 응답 확인
```

### 6. cron 자동화 (평일 08:30)

```bash
crontab -e
```

아래 줄 추가:

```
30 8 * * 1-5 cd /mnt/d/_workspace/prototype && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs send >> /tmp/kribb-meal-bot.log 2>&1
```

## 사용법

### CLI 명령어

```bash
# 크롤링 + 모든 구독자에게 브로드캐스트
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs send

# 크롤링 + 데이터 업데이트만 (브로드캐스트 없음)
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs test

# 스케줄러 모드 (상시 실행, 평일 08:30 자동 전송)
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs

# 크롤링만 단독 실행 (터미널 출력)
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-check.mjs
```

### 텔레그램 봇 명령어

| 명령어 | 설명 |
|--------|------|
| `/start` | 봇 소개 및 명령어 안내 |
| `/breakfast` | 조식 메뉴 |
| `/lunch` | 중식 메뉴 |
| `/dinner` | 석식 메뉴 |
| `/meal` | 전체 식단 |

## 트러블슈팅

### Playwright 실행 시 `libnspr4.so` 에러
```bash
# conda에 설치된 라이브러리 경로를 지정해야 함
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs test
```

### Apps Script 배포 후 코드 수정 시
코드 수정 후 **저장만으로는 반영되지 않음**. 반드시 **배포 → 새 배포**로 재배포 필요.

### 텔레그램 봇이 응답하지 않는 경우
1. Apps Script에서 **트리거 탭** (시계 아이콘) 확인 → `pollMessages`가 1분 간격으로 등록되어 있는지
2. 없으면 함수 드롭다운에서 `setup` 선택 → 실행
3. `pollMessages`를 직접 실행하여 실행 로그 확인
