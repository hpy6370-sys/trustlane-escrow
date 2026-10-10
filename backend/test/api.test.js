// Run with: npm test   (node:test, no extra deps). Uses an in-memory DB and no chain.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const { openDb } = require("../src/db");
const { createChain } = require("../src/chain");
const { createIndexer } = require("../src/indexer");
const { createApp } = require("../src/app");

const admin = ethers.Wallet.createRandom();
const config = {
  jwtSecret: "test-secret",
  jwtTtl: "1h",
  corsOrigins: ["*"],
  chainId: 999999, // no deployment for this id -> chain features off, fallbacks used
  rpcUrl: "http://127.0.0.1:1",
  indexer: { enabled: false, pollMs: 1000, logChunk: 100, confirmations: 0 },
  adminFallback: [admin.address.toLowerCase()],
  siweDomain: "test.local",
  nonceTtlMs: 60_000,
};

let server, base, db;
before(async () => {
  db = openDb(":memory:");
  const chain = createChain(config);
  const indexer = createIndexer({ db, chain, config, log: {} });
  const app = createApp({ db, chain, config, indexer });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, { body, token, raw } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(8000),
  });
  return { status: res.status, body: await res.json() };
};

async function signIn(wallet) {
  const n = await call("GET", `/api/auth/nonce?address=${wallet.address}`);
  assert.equal(n.status, 200);
  const signature = await wallet.signMessage(n.body.message);
  return call("POST", "/api/auth/verify", { body: { address: wallet.address, signature } });
}

test("health responds ok", async () => {
  const r = await call("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  assert.equal(r.body.db, "ok");
  assert.equal(r.body.contractsDeployed, false);
});

test("unknown route -> 404 JSON error", async () => {
  const r = await call("GET", "/api/nope");
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, "NOT_FOUND");
});

test("malformed JSON body -> 400 INVALID_JSON", async () => {
  const r = await call("POST", "/api/auth/verify", { raw: "{not json" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "INVALID_JSON");
});

test("nonce rejects a bad address", async () => {
  const r = await call("GET", "/api/auth/nonce?address=0x123");
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /address/);
});

test("SIWE-style sign-in issues a JWT and the nonce is single-use", async () => {
  const w = ethers.Wallet.createRandom();
  const n = await call("GET", `/api/auth/nonce?address=${w.address}`);
  assert.match(n.body.message, /wants you to sign in with your Ethereum account/);
  assert.match(n.body.message, new RegExp(w.address));
  const signature = await w.signMessage(n.body.message);
  const ok = await call("POST", "/api/auth/verify", { body: { address: w.address, signature } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.deepEqual(ok.body.roles, []);
  // replay the same signature -> nonce already burned
  const replay = await call("POST", "/api/auth/verify", { body: { address: w.address, signature } });
  assert.equal(replay.status, 401);

  const me = await call("GET", "/api/auth/me", { token: ok.body.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.address, w.address.toLowerCase());
});

test("signature from a different wallet is rejected", async () => {
  const victim = ethers.Wallet.createRandom();
  const attacker = ethers.Wallet.createRandom();
  const n = await call("GET", `/api/auth/nonce?address=${victim.address}`);
  const signature = await attacker.signMessage(n.body.message);
  const r = await call("POST", "/api/auth/verify", { body: { address: victim.address, signature } });
  assert.equal(r.status, 401);
  assert.match(r.body.error.message, /does not match/);
});

test("protected routes require a valid token", async () => {
  assert.equal((await call("PUT", "/api/users/me", { body: {} })).status, 401);
  const bad = await call("PUT", "/api/users/me", { body: {}, token: "garbage" });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, "INVALID_TOKEN");
});

test("profile update validates input and persists", async () => {
  const w = ethers.Wallet.createRandom();
  const { body } = await signIn(w);
  const bad = await call("PUT", "/api/users/me", { token: body.token, body: { email: "not-an-email" } });
  assert.equal(bad.status, 400);
  const ok = await call("PUT", "/api/users/me", {
    token: body.token,
    body: { displayName: "Ada", email: "ada@example.com", skills: ["solidity", "react"] },
  });
  assert.equal(ok.status, 200);
  const pub = await call("GET", `/api/users/${w.address}`);
  assert.equal(pub.body.profile.display_name, "Ada");
  assert.deepEqual(pub.body.profile.skills, ["solidity", "react"]);
  assert.equal(pub.body.profile.email, undefined, "email must not be public");
});

test("documents are content-addressed and verifiable", async () => {
  const { body } = await signIn(ethers.Wallet.createRandom());
  const c = await call("POST", "/api/documents", {
    token: body.token,
    body: { kind: "terms", title: "Logo", body: "3 concepts, 2 revisions" },
  });
  assert.equal(c.status, 201);
  assert.match(c.body.hash, /^0x[0-9a-f]{64}$/);
  const again = await call("POST", "/api/documents", {
    token: body.token,
    body: { kind: "terms", title: "Logo", body: "3 concepts, 2 revisions" },
  });
  assert.equal(again.status, 200, "same content -> same hash, idempotent");
  const g = await call("GET", `/api/documents/${c.body.hash}`);
  assert.equal(g.body.verified, true);
  const bad = await call("POST", "/api/documents", { token: body.token, body: { kind: "poem", body: "x" } });
  assert.equal(bad.status, 400);
});

test("admin routes enforce role (403 for others, 200 for admin)", async () => {
  const user = await signIn(ethers.Wallet.createRandom());
  assert.equal((await call("GET", "/api/admin/overview", { token: user.body.token })).status, 403);
  const adm = await signIn(admin);
  assert.deepEqual(adm.body.roles, ["admin"]);
  const r = await call("GET", "/api/admin/overview", { token: adm.body.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.indexer);
});

test("list endpoints validate query params", async () => {
  assert.equal((await call("GET", "/api/escrows?pageSize=1000")).status, 400);
  assert.equal((await call("GET", "/api/escrows?status=Weird")).status, 400);
  assert.equal((await call("GET", "/api/escrows/abc")).status, 400);
  assert.equal((await call("GET", "/api/escrows/42")).status, 404);
  const ok = await call("GET", "/api/escrows?page=1&pageSize=5");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.items, []);
});

test("stats on an empty DB returns zero-filled series", async () => {
  const r = await call("GET", "/api/stats?days=7");
  assert.equal(r.status, 200);
  assert.equal(r.body.series.length, 7);
  assert.equal(r.body.totals.escrows, 0);
  assert.equal(r.body.totals.disputeRate, 0);
});

test("auth endpoints are rate-limited with a JSON 429", async () => {
  const addr = ethers.Wallet.createRandom().address;
  let last;
  for (let i = 0; i < 40; i++) last = await call("GET", `/api/auth/nonce?address=${addr}`);
  assert.equal(last.status, 429);
  assert.equal(last.body.error.code, "RATE_LIMITED");
});
