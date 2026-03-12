# KRIBB Meal Bot

KRIBB 인트라넷 식단을 매일 아침 텔레그램으로 보내주는 봇.

## 어떻게 동작해?

KRIBB 내부망에서 텔레그램이 막혀있어서, Google Apps Script를 중간 다리로 씀.

```
내 PC (WSL)              Google Apps Script          텔레그램
식단 크롤링 → 데이터 전송 →  저장 + 텔레그램 전달  →  봇이 응답
                           1분마다 새 메시지 확인      /breakfast
                                                      /lunch
                                                      /dinner
                                                      /meal
```

## 파일 설명

| 파일 | 뭐하는 파일? |
|------|-------------|
| `kribb-meal-bot.mjs` | 식단 크롤링 + Apps Script로 전송하는 메인 스크립트 |
| `kribb-meal-check.mjs` | 크롤링만 해서 터미널에 출력 (테스트용) |
| `apps-script-code.js` | Google Apps Script에 올릴 코드 |
| `.env` | 아이디/비밀번호 등 비공개 설정 (git에 안 올라감) |

---

## 처음부터 세팅하기

### Step 1. 텔레그램 봇 만들기

1. 텔레그램 앱에서 `@BotFather` 검색
2. `/newbot` 입력
3. 봇 이름, username 정하기
4. **Bot Token** 복사해두기 (나중에 씀)

### Step 2. `.env` 파일 만들기

실행할 디렉토리에 `.env` 파일 생성:

```
KRIBB_ID=인트라넷아이디
KRIBB_PW=인트라넷비밀번호
APPS_SCRIPT_URL=아직비워둠
```

### Step 3. Google Apps Script 세팅

1. 브라우저에서 [script.google.com](https://script.google.com) 접속
2. **새 프로젝트** 클릭
3. 기본 코드 전부 지우기
4. GitHub에서 `apps-script-code.js` 열기 → **Raw** 버튼 클릭 → 전체 복사 → 붙여넣기
5. **1번째 줄** `'YOUR_BOT_TOKEN'`을 Step 1에서 받은 봇 토큰으로 교체
6. **Ctrl+S**로 저장
7. 메뉴에서 **배포** → **새 배포**
   - 톱니바퀴 → **웹 앱** 선택
   - "다음 사용자 인증정보로 실행": **본인**
   - "액세스 권한": **모든 사용자**
   - **배포** 클릭
8. 나온 URL 복사 → `.env`의 `APPS_SCRIPT_URL=`에 붙여넣기
9. **중요!** 상단 함수 드롭다운에서 → **`setup`** 선택 → **▶ 실행** 클릭
   - "승인 필요" 팝업 → 허용
   - 실행 로그에 **`Setup complete`** 가 나와야 함

> `setup`이 하는 일: 1분마다 텔레그램 새 메시지를 확인하는 자동 트리거를 등록함.
> 이걸 안 하면 봇이 메시지를 읽지 못함.

### Step 4. 테스트

#### 4-1. 크롤링이 되는지 확인

```bash
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-check.mjs
```

성공하면 터미널에 오늘 식단이 출력됨.
실패하면 `.env`의 KRIBB_ID/PW 확인.

#### 4-2. Apps Script로 데이터가 전달되는지 확인

```bash
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs test
```

`Apps Script 응답: {"ok":true,"users":0}` 같은 메시지가 나오면 성공.

#### 4-3. 텔레그램 봇이 응답하는지 확인

1. 텔레그램에서 만든 봇 검색 → `/start` 전송
2. **1분 정도 기다림** (Apps Script가 1분마다 확인하므로)
3. 봇이 명령어 안내 메시지를 보내면 성공
4. `/meal` 입력 → 오늘 식단이 나오면 전체 파이프라인 정상

#### 4-4. 브로드캐스트 테스트

```bash
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs send
```

봇을 추가한 모든 사람에게 오늘 식단이 전송됨.

### Step 5. 매일 자동 실행 (선택)

```bash
crontab -e
```

아래 줄 추가 (평일 08:30에 자동 크롤링 + 브로드캐스트):

```
30 8 * * 1-5 cd /mnt/d/_workspace/prototype && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs send >> /tmp/kribb-meal-bot.log 2>&1
```

---

## 텔레그램 봇 명령어

| 명령어 | 내용 |
|--------|------|
| `/start` | 봇 소개 |
| `/breakfast` | 조식 (7:30~9:00) |
| `/lunch` | 중식 (11:30~13:00) |
| `/dinner` | 석식 (18:00~19:00) |
| `/meal` | 전체 식단 |

---

## 문제 해결

### "libnspr4.so" 에러가 나요

실행할 때 `LD_LIBRARY_PATH`를 반드시 붙여야 함:

```bash
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs test
```

### Apps Script 코드를 수정했는데 반영이 안 돼요

**저장만으로는 안 됨.** 배포 → **새 배포**로 다시 배포해야 반영됨.
새 배포를 하면 URL이 바뀌므로 `.env`도 업데이트 필요.

### 텔레그램 봇이 아무 응답이 없어요

1. Apps Script 왼쪽 메뉴 **시계 아이콘 (트리거)** 클릭
2. `pollMessages`가 1분 간격으로 등록되어 있는지 확인
3. 없으면 → 함수 드롭다운에서 `setup` 선택 → 실행
4. 있는데도 안 되면 → `pollMessages` 직접 실행 → 실행 로그 확인

### "Not yet updated" 라고 나와요

WSL에서 아직 오늘 식단을 크롤링하지 않은 상태. 아래 명령어로 데이터를 올려주면 됨:

```bash
LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs test
```
