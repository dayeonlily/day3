const { toolDefinitions, runTool } = require("./tools");

// 모델은 GEMINI_MODEL 환경변수로 바꿀 수 있다.
// 이름 형식이 아니거나 API 키처럼 보이는 값(AIza…)이 잘못 들어와도 요청 주소·로그·오류에 새지 않게 막는다.
const DEFAULT_MODEL = "gemini-3.8-flash";
const envModel = (process.env.GEMINI_MODEL || "").trim();
const MODEL = /^gemini-[a-z0-9.\-]+$/.test(envModel) ? envModel : DEFAULT_MODEL;
const MAX_TURNS = 6; // 도구 호출 왕복 상한 (무한 루프 방지)
const MAX_MESSAGE_LENGTH = 300;

const todayKST = () =>
  new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const systemPrompt = () =>
  `너는 제주도 여행 추천 도우미다. 오늘은 ${todayKST()}(한국 시간)이다.\n` +
  "- 사용자의 요청에서 지역(동쪽 · 서쪽 · 서귀포 · 제주시)과 날짜를 파악한다. 지역이 없으면 제주시로 가정하고 그렇게 말한다.\n" +
  "- 날씨가 추천에 영향을 주므로 반드시 open_meteo 로 해당 날짜의 날씨를 먼저 확인한다.\n" +
  "- 그 결과(outdoor_advice)를 반영해 find_spots 로 실내/야외를 골라 장소를 찾는다. 사용자가 실내/야외를 직접 정했으면 그것을 우선한다.\n" +
  "- 두 도구가 돌려준 정보만 근거로 삼는다. 목록에 없는 장소 · 운영시간 · 요금은 지어내지 않는다.\n" +
  "- 답변은 한국어로 간결하게: 날씨 한 줄 요약 → 추천 장소 3~5곳(이름과 한 줄 이유) → 방문 전 공식 안내 확인 권유.\n" +
  "- 제주도와 무관한 요청은 정중히 범위 밖이라고 답한다.";


// Vercel 이 함수를 강제 종료(일반 텍스트 오류 페이지)하기 전에 우리가 먼저 JSON 오류로 끝낸다.
const TOTAL_BUDGET_MS = 50000;
const PER_ATTEMPT_MS = 15000; // 한 모델이 이보다 오래 걸리면 포기하고 다음 모델로 넘어간다.
const MAX_FALLBACKS = 2;
const API = "https://generativelanguage.googleapis.com/v1beta";
const headers = () => ({ "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY });

// 기본 모델이 과부하일 때 쓸 대체 모델: 이 키로 쓸 수 있는 flash 모델을 직접 조회한다(인스턴스당 1회 캐시).
let fallbackCache;
async function fallbackModels() {
  if (fallbackCache) return fallbackCache;
  try {
    const res = await fetch(`${API}/models?pageSize=100`, { headers: headers(), signal: AbortSignal.timeout(5000) });
    const list = (await res.json()).models || [];
    fallbackCache = list
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /^gemini-[a-z0-9.\-]*flash/.test(n) && !/(image|tts|audio|live|embedding|vision|robotics|computer|thinking)/.test(n))
      .filter((n) => n !== MODEL)
      .sort().reverse()
      .slice(0, MAX_FALLBACKS);
  } catch {
    fallbackCache = [];
  }
  console.log("대체 모델 후보:", fallbackCache.join(", ") || "(없음)");
  return fallbackCache;
}

// 모델 하나에 요청한다. 추론(thinking)을 낮춰 속도를 올리고, 모델이 그 설정을 거부하면 빼고 다시 요청한다.
async function requestModel(model, contents, timeoutMs) {
  const send = (lowThinking) =>
    fetch(`${API}/models/${model}:generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents,
        tools: [{ functionDeclarations: toolDefinitions }],
        generationConfig: {
          maxOutputTokens: 4096,
          ...(lowThinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res = await send(true);
  if (res.status === 400) {
    const msg = (await res.clone().json().catch(() => ({}))).error?.message || "";
    if (/think/i.test(msg)) res = await send(false);
  }
  return res;
}

// state.model 은 요청 하나 안에서 한번 성공한 모델을 계속 쓰기 위한 것(대화 중간에 모델이 바뀌지 않게).
async function callGemini(contents, deadline, state) {
  const models = state.model ? [state.model] : [MODEL];
  let lastProblem = "";
  for (let i = 0; i < models.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 3000) break;
    const model = models[i];
    const started = Date.now();
    let res;
    try {
      res = await requestModel(model, contents, Math.min(PER_ATTEMPT_MS, remaining));
    } catch (e) {
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      console.log(`Gemini ${model} 호출 실패: ${e.name} (${Date.now() - started}ms)`);
      if (!timedOut) throw e;
      lastProblem = "응답이 너무 오래 걸립니다";
      if (!state.model && i === 0) models.push(...(await fallbackModels()));
      continue;
    }
    console.log(`Gemini ${model} 응답 ${res.status} (${Date.now() - started}ms)`);
    if (res.status === 503 || res.status === 429) {
      lastProblem = "Gemini 서버가 혼잡합니다";
      if (!state.model && i === 0) models.push(...(await fallbackModels()));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API 오류(${res.status})`);
    const content = data.candidates?.[0]?.content;
    if (!content) {
      throw new Error(data.promptFeedback?.blockReason
        ? `요청이 차단되었습니다(${data.promptFeedback.blockReason}).`
        : "Gemini 가 빈 응답을 돌려줬습니다.");
    }
    state.model = model;
    return content;
  }
  throw new Error(`${lastProblem || "시간이 부족합니다"}. 잠시 후 다시 시도해 주세요.`);
}


// POST /api/agent  { "message": "내일 서쪽에서 갈만한 곳 추천해줘" }
// → { answer, steps: [{ tool, input, result }] }
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST 로 요청하세요." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다." });
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) return res.status(400).json({ error: "message 가 비어 있습니다." });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `message 는 ${MAX_MESSAGE_LENGTH}자 이하여야 합니다.` });
  }

  const contents = [{ role: "user", parts: [{ text: message }] }];
  const steps = [];
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const state = {};
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await callGemini(contents, deadline, state);
      const parts = reply.parts || [];
      // 모델 응답은 그대로(생각 서명 포함) 대화에 되돌려 넣어야 한다.
      contents.push({ role: "model", parts });

      const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      if (calls.length === 0) {
        const answer = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n");
        return res.status(200).json({ answer, steps });
      }

      // 같은 턴에 요청된 도구는 한꺼번에 실행하고 결과를 한 메시지로 돌려준다.
      const responses = await Promise.all(
        calls.map(async (c) => {
          const result = await runTool(c.name, c.args);
          steps.push({ tool: c.name, input: c.args || {}, result });
          return { functionResponse: { name: c.name, response: { result } } };
        })
      );
      contents.push({ role: "user", parts: responses });
    }
    res.status(200).json({ answer: "도구를 너무 많이 호출해 답변을 마치지 못했습니다. 질문을 조금 더 구체적으로 해주세요.", steps });
  } catch (e) {
    res.status(502).json({ error: e.message, steps });
  }
};
