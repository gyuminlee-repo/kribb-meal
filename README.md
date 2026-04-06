# KRIBB Meal Bot

KRIBB 인트라넷 식단을 텔레그램으로 보내주는 봇.

## 어떻게 동작해?

KRIBB 내부망에서 텔레그램이 막혀있어서, Google Apps Script를 중간 다리로 씀.

```
WSL (KRIBB 내부망)              Google Apps Script             Telegram
cron 08:25 → 크롤링 → POST →   저장
                                사용자별 시간에 자동 전송 ──→ 구독자 (기본 11:00/17:30)
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
SHARED_SECRET=랜덤문자열(아래참조)
```

`SHARED_SECRET`은 크롤러↔GAS 간 인증에 사용한다. 아래 명령으로 생성:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Google Apps Script 배포

1. [script.google.com](https://script.google.com) → 새 프로젝트
2. GitHub `apps-script-code.js` → Raw → 전체 복사 → 붙여넣기
3. 1번째 줄 `'YOUR_BOT_TOKEN'`을 봇 토큰으로 교체
4. 왼쪽 톱니바퀴(프로젝트 설정) → **스크립트 속성** → 속성 추가
   - `SHARED_SECRET` = `.env`의 `SHARED_SECRET`과 동일한 값
5. Ctrl+S 저장
6. 배포 → 새 배포 → 웹 앱 → 모든 사용자 → 배포
7. 웹 앱 URL → `.env`의 `APPS_SCRIPT_URL`에 입력
8. 함수 드롭다운 → **`setup`** → 실행 → `Setup complete` 확인
9. 브라우저에서 웹훅 설정:
   ```
   https://api.telegram.org/bot봇토큰/setWebhook?url=웹앱URL
   ```
   `{"ok":true}` 나오면 성공

### 4. WSL 의존성 설치

```bash
cd /mnt/d/_workspace/030.repos/kribb-meal
npm install
npx playwright install chromium
```

> Playwright의 Chromium이 `libnspr4.so` 등 시스템 라이브러리를 찾지 못하면 `LD_LIBRARY_PATH`를 지정해야 한다 (아래 참조).

### 5. 테스트

```bash
cd /mnt/d/_workspace/030.repos/kribb-meal

# 크롤링 + 데이터 업로드
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs

# 텔레그램에서 /test → 식단 미리보기 확인
# 텔레그램에서 /meal → 전체 식단 확인
```

### 6. cron 등록 (평일 08:25 + 랜덤 딜레이)

```bash
crontab -e
```

```
SHELL=/bin/bash
25 8 * * 1-5 sleep $((RANDOM % 600)) && cd /mnt/d/_workspace/030.repos/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
```

## 텔레그램 명령어

| 명령어 | 내용 |
|--------|------|
| `/start` | 봇 소개 |
| `/lunch` | 점심 (11:30~13:00) |
| `/dinner` | 저녁 (18:00~19:00) |
| `/meal` | 전체 식단 |
| `/test` | 브로드캐스트 미리보기 |
| `/setlunch HH:MM` | 점심 알림 시간 변경 (08:00~14:59) |
| `/setdinner HH:MM` | 저녁 알림 시간 변경 (15:00~19:00) |
| `/setlunch reset` | 점심 알림 기본값(11:00) 복원 |
| `/setdinner reset` | 저녁 알림 기본값(17:30) 복원 |
| `/mute` | 자동 알림 끄기 |
| `/unmute` | 자동 알림 켜기 |
| `/settings` | 현재 설정 확인 |

## 자동 스케줄

| 시간 | 동작 |
|------|------|
| 08:25 | WSL cron → 크롤링 + 데이터 업로드 (±5분 랜덤) |
| 사용자별 | 점심 알림 (기본 11:00) |
| 사용자별 | 저녁 알림 (기본 17:30) |
| 19:00 | 데이터 삭제 + `/lunch`, `/dinner` → "Done for today" 표시 |

**Catch-up 알림**: 크롤링이 사용자 알림 시간 이후에 완료된 경우, 식사 시작 시간(점심 11:30, 저녁 18:00) 이전이면 데이터 도착 즉시 알림을 전송한다. 식사 시작 시간 이후에는 전송하지 않는다.

## 문제 해결

**libnspr4.so 에러** — `LD_LIBRARY_PATH="/home/gml/miniforge3/lib"` 붙이기

**Apps Script 코드 수정 후** — 저장만으로 안 됨. 배포 관리 → 연필 아이콘 → 버전 "새 버전" → 배포. `setup` 재실행 불필요 (재실행하면 웹훅이 삭제됨). URL이 바뀐 경우만 .env + 웹훅 재설정.

**봇이 응답 안 함** — Apps Script 트리거 탭에서 `tick`이 1분 간격 등록 확인. 없으면 `setup` 재실행.

**Apps Script HTTP / JSON 에러** — 웹 앱 URL이 최신 배포 URL인지 확인하고, Apps Script 수정 후에는 반드시 "새 버전"으로 다시 배포. 크롤러는 이제 비정상 응답을 바로 실패로 처리한다.

**Not yet updated** — WSL에서 크롤링 스크립트 실행: `LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs`

## 새 컴퓨터에 설치하기

기존에 Apps Script + 텔레그램 봇이 배포된 상태에서, 새 WSL 환경에 크롤러만 세팅하는 방법.

1. **레포 클론**
   ```bash
   cd /mnt/d/_workspace
   git clone https://github.com/gyuminlee-repo/kribb-meal.git
   cd kribb-meal
   ```

2. **Node.js 확인** (v18+)
   ```bash
   node --version
   ```

3. **의존성 설치**
   ```bash
   npm install
   npx playwright install chromium
   ```

4. **.env 생성**
   ```bash
   cat > .env << 'EOF'
   KRIBB_ID=인트라넷아이디
   KRIBB_PW=인트라넷비밀번호
   APPS_SCRIPT_URL=기존배포된웹앱URL
   SHARED_SECRET=기존GAS스크립트속성의SHARED_SECRET값
   EOF
   ```

5. **수동 테스트**
   ```bash
   LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs
   ```
   > `LD_LIBRARY_PATH`는 환경에 따라 다를 수 있음. Playwright가 libnspr4.so를 못 찾으면 해당 라이브러리가 있는 경로로 지정.

6. **cron 등록**
   ```bash
   crontab -e
   ```
   ```
   SHELL=/bin/bash
   25 8 * * 1-5 sleep $((RANDOM % 600)) && cd /mnt/d/_workspace/030.repos/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
   @reboot sleep 15 && cd /mnt/d/_workspace/030.repos/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
   ```

7. **확인**: 텔레그램에서 `/meal` 입력 → 식단 표시되면 완료
