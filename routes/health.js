function registerHealthRoutes(app) {
  app.get("/", (req, res) => {
    res.send("WA Checker is alive");
  });

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      time: new Date().toISOString()
    });
  });
}

module.exports = {
  registerHealthRoutes
};