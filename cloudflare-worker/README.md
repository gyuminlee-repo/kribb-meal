# Cloudflare Worker - KRIBB Meal KakaoTalk Chatbot

KRIBB 구내식당 식단을 카카오톡 채널로 제공하는 Cloudflare Worker.
무료 티어 전용 (Workers + KV). 유료 업그레이드 없이 운영 가능.

## 무료 한도 (2024 기준)

- Workers 요청: 100,000건/일
- KV 읽기: 100,000건/일
- KV 쓰기: 1,000건/일

하루 쓰기는 크롤러 실행 1회 기준 1건이므로 한도 문제 없음.

## 유료 함정 경고

- **카카오 Event API(푸시 발송)**: 별도 비용 발생, 사용 금지. 이 Worker는 pull 방식(사용자 요청 시 응답)만 사용.
- **Cloudflare 유료 플랜**: 무료 티어에서 Workers Paid로 업그레이드하지 말 것. 이 구성에서 불필요하며 월 비용 발생.

---

## 배포 단계

### 1. Cloudflare 무료 계정 가입

https://dash.cloudflare.com/sign-up 에서 가입. 신용카드 불필요.

### 2. Wrangler CLI 설치 및 로그인

```bash
npm install -g wrangler
wrangler login
```

브라우저가 열리며 Cloudflare 계정 인증을 요청함.

### 3. KV 네임스페이스 생성

`cloudflare-worker/` 디렉토리 안에서 실행:

```bash
cd cloudflare-worker
wrangler kv namespace create MEAL
```

출력 예시:
```
{ binding = "MEAL", id = "a1b2c3d4e5f6..." }
```

출력된 `id` 값을 복사한 후 `wrangler.toml`의 `<KV_NAMESPACE_ID>` 자리에 붙여넣기:

```toml
[[kv_namespaces]]
binding = "MEAL"
id = "a1b2c3d4e5f6..."   # <-- 여기에 실제 id 입력
```

### 4. Ingest 시크릿 등록

```bash
wrangler secret put INGEST_SECRET
```

프롬프트가 뜨면 크롤러 `.env`의 `SHARED_SECRET` 값을 그대로 입력. 두 값이 일치해야 크롤러 인증이 통과됨.

### 5. 배포

```bash
wrangler deploy
```

배포 완료 후 출력된 `workers.dev` URL을 기록:
```
https://kribb-meal-kakao.<your-subdomain>.workers.dev
```

### 6. 크롤러 .env에 Worker URL 추가

프로젝트 루트의 `.env` 파일에 다음 줄 추가:

```
WORKER_INGEST_URL=https://kribb-meal-kakao.<your-subdomain>.workers.dev/ingest
```

크롤러가 GAS 업로드 직후 Worker에도 데이터를 전송함. `WORKER_INGEST_URL`이 없으면 기존 텔레그램/GAS 경로만 동작.

### 7. 카카오 오픈빌더 스킬 등록

1. https://business.kakao.com 에서 채널 생성 (카카오 계정 필요)
2. https://i.kakao.com (오픈빌더) 에서 챗봇 앱 생성
3. 왼쪽 메뉴 "스킬" 탭에서 새 스킬 추가:
   - 스킬 서버 URL: `https://kribb-meal-kakao.<your-subdomain>.workers.dev/`  (루트, `/ingest` 아님)
   - 메서드: POST
4. "블록" 탭에서 사용자 발화 패턴 등록 (예: "오늘 식단", "점심", "저녁")하고 해당 스킬 연결
5. OBT(오픈 베타 테스트) 신청 후 카카오 심사 (약 6일 소요)

### 8. 동작 확인

크롤러 수동 실행:

```bash
node kribb-meal-bot.mjs --force
```

로그에 `Worker ingest: 200` 줄이 보이면 Worker에 데이터가 전송된 것.

카카오 오픈빌더 "스킬 테스트" 탭에서 임의 발화를 입력하면 식단 텍스트가 반환됨.

---

## 파일 구조

```
cloudflare-worker/
  worker.js       - Worker 메인 코드 (ESM, 의존성 없음)
  wrangler.toml   - 배포 설정 (KV 바인딩, 이름)
  README.md       - 이 파일
```

## 엔드포인트 요약

| 메서드 | 경로 | 용도 |
|--------|------|------|
| POST | `/ingest` | 크롤러가 식단 데이터 전송 (INGEST_SECRET 필요) |
| POST | `/` | 카카오 스킬 요청 수신, 오늘 식단 반환 |
| GET | `/` | 헬스체크 |
