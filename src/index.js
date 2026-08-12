// dmzs-drive — a small personal file drive backed by Cloudflare R2.
//
// Auth: session cookie obtained via POST /api/login with the password AND a
// 6-digit TOTP code from an authenticator app (Microsoft/Google Authenticator).
// Secrets (set with `npx wrangler secret put <NAME>`):
//   AUTH_PASS   — the password
//   TOTP_SECRET — base32 seed for the authenticator app
//
// Routes (all /api/* require a valid session unless noted):
//   POST /api/login {password, code}      -> sets session cookie (public)
//   POST /api/logout                      -> clears the cookie
//   GET  /api/list?prefix=foo/            -> { prefix, folders: [...], files: [...] }
//   PUT  /api/object?key=foo/bar.txt      -> upload (body = file contents)
//   GET  /api/object?key=foo/bar.txt      -> download
//   DELETE /api/object?key=foo/bar.txt    -> soft-delete (moves into .trash/)
//   POST /api/mkdir?key=foo/bar/          -> create an empty folder
//   GET  /api/trash/list                  -> everything currently in the trash
//   POST /api/trash/restore?key=.trash/x  -> move back to original location
//   DELETE /api/trash/object?key=.trash/x -> delete permanently
//   POST /api/trash/empty                 -> permanently delete the whole trash
//   *    everything else                  -> the UI (login page when signed out)
//
// A daily cron (see wrangler.jsonc "triggers") purges trash entries older
// than TRASH_RETENTION_DAYS.

import { ICON_192, ICON_512, APPLE_ICON } from "./icons.js";

const TRASH = ".trash/";
const SESSION_DAYS = 30;
const TRASH_RETENTION_DAYS = 30;

const MANIFEST = {
  name: "Damien's Drive",
  short_name: "Drive",
  start_url: "/",
  display: "standalone",
  background_color: "#14161a",
  theme_color: "#2563eb",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    // PWA assets are public: they contain nothing sensitive and the browser
    // fetches the manifest without credentials.
    if (request.method === "GET") {
      if (url.pathname === "/manifest.json") {
        return Response.json(MANIFEST, { headers: { "cache-control": "public, max-age=3600" } });
      }
      if (url.pathname === "/icon-192.png") return pngResponse(ICON_192);
      if (url.pathname === "/icon-512.png") return pngResponse(ICON_512);
      if (url.pathname === "/apple-touch-icon.png") return pngResponse(APPLE_ICON);
    }

    // Time-limited signed links: lets the Office preview's external viewer
    // fetch a document without our session cookie. Signed, single-file, 5 min.
    if (url.pathname === "/api/object" && request.method === "GET" && url.searchParams.has("sig")) {
      if (await verifySignedUrl(url, env)) return handleDownload(url, env);
      return new Response("Invalid or expired link", { status: 403 });
    }

    if (!(await isAuthed(request, env))) {
      if (url.pathname.startsWith("/api/")) {
        return new Response("Unauthorized", { status: 401 });
      }
      return htmlResponse(LOGIN_HTML);
    }

    try {
      if (url.pathname === "/api/logout" && request.method === "POST") {
        return handleLogout();
      }
      if (url.pathname === "/api/list" && request.method === "GET") {
        return await handleList(url, env);
      }
      if (url.pathname === "/api/object") {
        if (request.method === "PUT") return await handleUpload(request, url, env);
        if (request.method === "GET") return await handleDownload(url, env);
        if (request.method === "DELETE") return await handleSoftDelete(url, env);
      }
      if (url.pathname === "/api/mkdir" && request.method === "POST") {
        return await handleMkdir(url, env);
      }
      if (url.pathname === "/api/sign" && request.method === "GET") {
        return await handleSign(url, env);
      }
      if (url.pathname === "/api/rename" && request.method === "POST") {
        return await handleRename(url, env);
      }
      if (url.pathname === "/api/movedir" && request.method === "POST") {
        return await handleMoveDir(url, env);
      }
      if (url.pathname === "/api/search" && request.method === "GET") {
        return await handleSearch(url, env);
      }
      if (url.pathname === "/api/usage" && request.method === "GET") {
        return await handleUsage(env);
      }
      if (url.pathname === "/api/trash/list" && request.method === "GET") {
        return await handleTrashList(env);
      }
      if (url.pathname === "/api/trash/restore" && request.method === "POST") {
        return await handleTrashRestore(url, env);
      }
      if (url.pathname === "/api/trash/object" && request.method === "DELETE") {
        return await handleTrashDelete(url, env);
      }
      if (url.pathname === "/api/trash/empty" && request.method === "POST") {
        return await handleTrashEmpty(env);
      }
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }

    // Anything else (including "/") serves the UI.
    return htmlResponse(HTML);
  },

  // Daily cron: purge trash entries older than the retention window.
  async scheduled(controller, env) {
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400 * 1000;
    const expired = (await listAllTrash(env))
      .filter((o) => new Date(o.uploaded).getTime() < cutoff)
      .map((o) => o.key);
    for (let i = 0; i < expired.length; i += 1000) {
      await env.DRIVE_BUCKET.delete(expired.slice(i, i + 1000));
    }
  },
};

function htmlResponse(body) {
  return new Response(body, { headers: { "content-type": "text/html;charset=UTF-8" } });
}

function pngResponse(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
  });
}

// ---------- Auth ----------

