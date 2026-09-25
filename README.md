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

## 식단 미갱신 메일 알림

크롤러가 실패하거나 서버·cron이 멈추면 텔레그램으로는 아무 알림도 오지 않는다. 그래서 Apps Script의 `tick`(1분 트리거)이 `watchdogCheck`를 함께 돌린다.

- 평일(휴가·미운영 기간 제외) 09:15 이후 19:00 전에 오늘 식단이 아직 없으면 운영자에게 메일을 1통 보낸다. 하루에 한 번만 보낸다.
- 법정 공휴일(대체공휴일 포함)에는 보내지 않는다. Google 공개 대한민국 휴일 캘린더(ICS)에서 `공휴일`로 표시된 날만 제외하고 기념일(국군의날 등)은 평일로 본다. 목록은 6시간 캐시하고 받아 오지 못하면 평일로 보고 메일을 보낸다.
- 메일 제목은 `[KRIBB meal] YYYY/MM/DD 식단 미갱신`. 본문에 확인 시각, 가능한 원인, 마지막 식단 수신 시각, 조치(서버에서 `node kribb-meal-bot.mjs` 수동 실행, 로그 확인)가 들어 있다. 마지막 식단 이후 평일이 2일 이상 비면 며칠째 미수신이라는 줄이 붙는다. 수신 기록(`lastMealDate`, `lastMealAt`)은 19:00 정리 때 지우지 않는다.
- 크롤러는 평일에 실제로 시도한 실행마다 결과와 무관하게 끝에서 Apps Script에 heartbeat(`ok`, `already`, `not_posted`, `error`)를 보낸다. Apps Script는 이를 스크립트 속성 `lastHeartbeat`에 저장하고(19:00 정리 대상 아님) 메일 본문 첫머리에 진단 한 줄을 넣는다. 오늘 기록이 있으면 실행 시각과 결과를, 없으면 마지막 기록 시각과 서버 또는 cron 중단 의심을 적는다. heartbeat 전송 실패는 크롤러 종료코드에 영향을 주지 않는다.
- 메일 발송이 실패하면 다음 분에 다시 시도한다.

반영 방법:

> **주의**: 메일 권한이 새로 필요해지므로 코드를 저장하는 순간부터 권한을 승인할 때까지 1분 트리거(`tick`)가 통째로 실패한다. 그동안 식단 알림과 명령 응답이 모두 멈춘다. 저장 직후 바로 2번을 진행하고, 가급적 09:00 전이나 퇴근 후에 반영한다.

1. 코드를 Apps Script에 붙여넣고 **저장**한다.
2. **즉시** 편집기 상단 함수 목록에서 `watchdogCheck` 를 골라 **실행**하고 권한 승인 창에서 허용한다(메일 발송 MailApp 권한). 창 밖 시각이면 메일 없이 끝나는 것이 정상이다.
3. **프로젝트 설정 → 스크립트 속성**에 `WATCHDOG_EMAIL` = 받을 주소를 추가한다. 한 번만 넣으면 코드를 다시 붙여넣어도 유지된다. 비워 두면 스크립트 소유자 계정으로 보낸다.
4. **배포 관리 → 연필 아이콘 → 버전 "새 버전" → 배포**. `setup` 은 재실행하지 말 것.
5. 실행 로그에서 `tick` 이 Authorization 오류 없이 도는지 확인한다.

알림 시작 시각은 `WATCHDOG_H`, `WATCHDOG_M` 상수로 바꾼다.

### 임시 휴무일 등록 (재배포 불필요)

`HOLIDAY_RANGES`에 없는 갑작스러운 휴무(식당 사정, 행사 등)는 스크립트 속성 `SKIP_DATES`에 적는다. 적힌 날에는 watchdog 메일이 나가지 않는다. 식단 알림 동작은 그대로이며 휴무일에는 식단 데이터가 없어 알림도 나가지 않는다.

- **프로젝트 설정 → 스크립트 속성**에서 `SKIP_DATES`를 추가하거나 값을 고친다. 코드 재배포는 필요 없고 다음 `tick`부터 반영된다.
- 형식은 쉼표로 구분한 날짜 목록이다. 각 항목은 `YYYY-MM-DD` 하루 또는 `YYYY-MM-DD~YYYY-MM-DD` 양끝 포함 범위이며 공백은 무시한다.
- 예시: `2026-10-30, 2026-12-28~2027-01-02`
- 형식이 잘못된 항목은 무시하고 실행 로그에 남긴다. 나머지 항목은 그대로 적용된다. 지난 날짜는 남겨 둬도 무해하다.
- 반대로 법정 공휴일인데 식당이 여는 날은 스크립트 속성 `WORK_DATES`에 같은 형식으로 적는다. 그날은 평일로 보고 감시한다. 기본값은 비어 있다. 같은 날이 `SKIP_DATES`에도 있으면 `SKIP_DATES`가 우선해 건너뛴다.

## 휴가·미운영 기간 설정

집중휴가처럼 구내식당 식단 운영이 없는 기간에는 `HOLIDAY_RANGES` 목록에 기간을 등록한다. 등록하면 사용자 명령에는 "운영 없음" 안내가 나가고, 자동 알림(브로드캐스트)과 크롤링은 한 건도 실행되지 않는다.

**세 파일을 함께 고쳐야 한다.** 한 곳만 고치면 나머지 경로가 평소대로 동작한다.

| 파일 | 날짜 형식 | 필드 |
|------|----------|------|
| `apps-script-code.js` | `YYYY/MM/DD` | start, end, label, display, resume |
| `cloudflare-worker/worker.js` | `YYYY/MM/DD` | start, end, label, display, resume |
| `kribb-meal-bot.mjs` | `YYYY-MM-DD` | start, end, label |

크롤러만 하이픈(`-`) 형식이다. 슬래시 형식을 붙여넣으면 조건이 영영 맞지 않아 조용히 평소대로 크롤링한다.

기간은 양끝을 포함하며 KST 기준으로 판정한다. 기간이 지나면 자동으로 평상 동작으로 돌아가므로 되돌리는 작업은 필요 없다.

반영 방법:

- **크롤러(서버)**: `git pull` 만 하면 된다. cron 재등록이나 재시작 불필요.
- **Google Apps Script**: 코드를 붙여넣고 저장한 뒤 **배포 관리 → 연필 아이콘 → 버전 "새 버전" → 배포**. `setup` 은 재실행하지 말 것 (웹훅이 삭제된다).
- **Cloudflare Worker**: 카카오 채널을 쓰는 경우에만 `wrangler deploy`. 텔레그램만 쓰면 불필요.

휴가 기간에도 크롤링을 강제로 돌려야 하면 `IGNORE_HOLIDAY=1` 을 붙인다. `--force` 로는 휴가 스킵이 풀리지 않는다.

```bash
IGNORE_HOLIDAY=1 node kribb-meal-bot.mjs
```

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
