const fs = require("fs");
const path = require("path");

const SPOTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "jeju_spots.json"), "utf8")
).spots;

const AREAS = ["동쪽", "서쪽", "서귀포", "제주시"];
const MAX_RESULTS = 8;

// 데이터의 area 는 "동쪽(성산)" 처럼 괄호가 붙을 수 있어 괄호 앞부분으로 비교한다.
const areaOf = (spot) => spot.area.split("(")[0];

function findSpots({ area, indoor } = {}) {
  if (!AREAS.includes(area)) {
    return { error: `area 는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  }
  const matched = SPOTS.filter(
    (s) => areaOf(s) === area && (indoor === undefined || s.indoor === indoor)
  );
  return {
    total: matched.length,
    spots: matched.slice(0, MAX_RESULTS).map((s) => ({
      name: s.name,
      region: s.area,
      indoor: s.indoor,
      desc: s.type,
    })),
  };
}

// 지역 대표 좌표(위도, 경도) — 날씨 조회용
const AREA_COORDS = {
  "동쪽": [33.45, 126.85], "서쪽": [33.37, 126.30],
  "서귀포": [33.25, 126.56], "제주시": [33.50, 126.53],
};

// WMO 날씨 코드 → 한국어 (Open-Meteo)
function weatherText(code) {
  if (code === 0) return "맑음";
  if (code <= 3) return "구름 조금~흐림";
  if (code <= 48) return "안개";
  if (code <= 57) return "이슬비";
  if (code <= 67) return "비";
  if (code <= 77) return "눈";
  if (code <= 82) return "소나기";
  if (code <= 86) return "눈 소나기";
  return "뇌우";
}
const isWetCode = (code) => (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;

// Open-Meteo 는 API 키가 필요 없다. 오늘부터 7일 예보.
async function openMeteo({ area, date } = {}) {
  if (!AREAS.includes(area)) {
    return { error: `area 는 ${AREAS.join(" · ")} 중 하나여야 합니다.` };
  }
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: "date 는 YYYY-MM-DD 형식이어야 합니다." };
  }
  const [lat, lon] = AREA_COORDS[area];
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max" +
    "&timezone=Asia%2FSeoul&forecast_days=7";
  let daily;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { error: `날씨 서비스 응답 오류(${res.status})` };
    daily = (await res.json()).daily;
  } catch {
    return { error: "날씨 서비스에 연결하지 못했습니다." };
  }
  const i = date === undefined ? 0 : daily.time.indexOf(date);
  if (i < 0) {
    return { error: `예보는 ${daily.time[0]} ~ ${daily.time[daily.time.length - 1]} 사이만 조회할 수 있습니다.` };
  }
  const rain = daily.precipitation_probability_max[i];
  const wet = isWetCode(daily.weather_code[i]) || rain >= 50;
  return {
    area,
    date: daily.time[i],
    weather: weatherText(daily.weather_code[i]),
    temp_min_c: daily.temperature_2m_min[i],
    temp_max_c: daily.temperature_2m_max[i],
    rain_chance_percent: rain,
    wind_max_kmh: daily.wind_speed_10m_max[i],
    outdoor_advice: wet ? "비 가능성이 높아 실내 장소를 권장" : "야외 활동에 무리 없음",
  };
}

const toolDefinitions = [
  {
    name: "find_spots",
    description:
      "제주도 관광지 목록에서 지역(동쪽 · 서쪽 · 서귀포 · 제주시)과 실내/야외 여부로 장소를 찾아 최대 8곳을 돌려준다. " +
      "목록 밖 장소는 없다: 이 도구가 돌려준 장소만 추천하고, 결과에 없는 장소는 지어내지 말 것. " +
      "운영시간 · 요금 · 휴무는 담겨 있지 않다.",
    input_schema: {
      type: "object",
      properties: {
        area: {
          type: "string",
          enum: AREAS,
          description: "찾을 지역",
        },
        indoor: {
          type: "boolean",
          description: "true 면 실내만, false 면 야외만. 생략하면 구분하지 않는다.",
        },
      },
      required: ["area"],
    },
  },
  {
    name: "open_meteo",
    description:
      "제주 지역(동쪽 · 서쪽 · 서귀포 · 제주시)의 날짜별 날씨 예보(날씨 · 기온 · 강수확률 · 풍속)를 돌려준다. " +
      "오늘부터 7일 이내만 조회 가능. 결과의 outdoor_advice 를 보고 실내/야외 중 무엇을 추천할지 정한다.",
    input_schema: {
      type: "object",
      properties: {
        area: { type: "string", enum: AREAS, description: "날씨를 볼 지역" },
        date: { type: "string", description: "YYYY-MM-DD. 생략하면 오늘." },
      },
      required: ["area"],
    },
  },
];

const handlers = { find_spots: findSpots, open_meteo: openMeteo };

async function runTool(name, input) {
  const handler = handlers[name];
  if (!handler) return { error: `알 수 없는 도구: ${name}` };
  return handler(input || {});
}

module.exports = { toolDefinitions, runTool, findSpots, openMeteo };