async function handleLogin(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {}

  const passOk = !!env.AUTH_PASS && (await safeEqual(body.password || "", env.AUTH_PASS));
  const codeOk = !!env.TOTP_SECRET && (await verifyTotp(env.TOTP_SECRET, body.code || ""));
  if (!passOk || !codeOk) {
    await new Promise((r) => setTimeout(r, 800)); // slow down brute-force attempts
    return new Response("Invalid credentials", { status: 401 });
  }

  const maxAge = SESSION_DAYS * 86400;
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const token = exp + "." + (await hmacHex(sessionKey(env), String(exp)));
  return new Response("OK", {
    headers: {
      "Set-Cookie": `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    },
  });
}

function handleLogout() {
  return new Response("OK", {
    headers: { "Set-Cookie": "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0" },
  });
}

// Sessions are self-contained: "<expiry>.<hmac>". Changing either secret
// invalidates every outstanding session.
function sessionKey(env) {
  return env.AUTH_PASS + "|" + env.TOTP_SECRET;
}

async function isAuthed(request, env) {
  if (!env.AUTH_PASS || !env.TOTP_SECRET) return false;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return false;
  const [expStr, sig] = m[1].split(".");
  const exp = parseInt(expStr, 10);
  if (!exp || Math.floor(Date.now() / 1000) > exp) return false;
  const expected = await hmacHex(sessionKey(env), expStr);
  return safeEqual(sig || "", expected);
}

async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison: compare fixed-length digests instead of the
// raw variable-length strings.
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---------- Signed URLs ----------

const SIGNED_URL_TTL_SECONDS = 300;

async function handleSign(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  // Default 5 min (previews); share links may ask for up to 7 days.
  const requested = parseInt(url.searchParams.get("ttl") || "", 10);
  const ttl = Math.min(Math.max(requested || SIGNED_URL_TTL_SECONDS, 60), 7 * 86400);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmacHex(sessionKey(env), "url|" + key + "|" + exp);
  return Response.json({
    url:
      url.origin + "/api/object?key=" + encodeURIComponent(key) +
      "&view=1&exp=" + exp + "&sig=" + sig,
  });
}

async function verifySignedUrl(url, env) {
  if (!env.AUTH_PASS || !env.TOTP_SECRET) return false;
  const key = url.searchParams.get("key") || "";
  const exp = parseInt(url.searchParams.get("exp") || "", 10);
  if (!exp || Math.floor(Date.now() / 1000) > exp) return false;
  const expected = await hmacHex(sessionKey(env), "url|" + key + "|" + exp);
  return safeEqual(url.searchParams.get("sig") || "", expected);
}

// ---------- TOTP (RFC 6238, SHA-1, 30s steps, 6 digits) ----------

async function verifyTotp(secretB32, code) {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) { // allow one step of clock drift either way
    if ((await hotp(key, step + w)) === code) return true;
  }
  return false;
}

async function hotp(keyBytes, counter) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter); // counters fit in 32 bits until year ~6000
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
  const off = sig[19] & 0xf;
  const bin =
    ((sig[off] & 0x7f) << 24) | (sig[off + 1] << 16) | (sig[off + 2] << 8) | sig[off + 3];
  return String(bin % 1000000).padStart(6, "0");
}

function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const out = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const idx = A.indexOf(c);
    if (idx === -1) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---------- Drive ----------

async function handleList(url, env) {
  const prefix = url.searchParams.get("prefix") || "";
  const listed = await env.DRIVE_BUCKET.list({ prefix, delimiter: "/" });

  const folders = (listed.delimitedPrefixes || []).filter((p) => p !== TRASH).sort();
  const files = listed.objects
    .filter((o) => o.key !== prefix) // hide the folder's own zero-byte marker, if any
    .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return Response.json({ prefix, folders, files });
}

async function handleUpload(request, url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (key.startsWith(TRASH)) return new Response("Reserved prefix", { status: 400 });

  await env.DRIVE_BUCKET.put(key, request.body, {
    httpMetadata: {
      contentType: request.headers.get("content-type") || "application/octet-stream",
    },
  });
  return new Response("OK");
}

async function handleDownload(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

  const object = await env.DRIVE_BUCKET.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  const filename = key.split("/").pop();
  if (url.searchParams.get("view") === "1") {
    // Inline viewing (PDFs, images, text render natively in the browser).
    let ct = (headers.get("content-type") || "").toLowerCase();
    // Files stored without a useful type (e.g. uploaded without an extension)
    // get sniffed from their first bytes so PDFs and images still preview.
    if (!ct || ct === "application/octet-stream") {
      const head = await env.DRIVE_BUCKET.get(key, { range: { offset: 0, length: 16 } });
      if (head) {
        const sniffed = sniffType(new Uint8Array(await head.arrayBuffer()));
        if (sniffed) { ct = sniffed; headers.set("content-type", sniffed); }
      }
    }
    // Script-capable types are downgraded to plain text so an uploaded HTML/SVG
    // file can never run JavaScript inside the drive's origin.
    // (careful: Office mime types contain "openxmlformats" — don't match those)
    const scriptCapable = ct.includes("html") || ct.includes("svg") ||
      ct.startsWith("text/xml") || ct.startsWith("application/xml") || ct.includes("+xml");
    if (scriptCapable) {
      headers.set("content-type", "text/plain;charset=UTF-8");
    }
    headers.set("Content-Disposition", `inline; filename="${filename}"`);
  } else {
    headers.set("Content-Disposition", `attachment; filename="${filename}"`);
  }
  return new Response(object.body, { headers });
}

function sniffType(b) {
  const ascii = String.fromCharCode(...b.slice(0, 12));
  if (ascii.startsWith("%PDF")) return "application/pdf";
  if (b[0] === 0x89 && ascii.slice(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii.startsWith("GIF8")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

async function handleSoftDelete(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (key.startsWith(TRASH)) return new Response("Use /api/trash/*", { status: 400 });
  await moveObject(env, key, TRASH + key);
  return new Response("OK");
}

// Rename and move share this: both are "move object to a new key".
async function handleRename(url, env) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return new Response("Missing from/to", { status: 400 });
  if (from.startsWith(TRASH) || to.startsWith(TRASH)) {
    return new Response("Reserved prefix", { status: 400 });
  }
  if (from === to) return new Response("OK");
  if (await env.DRIVE_BUCKET.head(to)) {
    return new Response("Target exists", { status: 409 }); // never overwrite silently
  }
  await moveObject(env, from, to);
  return new Response("OK");
}

async function handleMkdir(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (key.startsWith(TRASH)) return new Response("Reserved prefix", { status: 400 });
  const folderKey = key.endsWith("/") ? key : key + "/";
  await env.DRIVE_BUCKET.put(folderKey, new Uint8Array());
  return new Response("OK");
}

// Moves a whole "folder" (every object under the prefix) to a new prefix.
// Conflicting destinations are skipped and reported, so a partial move can
// simply be re-run.
async function handleMoveDir(url, env) {
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  if (!from.endsWith("/") || !to.endsWith("/")) {
    return new Response("Prefixes must end with /", { status: 400 });
  }
  if (from.startsWith(TRASH) || to.startsWith(TRASH)) {
    return new Response("Reserved prefix", { status: 400 });
  }
  if (to === from) return Response.json({ moved: 0, failed: 0 });
  if (to.startsWith(from)) {
    return new Response("Cannot move a folder into itself", { status: 400 });
  }

  const keys = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix: from, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  let failed = 0;
  // Small batches: each move streams get->put concurrently and the runtime
  // caps simultaneous connections.
  for (let i = 0; i < keys.length; i += 3) {
    await Promise.all(keys.slice(i, i + 3).map(async (k) => {
      const dest = to + k.slice(from.length);
      if (await env.DRIVE_BUCKET.head(dest)) { failed++; return; }
      await moveObject(env, k, dest);
    }));
  }
  return Response.json({ moved: keys.length - failed, failed });
}

// ---------- Search & usage ----------

async function handleSearch(url, env) {
  const q = (url.searchParams.get("q") || "").toLowerCase();
  if (!q) return Response.json({ files: [] });
  const files = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ cursor });
    for (const o of page.objects) {
      if (o.key.startsWith(TRASH) || o.key.endsWith("/")) continue;
      if (o.key.toLowerCase().includes(q)) {
        files.push({ key: o.key, size: o.size, uploaded: o.uploaded });
      }
    }
    cursor = page.truncated && files.length < 300 ? page.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => a.key.localeCompare(b.key));
  return Response.json({ files: files.slice(0, 300) });
}

async function handleUsage(env) {
  let driveBytes = 0, driveCount = 0, trashBytes = 0;
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ cursor });
    for (const o of page.objects) {
      if (o.key.startsWith(TRASH)) trashBytes += o.size;
      else if (!o.key.endsWith("/")) { driveBytes += o.size; driveCount++; }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return Response.json({ driveBytes, driveCount, trashBytes });
}

// ---------- Trash ----------

async function handleTrashList(env) {
  const files = (await listAllTrash(env))
    .filter((o) => !o.key.endsWith("/")) // hide folder markers
    .map((o) => ({
      key: o.key,
      original: o.key.slice(TRASH.length),
      size: o.size,
      deleted: o.uploaded, // moving into the trash resets the upload time
    }))
    .sort((a, b) => a.original.localeCompare(b.original));
  return Response.json({ files });
}

async function handleTrashRestore(url, env) {
  const key = url.searchParams.get("key");
  if (!key || !key.startsWith(TRASH)) return new Response("Bad key", { status: 400 });
  await moveObject(env, key, key.slice(TRASH.length));
  return new Response("OK");
}

async function handleTrashDelete(url, env) {
  const key = url.searchParams.get("key");
  if (!key || !key.startsWith(TRASH)) return new Response("Bad key", { status: 400 });
  await env.DRIVE_BUCKET.delete(key);
  return new Response("OK");
}

async function handleTrashEmpty(env) {
  const keys = (await listAllTrash(env)).map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) {
    await env.DRIVE_BUCKET.delete(keys.slice(i, i + 1000));
  }
  return new Response("OK");
}

async function listAllTrash(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix: TRASH, cursor });
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

// R2 has no server-side copy in the binding API; stream the object across.
// FixedLengthStream keeps this working for objects of any size.
async function moveObject(env, from, to) {
  const src = await env.DRIVE_BUCKET.get(from);
  if (!src) return;
  if (src.size === 0) {
    await env.DRIVE_BUCKET.put(to, new Uint8Array(), { httpMetadata: src.httpMetadata });
  } else {
    const { readable, writable } = new FixedLengthStream(src.size);
    await Promise.all([
      src.body.pipeTo(writable),
      env.DRIVE_BUCKET.put(to, readable, { httpMetadata: src.httpMetadata }),
    ]);
  }
  await env.DRIVE_BUCKET.delete(from);
}

// NOTE ON THESE TEMPLATES: HTML is built with String.raw so that backslashes meant
// for the CLIENT-side script (e.g. the regex /\/$/) survive untouched. Because of
// that, the client-side scripts below deliberately avoid backtick template literals
// and ${...} interpolation entirely (string concatenation + DOM APIs instead) —
// otherwise those would either get evaluated too early, in this Worker's own scope,
// or be escaped incorrectly by the time they reach the browser. Keep it that way if
// you edit them.

const LOGIN_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Damien's Drive — sign in</title>
<link rel="manifest" href="/manifest.json" />
<link rel="icon" href="/icon-192.png" type="image/png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="theme-color" content="#2563eb" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --danger: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #f1f1f1;
      --muted: #9aa0a6;
      --border: #2b2f36;
      --accent: #5b8cff;
      --danger: #f87171;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  form {
    width: 100%;
    max-width: 340px;
    padding: 32px 28px;
    border: 1px solid var(--border);
    border-radius: 14px;
    margin: 16px;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 24px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 16px; }
  input {
    width: 100%;
    margin-top: 6px;
    padding: 10px 12px;
    font: inherit;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: transparent; }
  button {
    width: 100%;
    padding: 10px;
    font: inherit;
    font-weight: 600;
    color: white;
    background: var(--accent);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: default; }
  #err { color: var(--danger); font-size: 13px; min-height: 18px; margin-bottom: 12px; }
</style>
</head>
<body>
<form id="loginForm">
  <h1>Welcome back 👋</h1>
  <p class="sub">Your personal drive</p>
  <label>Password
    <input type="password" id="password" autocomplete="current-password" required autofocus />
  </label>
  <label>6-digit code
    <input id="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
           autocomplete="one-time-code" placeholder="From your authenticator app" required />
  </label>
  <div id="err"></div>
  <button type="submit" id="submitBtn">Sign in</button>
</form>
<script>
document.getElementById("loginForm").onsubmit = function (e) {
  e.preventDefault();
  var btn = document.getElementById("submitBtn");
  var err = document.getElementById("err");
  btn.disabled = true;
  err.textContent = "";
  fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: document.getElementById("password").value,
      code: document.getElementById("code").value,
    }),
  }).then(function (res) {
    if (res.ok) { window.location.reload(); return; }
    btn.disabled = false;
    err.textContent = "Wrong password or code. Try again.";
    document.getElementById("code").value = "";
  }).catch(function () {
    btn.disabled = false;
    err.textContent = "Network error. Try again.";
  });
};
</script>
</body>
</html>`;

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Damien's Drive</title>
<link rel="manifest" href="/manifest.json" />
<link rel="icon" href="/icon-192.png" type="image/png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="theme-color" content="#2563eb" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --fg: #1a1a1a;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #2563eb;
    --danger: #dc2626;
    --hover: #f3f4f6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --fg: #f1f1f1;
      --muted: #9aa0a6;
      --border: #2b2f36;
      --accent: #5b8cff;
      --danger: #f87171;
      --hover: #1e2127;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--fg);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  #breadcrumb { font-size: 13px; color: var(--muted); margin-top: 4px; }
  #breadcrumb span { cursor: pointer; }
  #breadcrumb span:hover { color: var(--accent); }
  main { flex: 1; min-width: 0; padding: 24px 32px; }
  #dropzone {
    border: 2px dashed var(--border);
    border-radius: 10px;
    padding: 28px;
    text-align: center;
    color: var(--muted);
    margin-bottom: 20px;
    transition: border-color .15s, color .15s;
  }
  #dropzone.drag { border-color: var(--accent); color: var(--accent); }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
  button {
    font: inherit;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
    cursor: pointer;
  }
  button:hover { background: var(--hover); }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.danger { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 8px; border-bottom: 1px solid var(--border); }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr.row:hover { background: var(--hover); }
  .name { cursor: pointer; overflow-wrap: anywhere; }
  .name:hover { color: var(--accent); }
  .size, .date { color: var(--muted); white-space: nowrap; }
  .actions { text-align: right; white-space: nowrap; }
  .actions button { padding: 3px 8px; font-size: 12px; margin-left: 4px; }
  #empty { color: var(--muted); text-align: center; padding: 40px 0; }
  #progress { font-size: 13px; color: var(--muted); margin-bottom: 12px; }
  #layout { display: flex; }
  #sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    padding: 12px 8px;
    overflow-y: auto;
    position: sticky;
    top: 0;
    align-self: flex-start;
    max-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #tree { flex: 1; }
  #usage {
    color: var(--muted);
    font-size: 12px;
    padding: 10px 6px 2px;
    border-top: 1px solid var(--border);
    margin-top: 10px;
  }
  .treeRow {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .treeRow:hover { background: var(--hover); }
  .treeRow.active { background: var(--hover); color: var(--accent); font-weight: 600; }
  .treeRow .arrow { width: 14px; flex-shrink: 0; text-align: center; color: var(--muted); }
  .treeChildren { margin-left: 14px; }
  .treeEmpty { color: var(--muted); font-size: 12px; padding: 2px 8px 2px 24px; }
  #searchBox {
    font: inherit;
    font-size: 13.5px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    width: 170px;
  }
  #searchBox:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  #selectionBar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    margin-bottom: 12px;
  }
  #selectionBar button { padding: 3px 10px; font-size: 12px; }
  .sel { width: 26px; }
  .sel input { accent-color: var(--accent); }
  tr.droptarget { outline: 2px solid var(--accent); outline-offset: -2px; }
  @keyframes flashRow {
    from { background: rgba(37, 99, 235, .28); }
    to { background: transparent; }
  }
  tr.flash { animation: flashRow 1.6s ease-out; }
  #breadcrumb span.droptarget, .treeRow.droptarget { color: var(--accent); background: var(--hover); }
  #previewOverlay {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgba(0, 0, 0, .78);
    display: flex;
    flex-direction: column;
  }
  #previewHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 16px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  #previewTitle { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  #previewBody {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
  }
  #previewBody iframe { width: 100%; height: 100%; border: none; background: white; }
  #previewBody img { max-width: 95%; max-height: 95%; object-fit: contain; }
  #previewBody video { max-width: 95%; max-height: 95%; }
  .noPreview { color: #eee; text-align: center; padding: 24px; }
  @media (max-width: 700px) {
    #sidebar { display: none; }
  }
  @media (max-width: 600px) {
    header { padding: 12px 16px; }
    main { padding: 16px; }
    .date { display: none; }
    th, td { padding: 6px 4px; }
    .actions button { padding: 3px 6px; font-size: 11px; margin-left: 2px; }
    #searchBox { width: 120px; }
    .toolbar { gap: 6px; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>Damien's Drive</h1>
    <div id="breadcrumb"></div>
  </div>
  <div class="toolbar">
    <input id="searchBox" type="search" placeholder="Search files…" />
    <button id="newFolderBtn">New folder</button>
    <button id="uploadBtn" class="primary">Upload</button>
    <button id="trashBtn">Trash</button>
    <button id="backBtn" style="display:none">&larr; Back to files</button>
    <button id="emptyTrashBtn" class="danger" style="display:none">Empty trash</button>
    <button id="logoutBtn">Log out</button>
    <input id="fileInput" type="file" multiple style="display:none" />
  </div>
</header>
<div id="layout">
  <nav id="sidebar"><div id="tree"></div><div id="usage"></div></nav>
  <main>
    <div id="dropzone">Drag files here, or click Upload</div>
    <div id="progress"></div>
    <div id="selectionBar" style="display:none">
      <span id="selectionCount"></span>
      <button id="bulkMoveBtn">Move to…</button>
      <button id="bulkDeleteBtn" class="danger">Delete</button>
      <button id="bulkClearBtn">Clear</button>
    </div>
    <table>
      <thead><tr><th class="sel"><input type="checkbox" id="selectAll" /></th><th>Name</th><th class="size">Size</th><th class="date" id="dateHeader">Modified</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="empty" style="display:none"></div>
  </main>
</div>
<div id="previewOverlay" style="display:none">
  <div id="previewHeader">
    <span id="previewTitle"></span>
    <div class="toolbar">
      <button id="previewDownloadBtn">Download</button>
      <button id="previewCloseBtn">Close</button>
    </div>
  </div>
  <div id="previewBody"></div>
</div>
<script>
var currentPrefix = "";
var mode = "files"; // "files" | "trash" | "search"
var searchQuery = "";
var previewKey = null;
var selected = [];
var lastFiles = [];
var searchTimer = null;
var lastDragEnd = 0;

function humanSize(bytes) {
  if (bytes === 0) return "0 B";
  var units = ["B", "KB", "MB", "GB", "TB"];
  var i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function humanDate(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Any API response that comes back 401 means the session expired: reload to
// land on the login page.
function checkAuth(res) {
  if (res.status === 401) { window.location.reload(); throw new Error("session expired"); }
  return res;
}

function setMode(m) {
  mode = m;
  var files = m === "files";
  var trash = m === "trash";
  document.getElementById("newFolderBtn").style.display = files ? "" : "none";
  document.getElementById("uploadBtn").style.display = files ? "" : "none";
  document.getElementById("trashBtn").style.display = trash ? "none" : "";
  document.getElementById("backBtn").style.display = trash ? "" : "none";
  document.getElementById("emptyTrashBtn").style.display = trash ? "" : "none";
  document.getElementById("dropzone").style.display = files ? "" : "none";
  document.getElementById("dateHeader").textContent = trash ? "Deleted" : "Modified";
  document.getElementById("selectAll").style.visibility = trash ? "hidden" : "";
  if (m !== "search") document.getElementById("searchBox").value = "";
  clearSelection();
}

// ---- Multi-select ----

function toggleSelect(key, on) {
  var i = selected.indexOf(key);
  if (on && i === -1) selected.push(key);
  if (!on && i !== -1) selected.splice(i, 1);
  updateSelectionBar();
}

function clearSelection() {
  selected = [];
  var all = document.getElementById("selectAll");
  if (all) all.checked = false;
  updateSelectionBar();
}

function updateSelectionBar() {
  document.getElementById("selectionBar").style.display = selected.length ? "flex" : "none";
  document.getElementById("selectionCount").textContent = selected.length + " selected";
}

function makeSelTd(key) {
  var td = document.createElement("td");
  td.className = "sel";
  if (key) {
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.indexOf(key) !== -1;
    cb.onchange = function () { toggleSelect(key, cb.checked); };
    cb.onclick = function (e) { e.stopPropagation(); };
    td.appendChild(cb);
  }
  return td;
}

function renderBreadcrumb() {
  var bc = document.getElementById("breadcrumb");
  bc.innerHTML = "";

  var root = document.createElement("span");
  root.textContent = "Home";
  root.onclick = function () { setMode("files"); load(""); };
  makeDropTarget(root, "");
  bc.appendChild(root);

  if (mode !== "files") {
    bc.appendChild(document.createTextNode(" / "));
    var t = document.createElement("span");
    t.textContent = mode === "trash" ? "Trash" : 'Search: "' + searchQuery + '"';
    bc.appendChild(t);
    return;
  }

  var acc = "";
  currentPrefix.split("/").filter(Boolean).forEach(function (p) {
    acc += p + "/";
    bc.appendChild(document.createTextNode(" / "));
    var el = document.createElement("span");
    el.textContent = p;
    var prefixCopy = acc;
    el.onclick = function () { load(prefixCopy); };
    makeDropTarget(el, prefixCopy);
    bc.appendChild(el);
  });
}

function makeRow(nameText, icon, sizeText, dateText, onNameClick, actionButtons) {
  var tr = document.createElement("tr");
  tr.className = "row";

  var nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = icon + " " + nameText;
  if (onNameClick) {
    nameTd.onclick = function () {
      // swallow the phantom click that can follow a drag gesture
      if (Date.now() - lastDragEnd < 400) return;
      onNameClick();
    };
  }
  tr.appendChild(nameTd);

  var sizeTd = document.createElement("td");
  sizeTd.className = "size";
  sizeTd.textContent = sizeText || "";
  tr.appendChild(sizeTd);

  var dateTd = document.createElement("td");
  dateTd.className = "date";
  dateTd.textContent = dateText || "";
  tr.appendChild(dateTd);

  var actionsTd = document.createElement("td");
  actionsTd.className = "actions";
  (actionButtons || []).forEach(function (btn) {
    var b = document.createElement("button");
    b.textContent = btn.label;
    if (btn.danger) b.className = "danger";
    b.onclick = btn.onClick;
    actionsTd.appendChild(b);
  });
  tr.appendChild(actionsTd);

  return tr;
}

function showEmpty(count, message) {
  var el = document.getElementById("empty");
  el.textContent = message;
  el.style.display = count === 0 ? "block" : "none";
}

function load(prefix) {
  currentPrefix = prefix;
  clearSelection();
  renderBreadcrumb();
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var rows = document.getElementById("rows");
      rows.innerHTML = "";

      data.folders.forEach(function (folder) {
        var name = folder.slice(prefix.length).replace(/\/$/, "");
        var tr = makeRow(name, "📁", "", "", function () { load(folder); }, [
          { label: "Delete", onClick: function () { removeFolder(folder); } }
        ]);
        makeDropTarget(tr, folder);
        tr.insertBefore(makeSelTd(null), tr.firstChild);
        tr.draggable = true;
        tr.addEventListener("dragstart", function (e) {
          e.dataTransfer.setData("application/x-drive-dir", folder);
          e.dataTransfer.effectAllowed = "move";
        });
        tr.addEventListener("dragend", function () { lastDragEnd = Date.now(); });
        rows.appendChild(tr);
      });

      lastFiles = data.files.map(function (f) { return f.key; });

      data.files.forEach(function (file) {
        var name = file.key.slice(prefix.length);
        var tr = makeRow(name, "📄", humanSize(file.size), humanDate(file.uploaded),
          function () { openPreview(file.key); }, [
            { label: "Share", onClick: function () { shareFile(file.key); } },
            { label: "Rename", onClick: function () { renameFile(file.key); } },
            { label: "Download", onClick: function () { download(file.key); } },
            { label: "Delete", onClick: function () { removeFile(file.key); } }
          ]);
        tr.insertBefore(makeSelTd(file.key), tr.firstChild);
        tr.dataset.key = file.key;
        tr.draggable = true;
        tr.addEventListener("dragstart", function (e) {
          e.dataTransfer.setData("application/x-drive-key", file.key);
          e.dataTransfer.effectAllowed = "move";
        });
        tr.addEventListener("dragend", function () { lastDragEnd = Date.now(); });
        rows.appendChild(tr);
      });

      showEmpty(data.folders.length + data.files.length, "This folder is empty.");
      updateTreeActive();
    });
}

function loadTrash() {
  renderBreadcrumb();
  return fetch("/api/trash/list")
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var rows = document.getElementById("rows");
      rows.innerHTML = "";

      lastFiles = [];
      data.files.forEach(function (file) {
        var tr = makeRow(file.original, "🗑️", humanSize(file.size), humanDate(file.deleted),
          null, [
            { label: "Restore", onClick: function () { restoreFile(file.key); } },
            { label: "Delete forever", danger: true, onClick: function () { purgeFile(file.key); } }
          ]);
        tr.insertBefore(makeSelTd(null), tr.firstChild);
        rows.appendChild(tr);
      });

      showEmpty(data.files.length, "Trash is empty. Deleted files are kept here for 30 days.");
      updateTreeActive();
    });
}

function refresh() {
  if (mode === "trash") return loadTrash();
  if (mode === "search") return loadSearch();
  return load(currentPrefix);
}

// Scrolls to a row (after a rename moved it in the sorted list) and flashes it.
function highlightKey(key) {
  var trs = document.querySelectorAll("#rows tr");
  Array.prototype.forEach.call(trs, function (tr) {
    if (tr.dataset.key === key) {
      tr.scrollIntoView({ block: "center", behavior: "smooth" });
      tr.classList.add("flash");
      setTimeout(function () { tr.classList.remove("flash"); }, 1700);
    }
  });
}

function download(key) {
  window.location = "/api/object?key=" + encodeURIComponent(key);
}

// ---- In-page preview ----

function extOf(key) {
  var name = key.split("/").pop();
  var dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function closePreview() {
  previewKey = null;
  document.getElementById("previewOverlay").style.display = "none";
  document.getElementById("previewBody").innerHTML = ""; // also stops any playing media
}

function openPreview(key) {
  previewKey = key;
  document.getElementById("previewTitle").textContent = key.split("/").pop();
  var body = document.getElementById("previewBody");
  body.innerHTML = "";
  document.getElementById("previewOverlay").style.display = "flex";

  var inlineUrl = "/api/object?key=" + encodeURIComponent(key) + "&view=1";
  var ext = extOf(key);
  var images = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];
  var texts = ["txt", "md", "csv", "json", "js", "css", "html", "htm", "xml", "svg", "log", "yml", "yaml", "ini", "py", "sh"];
  var office = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];
  var audios = ["mp3", "wav", "m4a", "ogg", "flac"];
  var videos = ["mp4", "webm", "mov", "m4v"];

  if (images.indexOf(ext) !== -1) {
    var img = document.createElement("img");
    img.src = inlineUrl;
    body.appendChild(img);
  } else if (ext === "pdf" || texts.indexOf(ext) !== -1) {
    var frame = document.createElement("iframe");
    frame.src = inlineUrl;
    body.appendChild(frame);
  } else if (audios.indexOf(ext) !== -1) {
    var au = document.createElement("audio");
    au.controls = true;
    au.src = inlineUrl;
    body.appendChild(au);
  } else if (videos.indexOf(ext) !== -1) {
    var vid = document.createElement("video");
    vid.controls = true;
    vid.src = inlineUrl;
    body.appendChild(vid);
  } else if (office.indexOf(ext) !== -1) {
    // Microsoft's embedded viewer needs a link it can fetch itself, so ask the
    // Worker for a short-lived signed URL first.
    var note = document.createElement("div");
    note.className = "noPreview";
    note.textContent = "Loading preview…";
    body.appendChild(note);
    fetch("/api/sign?key=" + encodeURIComponent(key))
      .then(checkAuth)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (previewKey !== key) return; // preview was closed meanwhile
        body.innerHTML = "";
        var frame = document.createElement("iframe");
        frame.src = "https://view.officeapps.live.com/op/embed.aspx?src=" + encodeURIComponent(data.url);
        body.appendChild(frame);
      });
  } else {
    // Unknown extension: ask the server, which sniffs the file's first bytes,
    // then render according to the actual content type.
    var probe = document.createElement("div");
    probe.className = "noPreview";
    probe.textContent = "Loading preview…";
    body.appendChild(probe);
    fetch(inlineUrl)
      .then(checkAuth)
      .then(function (res) {
        var ct = (res.headers.get("content-type") || "").toLowerCase();
        if (res.body && res.body.cancel) res.body.cancel();
        if (previewKey !== key) return;
        body.innerHTML = "";
        if (ct.indexOf("image/") === 0) {
          var img2 = document.createElement("img");
          img2.src = inlineUrl;
          body.appendChild(img2);
        } else if (ct === "application/pdf" || ct.indexOf("text/") === 0) {
          var frame2 = document.createElement("iframe");
          frame2.src = inlineUrl;
          body.appendChild(frame2);
        } else if (ct.indexOf("audio/") === 0) {
          var au2 = document.createElement("audio");
          au2.controls = true;
          au2.src = inlineUrl;
          body.appendChild(au2);
        } else if (ct.indexOf("video/") === 0) {
          var vid2 = document.createElement("video");
          vid2.controls = true;
          vid2.src = inlineUrl;
          body.appendChild(vid2);
        } else {
          var msg = document.createElement("div");
          msg.className = "noPreview";
          msg.textContent = "No preview available for this file type — use Download.";
          body.appendChild(msg);
        }
      });
  }
}

