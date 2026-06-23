const { handleApiRequest } = require("../backend");

module.exports = async (req, res) => {
  try {
    const handled = await handleApiRequest(req, res, req.url);

    if (!handled && !res.writableEnded) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Not found" }));
    }
  } catch (error) {
    console.error("Error procesando la API:", error);

    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
};
