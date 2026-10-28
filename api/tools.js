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
];

const handlers = { find_spots: findSpots };

function runTool(name, input) {
  const handler = handlers[name];
  if (!handler) return { error: `알 수 없는 도구: ${name}` };
  return handler(input || {});
}

module.exports = { toolDefinitions, runTool, findSpots };