// ---- Rename / move ----

function renameFile(key) {
  var oldName = key.split("/").pop();
  var input = prompt("Rename to:", oldName);
  if (input === null) return;
  input = input.trim();
  if (!input) return;
  if (input.indexOf("/") !== -1) { alert("The name cannot contain /"); return; }

  var finishRename = function (newName) {
    if (newName === oldName) return;
    var to = key.slice(0, key.length - oldName.length) + newName;
    fetch("/api/rename?from=" + encodeURIComponent(key) + "&to=" + encodeURIComponent(to), { method: "POST" })
      .then(checkAuth)
      .then(function (res) {
        if (res.status === 409) alert("A file named " + newName + " already exists here.");
        var p = refresh();
        if (p && p.then) p.then(function () { highlightKey(to); });
      });
  };

  var oldDot = oldName.lastIndexOf(".");
  if (input.indexOf(".") === -1 && oldDot > 0) {
    // Keep the old extension when the new name doesn't provide one.
    finishRename(input + oldName.slice(oldDot));
  } else if (input.indexOf(".") === -1) {
    // No extension anywhere: ask the server what the file really is (it
    // sniffs the first bytes) and append the matching extension.
    fetch("/api/object?key=" + encodeURIComponent(key) + "&view=1")
      .then(checkAuth)
      .then(function (res) {
        var ct = (res.headers.get("content-type") || "").toLowerCase().split(";")[0];
        if (res.body && res.body.cancel) res.body.cancel();
        var map = {
          "application/pdf": ".pdf",
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/gif": ".gif",
          "image/webp": ".webp"
        };
        finishRename(input + (map[ct] || ""));
      });
  } else {
    finishRename(input);
  }
}

