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

test("deleting two files of the same name keeps both in the trash", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("a.txt", "first");
  await as("/api/object?key=a.txt", { method: "DELETE" });
  env.DRIVE_BUCKET.seed("a.txt", "second");
  await as("/api/object?key=a.txt", { method: "DELETE" });
  const { files } = await (await as("/api/trash/list")).json();
  assert.equal(files.length, 2);
  assert.deepEqual(files.map((f) => f.original), ["a.txt", "a.txt"]);
  const texts = [];
  for (const f of files) texts.push(await (await as("/api/object?key=" + encodeURIComponent(f.key))).text());
  assert.deepEqual(texts.sort(), ["first", "second"]);
  // The first restore puts a.txt back; the second finds the name taken.
  assert.equal((await as("/api/trash/restore?key=" + encodeURIComponent(files[1].key), { method: "POST" })).status, 200);
  assert.equal((await as("/api/trash/restore?key=" + encodeURIComponent(files[0].key), { method: "POST" })).status, 409);
});

test("moving or restoring a file keeps its date", async () => {
  const { env, as } = await session();
  env.DRIVE_BUCKET.seed("old.txt", "x", "text/plain", new Date("2020-05-01T10:00:00Z"));
  await as("/api/rename?from=old.txt&to=Docs/old.txt", { method: "POST" });
  const listed = await (await as("/api/list?prefix=Docs/")).json();
  assert.equal(listed.files[0].uploaded, "2020-05-01T10:00:00.000Z");
  await as("/api/object?key=Docs/old.txt", { method: "DELETE" });
  await as("/api/trash/restore?key=" + encodeURIComponent(".trash/Docs/old.txt"), { method: "POST" });
  const back = await (await as("/api/list?prefix=Docs/")).json();
  assert.equal(back.files[0].uploaded, "2020-05-01T10:00:00.000Z");
  assert.equal(env.DRIVE_BUCKET.store.get("Docs/old.txt").meta.original, undefined, "trash bookkeeping is dropped on restore");
});

test("big files upload in parts, with the same overwrite rule", async () => {
  const { env, as } = await session();
  const create = async (q) => as("/api/upload/create?key=big.bin" + q, { method: "POST", headers: { "x-content-type": "application/octet-stream" } });
  const { uploadId } = await (await create("")).json();
  const base = "?key=big.bin&uploadId=" + uploadId;
  const p1 = await (await as("/api/upload/part" + base + "&part=1", { method: "PUT", body: "hello " })).json();
  const p2 = await (await as("/api/upload/part" + base + "&part=2", { method: "PUT", body: "world" })).json();
  const done = await as("/api/upload/complete" + base, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [p1, p2] }),
  });
  assert.equal(done.status, 200);
  assert.equal(await (await as("/api/object?key=big.bin")).text(), "hello world");
  assert.equal((await create("")).status, 409, "exists: refused without replace");
  const again = await (await create("&replace=1")).json();
  const b2 = "?key=big.bin&replace=1&uploadId=" + again.uploadId;
  const q1 = await (await as("/api/upload/part" + b2 + "&part=1", { method: "PUT", body: "v2" })).json();
  await as("/api/upload/complete" + b2, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [q1] }) });
  assert.equal(await (await as("/api/object?key=big.bin")).text(), "v2");
  assert.equal(await (await as("/api/object?key=.trash/big.bin")).text(), "hello world");
});

test("the page's inline script parses", async () => {
  const { as } = await session();
  const html = await (await as("/")).text();
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
});

test("MCP needs its token, then searches and lists Ressources/", async () => {
  const env = makeEnv();
  env.MCP_TOKEN = "mcp-test-token";
  env.DOCS_SEARCH = { async search() { return { chunks: [{ text: "Budget 2026: 12 k€", item: { key: "Ressources/a.pdf" } }] }; } };
  env.DRIVE_BUCKET.seed("Ressources/Orange docs/b.pdf", "x", "application/pdf");
  const rpc = (body, token = "mcp-test-token") => call(env, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token, "sec-fetch-site": "" },
    body: JSON.stringify({ jsonrpc: "2.0", ...body }),
  });
  assert.equal((await rpc({ id: 1, method: "tools/list" }, "wrong")).status, 401);
  const init = await (await rpc({ id: 1, method: "initialize", params: {} })).json();
  assert.equal(init.result.serverInfo.name, "dmzs-drive");
  assert.equal((await rpc({ method: "notifications/initialized" })).status, 202);
  const tools = await (await rpc({ id: 2, method: "tools/list" })).json();
  assert.deepEqual(tools.result.tools.map((t) => t.name), ["search_documents", "list_documents"]);
  const found = await (await rpc({ id: 3, method: "tools/call", params: { name: "search_documents", arguments: { query: "budget" } } })).json();
  assert.match(found.result.content[0].text, /a\.pdf[\s\S]*12 k€/);
  const list = await (await rpc({ id: 4, method: "tools/call", params: { name: "list_documents", arguments: { folder: "Orange docs" } } })).json();
  assert.match(list.result.content[0].text, /Ressources\/Orange docs\/b\.pdf/);
});

test("OAuth: register, approve while signed in, PKCE token, then MCP", async () => {
  const { env, as } = await session();
  const s = (path, opts = {}) => call(env, path, { ...opts, headers: { "sec-fetch-site": "cross-site", ...(opts.headers || {}) } });
  const unauth = await s("/mcp", { method: "POST", body: "{}" });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get("www-authenticate"), /resource_metadata=/);
  assert.equal((await (await s("/.well-known/oauth-authorization-server")).json()).token_endpoint, "https://drive.test/oauth/token");

  const redirect = "https://claude.ai/api/mcp/auth_callback";
  assert.equal((await s("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) })).status, 400);
  const { client_id } = await (await s("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: [redirect], client_name: "Claude" }) })).json();

  const verifier = "v".repeat(50);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const q = new URLSearchParams({ client_id, redirect_uri: redirect, state: "xyz", code_challenge: challenge, code_challenge_method: "S256", response_type: "code" });
  assert.doesNotMatch(await (await s("/oauth/authorize?" + q)).text(), /Allow access/); // signed out: login page
  assert.match(await (await as("/oauth/authorize?" + q)).text(), /Allow access/);
  const approved = await as("/oauth/authorize", { method: "POST", body: q });
  const loc = new URL(approved.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, redirect);
  assert.equal(loc.searchParams.get("state"), "xyz");

  const tok = (extra) => s("/oauth/token", { method: "POST", body: new URLSearchParams({ client_id, ...extra }) });
  const code = loc.searchParams.get("code");
  assert.equal((await tok({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: "wrong" })).status, 400);
  // The failed try burnt the code: a code is single use.
  const approved2 = await as("/oauth/authorize", { method: "POST", body: q });
  const code2 = new URL(approved2.headers.get("location")).searchParams.get("code");
  const t = await (await tok({ grant_type: "authorization_code", code: code2, redirect_uri: redirect, code_verifier: verifier })).json();
  assert.ok(t.access_token && t.refresh_token);

  env.DOCS_SEARCH = { async search() { return { chunks: [] }; } };
  const ok = await s("/mcp", { method: "POST", headers: { authorization: "Bearer " + t.access_token }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(ok.status, 200);
  const r = await (await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token })).json();
  assert.ok(r.access_token);
  assert.equal((await tok({ grant_type: "refresh_token", refresh_token: t.refresh_token })).status, 400);
});
