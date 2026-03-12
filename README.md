# KRIBB Meal Bot

KRIBB 인트라넷 식단을 텔레그램으로 보내주는 봇.

## 어떻게 동작해?

KRIBB 내부망에서 텔레그램이 막혀있어서, Google Apps Script를 중간 다리로 씀.

```
WSL (KRIBB 내부망)              Google Apps Script             Telegram
cron 08:00 → 크롤링 → POST →   저장
                                11:00 점심 자동 전송 ────────→ 구독자
                                17:30 저녁 자동 전송 ────────→ 구독자
                                19:00 데이터 삭제
                                사용자 명령 즉시 응답 ←──────→ /lunch /dinner /meal
```

## 파일

| 파일 | 설명 |
|------|------|
| `kribb-meal-bot.mjs` | WSL에서 실행. 크롤링 + Apps Script 전송 |
| `apps-script-code.js` | Google Apps Script에 올릴 코드 |

## 세팅 (처음 한 번)

### 1. 텔레그램 봇 만들기

텔레그램에서 `@BotFather` → `/newbot` → Bot Token 복사

### 2. .env 만들기

```
KRIBB_ID=인트라넷아이디
KRIBB_PW=인트라넷비밀번호
APPS_SCRIPT_URL=나중에채움
```

### 3. Google Apps Script 배포

1. [script.google.com](https://script.google.com) → 새 프로젝트
2. GitHub `apps-script-code.js` → Raw → 전체 복사 → 붙여넣기
3. 1번째 줄 `'YOUR_BOT_TOKEN'`을 봇 토큰으로 교체
4. Ctrl+S 저장
5. 배포 → 새 배포 → 웹 앱 → 모든 사용자 → 배포
6. 웹 앱 URL → `.env`의 `APPS_SCRIPT_URL`에 입력
7. 함수 드롭다운 → **`setup`** → 실행 → `Setup complete` 확인
8. 브라우저에서 웹훅 설정:
   ```
   https://api.telegram.org/bot봇토큰/setWebhook?url=웹앱URL
   ```
   `{"ok":true}` 나오면 성공

### 4. 테스트

```bash
cd /mnt/d/_workspace/prototype

# 크롤링 + 데이터 업로드
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs

# 텔레그램에서 /test → 식단 미리보기 확인
# 텔레그램에서 /meal → 전체 식단 확인
```

### 5. cron 등록 (평일 08:00)

```bash
crontab -e
```

```
0 8 * * 1-5 cd /mnt/d/_workspace/prototype && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
```

## 텔레그램 명령어

| 명령어 | 내용 |
|--------|------|
| `/start` | 봇 소개 |
| `/lunch` | 점심 (11:30~13:00) |
| `/dinner` | 저녁 (18:00~19:00) |
| `/meal` | 전체 식단 |
| `/test` | 브로드캐스트 미리보기 |

## 자동 스케줄

| 시간 | 동작 |
|------|------|
| 08:00 | WSL cron → 크롤링 + 데이터 업로드 |
| 11:00 | 점심 메뉴 자동 전송 |
| 17:30 | 저녁 메뉴 자동 전송 |
| 19:00 | 데이터 삭제 |

## 문제 해결

**libnspr4.so 에러** — `LD_LIBRARY_PATH="/home/gml/miniforge3/lib"` 붙이기

**Apps Script 코드 수정 후** — 저장만으로 안 됨. 배포 관리 → 연필 아이콘 → 버전 "새 버전" → 배포. `setup` 재실행 불필요 (재실행하면 웹훅이 삭제됨). URL이 바뀐 경우만 .env + 웹훅 재설정.

**봇이 응답 안 함** — Apps Script 트리거 탭에서 `tick`이 1분 간격 등록 확인. 없으면 `setup` 재실행.

**Not yet updated** — WSL에서 크롤링 스크립트 실행: `LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs`