function moveFile(key, destPrefix) {
  if (!key) return;
  var name = key.split("/").pop();
  var to = destPrefix + name;
  if (to === key) return;
  fetch("/api/rename?from=" + encodeURIComponent(key) + "&to=" + encodeURIComponent(to), { method: "POST" })
    .then(checkAuth)
    .then(function (res) {
      if (res.status === 409) alert("Something named " + name + " already exists there.");
      refresh();
    });
}

function loadSearch() {
  clearSelection();
  renderBreadcrumb();
  return fetch("/api/search?q=" + encodeURIComponent(searchQuery))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (mode !== "search") return; // user navigated away while we were fetching
      var rows = document.getElementById("rows");
      rows.innerHTML = "";
      lastFiles = data.files.map(function (f) { return f.key; });

      data.files.forEach(function (file) {
        var tr = makeRow(file.key, "📄", humanSize(file.size), humanDate(file.uploaded),
          function () { openPreview(file.key); }, [
            { label: "Share", onClick: function () { shareFile(file.key); } },
            { label: "Rename", onClick: function () { renameFile(file.key); } },
            { label: "Download", onClick: function () { download(file.key); } },
            { label: "Delete", onClick: function () { removeFile(file.key); } }
          ]);
        tr.insertBefore(makeSelTd(file.key), tr.firstChild);
        tr.dataset.key = file.key;
        tr.draggable = true;
        tr.addEventListener("dragstart", function (e) {
          e.dataTransfer.setData("application/x-drive-key", file.key);
          e.dataTransfer.effectAllowed = "move";
        });
        tr.addEventListener("dragend", function () { lastDragEnd = Date.now(); });
        rows.appendChild(tr);
      });

      showEmpty(data.files.length, 'No files match "' + searchQuery + '".');
      updateTreeActive();
    });
}

