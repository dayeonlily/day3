const { findSpots } = require("./tools");

// GET /api/spots?area=동쪽&indoor=true  (indoor 는 생략 가능)
module.exports = (req, res) => {
  const { area, indoor } = req.query;
  const result = findSpots({
    area,
    indoor: indoor === undefined || indoor === "" ? undefined : indoor === "true",
  });
  res.status(result.error ? 400 : 200).json(result);
};
