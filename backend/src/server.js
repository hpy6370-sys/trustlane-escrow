const config = require("./config");
const { openDb } = require("./db");
const { createChain } = require("./chain");
const { createIndexer } = require("./indexer");
const { createApp } = require("./app");

const db = openDb(config.databasePath);
const chain = createChain(config);
const indexer = createIndexer({ db, chain, config });
const app = createApp({ db, chain, config, indexer });

const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port}  chainId=${config.chainId}  rpc=${config.rpcUrl}`);
  if (!chain.available) console.warn(`[api] no contract deployment for chainId ${config.chainId}; on-chain features off`);
  if (config.indexer.enabled) indexer.start();
});

function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  indexer.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => console.error("[api] unhandled rejection", err));