function shareFile(key) {
  var hours = prompt("Share link valid for how many hours? (max 168 = 7 days)", "24");
  if (hours === null) return;
  var ttl = Math.round(parseFloat(hours) * 3600);
  if (!ttl || ttl < 0) { alert("Invalid duration."); return; }
  fetch("/api/sign?key=" + encodeURIComponent(key) + "&ttl=" + ttl)
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var fallback = function () { prompt("Copy the share link:", data.url); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data.url).then(function () {
          alert("Share link copied to clipboard. Anyone with it can open this file until it expires.");
        }, fallback);
      } else {
        fallback();
      }
    });
}

function refreshUsage() {
  fetch("/api/usage")
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (u) {
      var txt = humanSize(u.driveBytes) + " used · " + u.driveCount + " files";
      if (u.trashBytes) txt += " · trash " + humanSize(u.trashBytes);
      document.getElementById("usage").textContent = txt;
    });
}

function dragKind(e) {
  var t = e.dataTransfer.types;
  if (Array.prototype.indexOf.call(t, "application/x-drive-key") !== -1) return "file";
  if (Array.prototype.indexOf.call(t, "application/x-drive-dir") !== -1) return "dir";
  return null;
}

function moveDir(srcPrefix, destPrefix) {
  if (!srcPrefix) return;
  var name = srcPrefix.replace(/\/$/, "").split("/").pop();
  var to = destPrefix + name + "/";
  if (to === srcPrefix) return;
  if (to.indexOf(srcPrefix) === 0) { alert("Cannot move a folder inside itself."); return; }
  fetch("/api/movedir?from=" + encodeURIComponent(srcPrefix) + "&to=" + encodeURIComponent(to), { method: "POST" })
    .then(checkAuth)
    .then(function (res) { return res.ok ? res.json() : { failed: 0 }; })
    .then(function (r) {
      if (r.failed) alert(r.failed + " item(s) could not be moved (name conflicts) and stayed in place.");
      initTree();
      refresh();
    });
}

