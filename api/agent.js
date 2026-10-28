const { toolDefinitions, runTool } = require("./tools");

// 모델은 GEMINI_MODEL 환경변수로 바꿀 수 있다.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = [1000, 2500, 5000]; // 과부하(503)·한도(429)일 때만 재시도

async function callGemini(contents) {
  const request = () =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents,
        tools: [{ functionDeclarations: toolDefinitions }],
        generationConfig: { maxOutputTokens: 4096 },
      }),
    });

  let res = await request();
  for (const delay of RETRY_DELAYS_MS) {
    if (res.status !== 503 && res.status !== 429) break;
    await sleep(delay);
    res = await request();
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini API 오류(${res.status})`);
  const content = data.candidates?.[0]?.content;
  if (!content) {
    throw new Error(data.promptFeedback?.blockReason
      ? `요청이 차단되었습니다(${data.promptFeedback.blockReason}).`
      : "Gemini 가 빈 응답을 돌려줬습니다.");
  }
  return content;
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
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const reply = await callGemini(contents);
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
