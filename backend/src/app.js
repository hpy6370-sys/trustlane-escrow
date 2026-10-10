const express = require("express");
const cors = require("cors");
const { rateLimit } = require("express-rate-limit");
const { createAuth } = require("./auth");
const { AppError, notFoundHandler, errorHandler } = require("./errors");

/** Builds the Express app. Dependencies are injected so tests can use an in-memory DB. */
function createApp({ db, chain, config, indexer }) {
  const app = express();
  const auth = createAuth({ db, chain, config });

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Render/Railway/Nginx
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes("*") || config.corsOrigins.includes(origin)),
    })
  );
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", async (_req, res) => {
    let rpc = "disabled";
    if (chain.available) {
      try {
        await Promise.race([
          chain.provider.getBlockNumber(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
        ]);
        rpc = "ok";
      } catch (err) {
        rpc = `error: ${err.shortMessage || err.message}`;
      }
    }
    db.prepare("SELECT 1").get();
    res.json({
      status: "ok",
      time: new Date().toISOString(),
      chainId: chain.chainId,
      contractsDeployed: chain.available,
      db: "ok",
      rpc,
      indexer: { running: indexer.status.running, lastBlock: indexer.status.lastBlock, lastError: indexer.status.lastError },
    });
  });

  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Too many sign-in attempts, try again in a minute")),
  });
  app.use("/api/auth", authLimiter, auth.router);
  app.use("/api/escrows", require("./routes/escrows")({ db, chain }));
  app.use("/api/events", require("./routes/events")({ db }));
  app.use("/api/users", require("./routes/users")({ db, chain, auth }));
  app.use("/api/documents", require("./routes/documents")({ db, auth }));
  app.use("/api/stats", require("./routes/stats")({ db, chain }));
  app.use("/api/disputes", require("./routes/disputes")({ db, auth }));
  app.use("/api/admin", require("./routes/admin")({ db, chain, auth, indexer }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
