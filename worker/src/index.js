/**
 * Daily Quiz grading worker.
 *
 * Routes:
 *   POST /set    - store today's question and answer (called by the GitHub Action)
 *   GET  /today  - return today's question, without the answer (called by the page)
 *   POST /grade  - grade a submitted answer against today's stored answer
 *
 * Bindings required (see wrangler.toml and README):
 *   QUIZ_KV           - Workers KV namespace
 *   ANTHROPIC_API_KEY - secret, used to grade answers
 *   SET_SECRET        - secret, shared with the GitHub Action to authorise /set
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function handleSet(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.SET_SECRET}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  const body = await request.json();
  if (!body.question || !body.answer) {
    return json({ error: "question and answer are required" }, 400);
  }
  const today = {
    date: body.date || new Date().toISOString().slice(0, 10),
    question: body.question,
    answer: body.answer,
    source: body.source || null,
  };
  await env.QUIZ_KV.put("today", JSON.stringify(today));
  return json({ ok: true });
}

async function handleToday(env) {
  const raw = await env.QUIZ_KV.get("today");
  if (!raw) return json({ question: null });
  const data = JSON.parse(raw);
  return json({ date: data.date, question: data.question, source: data.source });
}

async function handleGrade(request, env) {
  const raw = await env.QUIZ_KV.get("today");
  if (!raw) return json({ error: "No question set for today" }, 404);
  const today = JSON.parse(raw);

  const body = await request.json();
  const userAnswer = (body.answer || "").trim();
  if (!userAnswer) return json({ error: "answer is required" }, 400);

  const prompt = `Question: ${today.question}
Correct answer: ${today.answer}
User's answer: ${userAnswer}

Judge whether the user's answer is correct. Minor wording differences are fine
if the meaning matches. Reply with only JSON, no other text, in this exact
shape: {"correct": true, "feedback": "one short sentence"}`;

  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  let verdict = { correct: null, feedback: "Could not grade automatically." };
  try {
    const aiData = await aiResponse.json();
    const text = aiData.content[0].text.trim().replace(/^```json|```$/g, "").trim();
    verdict = JSON.parse(text);
  } catch (err) {
    // fall through with the default verdict above
  }

  return json({ ...verdict, correctAnswer: today.answer });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/set" && request.method === "POST") {
      return handleSet(request, env);
    }
    if (url.pathname === "/today" && request.method === "GET") {
      return handleToday(env);
    }
    if (url.pathname === "/grade" && request.method === "POST") {
      return handleGrade(request, env);
    }
    return json({ error: "Not found" }, 404);
  },
};
