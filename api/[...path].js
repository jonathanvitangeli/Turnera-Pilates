const { handleApiRequest } = require("../backend");

module.exports = async (req, res) => {
  const handled = await handleApiRequest(req, res, req.url);

  if (!handled) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Not found" }));
  }
};