function makeDropTarget(el, destPrefix) {
  el.addEventListener("dragover", function (e) {
    if (!dragKind(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("droptarget");
  });
  el.addEventListener("dragleave", function () { el.classList.remove("droptarget"); });
  el.addEventListener("drop", function (e) {
    var kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("droptarget");
    if (kind === "file") {
      moveFile(e.dataTransfer.getData("application/x-drive-key"), destPrefix);
    } else {
      moveDir(e.dataTransfer.getData("application/x-drive-dir"), destPrefix);
    }
  });
}

// ---- Folder tree (lazy-loaded) ----

function treeNode(prefix, name, autoExpand) {
  var wrap = document.createElement("div");
  var row = document.createElement("div");
  row.className = "treeRow";
  row.dataset.prefix = prefix;

  var arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "▸";
  row.appendChild(arrow);

  var label = document.createElement("span");
  label.textContent = (prefix === "" ? "🏠 " : "📁 ") + name;
  row.appendChild(label);

  var children = document.createElement("div");
  children.className = "treeChildren";
  children.style.display = "none";
  var loaded = false;

  arrow.onclick = function (e) {
    e.stopPropagation();
    if (children.style.display !== "none") {
      children.style.display = "none";
      arrow.textContent = "▸";
      return;
    }
    children.style.display = "";
    arrow.textContent = "▾";
    if (loaded) return;
    loaded = true;
    fetch("/api/list?prefix=" + encodeURIComponent(prefix))
      .then(checkAuth)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        data.folders.forEach(function (sub) {
          children.appendChild(treeNode(sub, sub.slice(prefix.length).replace(/\/$/, "")));
        });
        if (data.folders.length === 0) {
          var none = document.createElement("div");
          none.className = "treeEmpty";
          none.textContent = "no subfolders";
          children.appendChild(none);
        }
      });
  };

  row.onclick = function () { setMode("files"); load(prefix); };
  makeDropTarget(row, prefix);

  wrap.appendChild(row);
  wrap.appendChild(children);
  if (autoExpand) arrow.onclick(new Event("click"));
  return wrap;
}

