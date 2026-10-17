// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, req, signIn, totp } from "./fake-env.mjs";
import worker from "../src/index.js";
import { hotp } from "../src/auth.js";

const ctx = { waitUntil() {} };
const call = (env, path, opts) => worker.fetch(req(path, opts), env, ctx);

// A signed-in env, and a fetch that carries its cookie.
async function session() {
  const env = makeEnv();
  const { cookie } = await signIn(worker, env);
  const as = (path, opts = {}) => call(env, path, { ...opts, headers: { cookie, ...(opts.headers || {}) } });
  return { env, cookie, as };
}

test("HOTP matches the RFC 4226 / 6238 SHA-1 test vector", async () => {
  // RFC 6238: secret "12345678901234567890", T = 59 s -> counter 1 -> 94287082.
  const key = new TextEncoder().encode("12345678901234567890");
  assert.equal(await hotp(key, 1), "287082");
});

test("sign-in needs the password and a fresh code", async () => {
  const env = makeEnv();
  const code = totp();
  const first = await signIn(worker, env, code);
  assert.equal(first.res.status, 200);
  assert.match(first.cookie, /^__Host-session=/);
  assert.equal((await signIn(worker, env, code)).res.status, 401, "same code twice");
  assert.equal((await signIn(worker, env, totp(-1))).res.status, 401, "older code after a newer one");
  const bad = await call(env, "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nope", code: totp(1) }),
  });
  assert.equal(bad.status, 401);
});

test("logging out ends the session", async () => {
  const { as } = await session();
  assert.equal((await as("/api/list?prefix=")).status, 200);
  assert.equal((await as("/api/logout", { method: "POST" })).status, 200);
  assert.equal((await as("/api/list?prefix=")).status, 401);
});

test("signed out: the API refuses, the page is the login form", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "/api/list?prefix=")).status, 401);
  const page = await call(env, "/");
  assert.match(await page.text(), /id="loginForm"/);
});

test("cross-site requests can't change anything", async () => {
  const { as } = await session();
  const del = await as("/api/object?key=a.txt", { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(del.status, 403);
  const share = await as("/api/sign?key=a.txt&share=1", { headers: { "sec-fetch-site": "same-site" } });
  assert.equal(share.status, 403);
});

test("pages carry a CSP that allows their own scripts by hash", async () => {
  const { as } = await session();
  const res = await as("/");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(await res.text(), /id="fileTable"/);
});

test("a folder past 1000 entries is listed whole", async () => {
  const { env, as } = await session();
  for (let i = 0; i < 1500; i++) env.DRIVE_BUCKET.seed("Big/f" + String(i).padStart(4, "0") + ".txt", "x");
  env.DRIVE_BUCKET.seed("Big/sub/inner.txt", "y");
  const data = await (await as("/api/list?prefix=Big/")).json();
  assert.equal(data.files.length, 1500);
  assert.deepEqual(data.folders.map((f) => f.prefix), ["Big/sub/"]);
});

test("uploading over a file asks first, and the old one goes to the trash", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("Docs/a.txt", "old");
  assert.equal((await as("/api/object?key=Docs/a.txt", { method: "PUT", body: "new" })).status, 409);
  assert.equal((await as("/api/object?key=Docs/a.txt&replace=1", { method: "PUT", body: "new" })).status, 200);
  assert.equal(await (await as("/api/object?key=Docs/a.txt")).text(), "new");
  assert.equal(await (await as("/api/object?key=.trash/Docs/a.txt")).text(), "old");
});

test("an HTML or SVG file never comes back as a thumbnail", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("x.svg", "<svg onload=alert(1)>", "image/svg+xml");
  env.DRIVE_BUCKET.seed("x.html", "<script>alert(1)</script>", "text/html");
  env.DRIVE_BUCKET.seed("p.png", "PNG", "image/png");
  assert.equal((await as("/api/thumb?key=x.svg")).status, 415);
  assert.equal((await as("/api/thumb?key=x.html")).status, 415);
  const png = await as("/api/thumb?key=p.png");
  assert.equal(png.status, 200);
  assert.match(png.headers.get("content-security-policy"), /sandbox/);
});

test("HTML opened for viewing is plain text in a sandbox", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("x.html", "<script>alert(1)</script>", "text/html");
  const res = await as("/api/object?key=x.html&view=1");
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
});

test("downloads answer ranges and conditional requests", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("v.txt", "0123456789");
  const part = await as("/api/object?key=v.txt", { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await part.text(), "2345");
  const tail = await as("/api/object?key=v.txt", { headers: { range: "bytes=-3" } });
  assert.equal(tail.headers.get("content-range"), "bytes 7-9/10");
  const etag = (await as("/api/object?key=v.txt")).headers.get("etag");
  assert.equal((await as("/api/object?key=v.txt", { headers: { "if-none-match": etag } })).status, 304);
});

test("folder sizes come from a cached index that changes invalidate", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("Docs/a.txt", "12345");
  const size = async () => (await (await as("/api/list?prefix=")).json()).folders.find((f) => f.prefix === "Docs/").size;
  assert.equal(await size(), 5);
  const before = env.DRIVE_BUCKET.listCalls;
  await size();
  assert.equal(env.DRIVE_BUCKET.listCalls - before, 1, "second listing reuses the index");
  await as("/api/object?key=Docs/b.txt", { method: "PUT", body: "123" });
  assert.equal(await size(), 8, "an upload shows straight away");
});

test("unshared signed links last 5 minutes at most", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("a.txt", "a");
  const { url } = await (await as("/api/sign?key=a.txt&ttl=86400")).json();
  const exp = +new URL(url).searchParams.get("exp");
  assert.ok(exp - Date.now() / 1000 <= 301);
  const signed = await call(env, new URL(url).pathname + new URL(url).search);
  assert.equal(await signed.text(), "a");
});

test("the chat stops at the monthly budget", async () => {
  const { env, as } = await session();
  const month = new Date().toISOString().slice(0, 7);
  env.DRIVE_BUCKET.seed(".config/chat-usage/" + month + ".json", JSON.stringify({ questions: 1, input_tokens: 0, output_tokens: 0, cost: 25 }));
  const res = await as("/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(res.status, 429);
});

test("the page's inline script parses", async () => {
  const { as } = await session();
  const html = await (await as("/")).text();
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
});
