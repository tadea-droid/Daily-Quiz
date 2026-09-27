/**
 * Daily Quiz grading worker.
 *
 * Routes:
 *   POST /chunks - store the full filtered passage pool (called once per day
 *                  by the GitHub Action, before it generates today's batch)
 *   POST /set    - store today's batch of questions (called by the Action)
 *   GET  /today  - return today's questions, without answers (called by the page)
 *   POST /grade  - grade a submitted answer against the stored answer
 *   POST /more   - generate one additional question from an unused passage
 *
 * Bindings required (see wrangler.toml and README):
 *   QUIZ_KV           - Workers KV namespace
 *   ANTHROPIC_API_KEY - secret, used to generate and grade questions
 *   SET_SECRET        - secret, shared with the GitHub Action
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

function isAuthorised(request, env) {
  const auth = (request.headers.get("Authorization") || "").trim();
  const expected = `Bearer ${(env.SET_SECRET || "").trim()}`;
  return auth === expected;
}

async function handleChunks(request, env) {
  if (!isAuthorised(request, env)) return json({ error: "Unauthorized" }, 401);
  const body = await request.json();
  if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
    return json({ error: "chunks array is required" }, 400);
  }
  await env.QUIZ_KV.put("chunk_pool", JSON.stringify(body.chunks));
  return json({ ok: true, count: body.chunks.length });
}

async function handleSet(request, env) {
  if (!isAuthorised(request, env)) return json({ error: "Unauthorized" }, 401);
  const body = await request.json();
  if (!Array.isArray(body.questions) || body.questions.length === 0) {
    return json({ error: "questions array is required" }, 400);
  }
  const usedChunkIds = body.questions
    .map((q) => q.chunkId)
    .filter((id) => id !== undefined);
  const today = {
    date: body.date || new Date().toISOString().slice(0, 10),
    questions: body.questions,
    usedChunkIds,
  };
  await env.QUIZ_KV.put("today", JSON.stringify(today));
  return json({ ok: true, count: body.questions.length });
}

async function handleToday(env) {
  const raw = await env.QUIZ_KV.get("today");
  if (!raw) return json({ date: null, questions: [] });
  const data = JSON.parse(raw);
  const questions = data.questions.map((q) => ({ id: q.id, question: q.question }));
  return json({ date: data.date, questions });
}

async function callClaudeForGrading(env, question, correctAnswer, userAnswer) {
  const prompt = `Question: ${question}
Correct answer: ${correctAnswer}
User's answer: ${userAnswer}

Judge whether the user's answer captures the core idea of the correct answer.
It does not need to match word for word, or include every detail. Mark it
correct if the essential principle or value is right, even if phrased
differently or missing minor detail. Mark it incorrect only if the core idea
is wrong, missing, or contradicts the correct answer.

Reply with only JSON, no other text, in this exact shape:
{"correct": true, "feedback": "one short sentence"}`;

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

  const aiData = await aiResponse.json();
  const text = aiData.content[0].text.trim().replace(/^```json|```$/g, "").trim();
  return JSON.parse(text);
}

async function handleGrade(request, env) {
  const raw = await env.QUIZ_KV.get("today");
  if (!raw) return json({ error: "No questions set for today" }, 404);
  const today = JSON.parse(raw);

  const body = await request.json();
  const questionEntry = today.questions.find((q) => q.id === body.id);
  if (!questionEntry) return json({ error: "Unknown question id" }, 404);

  const userAnswer = (body.answer || "").trim();
  if (!userAnswer) return json({ error: "answer is required" }, 400);

  let verdict = { correct: null, feedback: "Could not grade automatically." };
  try {
    verdict = await callClaudeForGrading(
      env,
      questionEntry.question,
      questionEntry.answer,
      userAnswer
    );
  } catch (err) {
    // fall through with the default verdict above
  }

  return json({ ...verdict, correctAnswer: questionEntry.answer });
}

function buildGenerationPrompt(chunk) {
  return `You are writing a quiz question for a mechanical building services
engineer in New South Wales, Australia, studying the National Construction
Code (NCC) 2022 to progress from intermediate to senior level.

Passage (from ${chunk.source}):
"""
${chunk.text}
"""

Write one quiz question based on this passage, following these rules:
- Test understanding of the underlying principle or requirement, not
  memorisation of clause numbers or exact wording.
- If the passage states a specific parameter that matters in practice (an
  airflow rate, temperature, pressure, clearance, rating, or similar figure),
  you may ask about that value, since figures like these matter for
  compliance.
- Focus on what applies in New South Wales. If the passage is only about a
  variation specific to another state or territory, pick a different angle
  from the passage that applies nationally or to NSW instead.
- Keep the question to one or two sentences.

Reply with only JSON, no other text, in this exact shape:
{"question": "...", "answer": "..."}`;
}

async function handleMore(env) {
  const poolRaw = await env.QUIZ_KV.get("chunk_pool");
  if (!poolRaw) return json({ error: "No passage pool available yet" }, 404);
  const pool = JSON.parse(poolRaw);

  const todayRaw = await env.QUIZ_KV.get("today");
  const today = todayRaw
    ? JSON.parse(todayRaw)
    : { date: new Date().toISOString().slice(0, 10), questions: [], usedChunkIds: [] };

  const usedSet = new Set(today.usedChunkIds || []);
  const available = pool.map((_, i) => i).filter((i) => !usedSet.has(i));
  if (available.length === 0) {
    return json({ error: "No more unused passages left for today" }, 404);
  }
  const chunkId = available[Math.floor(Math.random() * available.length)];
  const chunk = pool[chunkId];

  const aiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 300,
      messages: [{ role: "user", content: buildGenerationPrompt(chunk) }],
    }),
  });
  const aiData = await aiResponse.json();
  const text = aiData.content[0].text.trim().replace(/^```json|```$/g, "").trim();
  const qa = JSON.parse(text);

  const nextId =
    today.questions.length > 0
      ? Math.max(...today.questions.map((q) => q.id)) + 1
      : 0;

  const newQuestion = {
    id: nextId,
    chunkId,
    question: qa.question,
    answer: qa.answer,
    source: chunk.source,
  };

  today.questions.push(newQuestion);
  today.usedChunkIds = [...(today.usedChunkIds || []), chunkId];
  await env.QUIZ_KV.put("today", JSON.stringify(today));

  return json({ id: newQuestion.id, question: newQuestion.question });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/chunks" && request.method === "POST") {
      return handleChunks(request, env);
    }
    if (url.pathname === "/set" && request.method === "POST") {
      return handleSet(request, env);
    }
    if (url.pathname === "/today" && request.method === "GET") {
      return handleToday(env);
    }
    if (url.pathname === "/grade" && request.method === "POST") {
      return handleGrade(request, env);
    }
    if (url.pathname === "/more" && request.method === "POST") {
      return handleMore(env);
    }
    return json({ error: "Not found" }, 404);
  },
};