function initTree() {
  var tree = document.getElementById("tree");
  tree.innerHTML = "";
  tree.appendChild(treeNode("", "Home", true));
}

function updateTreeActive() {
  var rowsEls = document.querySelectorAll(".treeRow");
  Array.prototype.forEach.call(rowsEls, function (r) {
    r.classList.toggle("active", mode === "files" && r.dataset.prefix === currentPrefix);
  });
}

function removeFile(key) {
  if (!confirm("Move " + key.split("/").pop() + " to the trash?")) return;
  fetch("/api/object?key=" + encodeURIComponent(key), { method: "DELETE" })
    .then(checkAuth).then(function () { refreshUsage(); refresh(); });
}

function removeFolder(prefix) {
  if (!confirm("Move folder " + prefix + " and everything inside it to the trash?")) return;
  deleteFolderContents(prefix).then(function () { initTree(); refreshUsage(); refresh(); });
}

// Recursively soft-deletes everything under prefix, then the folder marker itself.
// Lists only the first 1000 entries per level (no cursor pagination) — plenty
// for a personal drive, but a folder with 1000+ direct items would need re-running.
function deleteFolderContents(prefix) {
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var deletes = data.files.map(function (f) {
        return fetch("/api/object?key=" + encodeURIComponent(f.key), { method: "DELETE" });
      });
      var subfolders = data.folders.map(function (sub) { return deleteFolderContents(sub); });
      return Promise.all(deletes.concat(subfolders));
    })
    .then(function () {
      return fetch("/api/object?key=" + encodeURIComponent(prefix), { method: "DELETE" });
    });
}

