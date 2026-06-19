/**
 * KRIBB Meal Bot - Cloudflare Worker (KakaoTalk OpenBuilder skill server)
 *
 * Endpoints:
 *   POST /ingest  - Receive meal data from crawler
 *   POST /        - KakaoTalk OpenBuilder skill request (returns today's meal)
 *   GET  /        - Health check
 *
 * Environment variables (set via wrangler secret):
 *   INGEST_SECRET  - Shared secret for /ingest authentication (same as crawler SHARED_SECRET)
 *
 * KV binding:
 *   MEAL           - Cloudflare KV namespace for meal storage
 */

// --- Time constants (KST) ---
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const LUNCH_START_H = 11;
const LUNCH_START_M = 30;
const DINNER_START_H = 18;
const DINNER_END_H = 19;   // 19:00 = "closed for today"

const MEAL_KV_KEY = "meal:today";
const MEAL_KV_TTL = 86400; // 24 hours

// --- KST helpers ---

function kstNow() {
  return new Date(Date.now() + KST_OFFSET_MS);
}

function kstTodayStr() {
  const t = kstNow();
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function kstHour() {
  return kstNow().getUTCHours();
}

// --- Meal data validity check ---

function isUpdated(data) {
  return data && data.date === kstTodayStr() && (data.lunchA || data.dinner);
}

// --- Plain text formatter (no HTML tags) ---

function formatMealText(data) {
  const h = kstHour();

  if (h >= DINNER_END_H) {
    return "오늘 식사는 마감되었습니다. 다음 업데이트는 내일입니다.";
  }

  if (!isUpdated(data)) {
    return "아직 업데이트되지 않았습니다.";
  }

  const lines = [];
  lines.push(`KRIBB 식단 (${data.date})`);

  if (data.lunchA) {
    lines.push("");
    lines.push("[중식] 11:30-13:00");
    lines.push(data.lunchA);
  }

  if (data.dinner) {
    lines.push("");
    lines.push("[석식] 18:00-19:00");
    lines.push(data.dinner);
  }

  if (data.insight) {
    lines.push("");
    lines.push("✨ AI Insight");
    lines.push(data.insight);
  }

  return lines.join("\n");
}

// --- Kakao skill response ---

function kakaoResponse(text) {
  return new Response(
    JSON.stringify({
      version: "2.0",
      template: {
        outputs: [
          {
            simpleText: {
              text: text,
            },
          },
        ],
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

// --- Main handler ---

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // Health check
    if (method === "GET") {
      return new Response("ok", { status: 200 });
    }

    if (method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // POST /ingest - crawler pushes meal data
    if (url.pathname === "/ingest") {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ ok: false, error: "Invalid JSON" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!body.secret || body.secret !== env.INGEST_SECRET) {
        return new Response(
          JSON.stringify({ ok: false, error: "Unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      if (!body.data) {
        return new Response(
          JSON.stringify({ ok: false, error: "Missing data field" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      await env.MEAL.put(MEAL_KV_KEY, JSON.stringify(body.data), {
        expirationTtl: MEAL_KV_TTL,
      });

      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // POST / - KakaoTalk OpenBuilder skill request
    if (url.pathname === "/") {
      let mealData = null;
      try {
        const raw = await env.MEAL.get(MEAL_KV_KEY);
        if (raw) mealData = JSON.parse(raw);
      } catch {
        // KV read failure: treat as no data
      }

      const text = formatMealText(mealData);
      return kakaoResponse(text);
    }

    return new Response("Not Found", { status: 404 });
  },
};