function restoreFile(key) {
  fetch("/api/trash/restore?key=" + encodeURIComponent(key), { method: "POST" })
    .then(checkAuth).then(function () { refreshUsage(); refresh(); });
}

function purgeFile(key) {
  if (!confirm("Permanently delete " + key.split("/").pop() + "? This cannot be undone.")) return;
  fetch("/api/trash/object?key=" + encodeURIComponent(key), { method: "DELETE" })
    .then(checkAuth).then(function () { refreshUsage(); refresh(); });
}

function uploadFiles(fileList) {
  var files = Array.prototype.slice.call(fileList);
  var progress = document.getElementById("progress");
  var i = 0;
  function next() {
    if (i >= files.length) {
      progress.textContent = "";
      refreshUsage();
      refresh();
      return;
    }
    var file = files[i];
    progress.textContent = "Uploading " + (i + 1) + "/" + files.length + ": " + file.name;
    var key = currentPrefix + file.name;
    fetch("/api/object?key=" + encodeURIComponent(key), {
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    }).then(checkAuth).then(function () { i++; next(); });
  }
  next();
}

document.getElementById("uploadBtn").onclick = function () { document.getElementById("fileInput").click(); };
document.getElementById("fileInput").onchange = function (e) { uploadFiles(e.target.files); };

document.getElementById("newFolderBtn").onclick = function () {
  var name = prompt("Folder name:");
  if (!name) return;
  fetch("/api/mkdir?key=" + encodeURIComponent(currentPrefix + name + "/"), { method: "POST" })
    .then(checkAuth).then(function () { initTree(); refresh(); });
};

document.getElementById("trashBtn").onclick = function () { setMode("trash"); loadTrash(); };
document.getElementById("backBtn").onclick = function () { setMode("files"); load(currentPrefix); };

document.getElementById("emptyTrashBtn").onclick = function () {
  if (!confirm("Permanently delete everything in the trash? This cannot be undone.")) return;
  fetch("/api/trash/empty", { method: "POST" })
    .then(checkAuth).then(function () { refreshUsage(); refresh(); });
};

document.getElementById("logoutBtn").onclick = function () {
  fetch("/api/logout", { method: "POST" }).then(function () { window.location.reload(); });
};

var dropzone = document.getElementById("dropzone");
["dragenter", "dragover"].forEach(function (evt) {
  dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.add("drag"); });
});
["dragleave", "drop"].forEach(function (evt) {
  dropzone.addEventListener(evt, function (e) { e.preventDefault(); dropzone.classList.remove("drag"); });
});
dropzone.addEventListener("drop", function (e) {
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

document.getElementById("previewCloseBtn").onclick = closePreview;
document.getElementById("previewDownloadBtn").onclick = function () { if (previewKey) download(previewKey); };
document.getElementById("previewOverlay").addEventListener("click", function (e) {
  if (e.target === document.getElementById("previewBody")) closePreview();
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePreview(); });

document.getElementById("searchBox").oninput = function () {
  var box = this;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function () {
    var q = box.value.trim();
    if (!q) {
      if (mode === "search") { setMode("files"); load(currentPrefix); }
      return;
    }
    searchQuery = q;
    if (mode !== "search") setMode("search");
    loadSearch();
  }, 250);
};

document.getElementById("selectAll").onchange = function () {
  var on = this.checked;
  lastFiles.forEach(function (k) { toggleSelect(k, on); });
  var cbs = document.querySelectorAll("#rows .sel input");
  Array.prototype.forEach.call(cbs, function (c) { c.checked = on; });
};

document.getElementById("bulkClearBtn").onclick = function () {
  clearSelection();
  var cbs = document.querySelectorAll("#rows .sel input");
  Array.prototype.forEach.call(cbs, function (c) { c.checked = false; });
};

document.getElementById("bulkDeleteBtn").onclick = function () {
  if (!selected.length) return;
  if (!confirm("Move " + selected.length + " file(s) to the trash?")) return;
  Promise.all(selected.map(function (k) {
    return fetch("/api/object?key=" + encodeURIComponent(k), { method: "DELETE" });
  })).then(function () { clearSelection(); refreshUsage(); refresh(); });
};

document.getElementById("bulkMoveBtn").onclick = function () {
  if (!selected.length) return;
  var dest = prompt('Destination folder (empty = Home, e.g. "Documents/"):', currentPrefix);
  if (dest === null) return;
  dest = dest.trim();
  if (dest && dest.charAt(dest.length - 1) !== "/") dest += "/";
  var failed = 0;
  Promise.all(selected.map(function (k) {
    var to = dest + k.split("/").pop();
    if (to === k) return Promise.resolve();
    return fetch("/api/rename?from=" + encodeURIComponent(k) + "&to=" + encodeURIComponent(to), { method: "POST" })
      .then(function (res) { if (!res.ok) failed++; });
  })).then(function () {
    if (failed) alert(failed + " file(s) could not be moved (same name already there?).");
    clearSelection();
    refresh();
  });
};

setMode("files");
initTree();
load("");
refreshUsage();
</script>
</body>
</html>`;
