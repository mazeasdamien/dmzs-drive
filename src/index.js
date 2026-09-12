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
const CONFIG = ".config/"; // hidden technical area (share-link records live here)
const SHARES = CONFIG + "shares/";
const SESSION_DAYS = 30;
const TRASH_RETENTION_DAYS = 30;

function isReserved(key) {
  return key.startsWith(TRASH) || key.startsWith(CONFIG);
}

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
  async fetch(request, env, ctx) {
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
      if (url.pathname === "/api/thumb" && request.method === "GET") {
        return await handleThumb(request, url, env, ctx);
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
      if (url.pathname === "/api/keys" && request.method === "GET") {
        return await handleKeys(url, env);
      }
      if (url.pathname === "/api/shares" && request.method === "GET") {
        return await handleSharesList(env);
      }
      if (url.pathname === "/api/shares/revoke" && request.method === "POST") {
        return await handleShareRevoke(url, env);
      }
      if (url.pathname === "/api/shares/revokeall" && request.method === "POST") {
        return await handleShareRevokeAll(env);
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

  // Daily cron: purge old trash entries and expired share-link records.
  async scheduled(controller, env) {
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400 * 1000;
    const expired = (await listAllTrash(env))
      .filter((o) => new Date(o.uploaded).getTime() < cutoff)
      .map((o) => o.key);
    for (let i = 0; i < expired.length; i += 1000) {
      await env.DRIVE_BUCKET.delete(expired.slice(i, i + 1000));
    }

    const now = Math.floor(Date.now() / 1000);
    const staleShares = [];
    let cursor;
    do {
      const page = await env.DRIVE_BUCKET.list({ prefix: SHARES, cursor, include: ["customMetadata"] });
      for (const o of page.objects) {
        if (parseInt((o.customMetadata || {}).exp || "0", 10) < now) staleShares.push(o.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < staleShares.length; i += 1000) {
      await env.DRIVE_BUCKET.delete(staleShares.slice(i, i + 1000));
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

  if (url.searchParams.get("share") === "1") {
    // Real share links are recorded (id -> file, expiry, url) so they can be
    // listed and revoked; deleting the record invalidates the link.
    const id = crypto.randomUUID();
    const sig = await hmacHex(sessionKey(env), "url|" + key + "|" + exp + "|" + id);
    const link =
      url.origin + "/api/object?key=" + encodeURIComponent(key) +
      "&view=1&exp=" + exp + "&sid=" + id + "&sig=" + sig;
    await env.DRIVE_BUCKET.put(SHARES + id, new Uint8Array(), {
      customMetadata: { key, exp: String(exp), url: link },
    });
    return Response.json({ url: link });
  }

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
  const sid = url.searchParams.get("sid");
  if (sid) {
    // Share link: valid only while its record still exists (revocable).
    if (!/^[0-9a-f-]{36}$/.test(sid)) return false;
    const record = await env.DRIVE_BUCKET.head(SHARES + sid);
    if (!record || (record.customMetadata || {}).key !== key) return false;
    const expected = await hmacHex(sessionKey(env), "url|" + key + "|" + exp + "|" + sid);
    return safeEqual(url.searchParams.get("sig") || "", expected);
  }
  const expected = await hmacHex(sessionKey(env), "url|" + key + "|" + exp);
  return safeEqual(url.searchParams.get("sig") || "", expected);
}

async function handleSharesList(env) {
  const shares = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix: SHARES, cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      const m = o.customMetadata || {};
      shares.push({
        id: o.key.slice(SHARES.length),
        key: m.key || "?",
        exp: parseInt(m.exp || "0", 10),
        url: m.url || "",
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  shares.sort((a, b) => a.exp - b.exp);
  return Response.json({ shares });
}

async function handleShareRevoke(url, env) {
  const id = url.searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Bad id", { status: 400 });
  await env.DRIVE_BUCKET.delete(SHARES + id);
  return new Response("OK");
}

async function handleShareRevokeAll(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix: SHARES, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < keys.length; i += 1000) {
    await env.DRIVE_BUCKET.delete(keys.slice(i, i + 1000));
  }
  return Response.json({ revoked: keys.length });
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

  const folderNames = (listed.delimitedPrefixes || []).filter((p) => p !== TRASH && p !== CONFIG).sort();
  const files = listed.objects
    .filter((o) => o.key !== prefix) // hide the folder's own zero-byte marker, if any
    .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // R2 "folders" are just key prefixes with no metadata of their own, so
  // aggregate each subfolder's total size and most recent change from a full
  // (non-delimited) listing of the subtree.
  const stats = {};
  if (folderNames.length) {
    let cursor;
    do {
      const page = await env.DRIVE_BUCKET.list({ prefix, cursor });
      for (const o of page.objects) {
        if (prefix === "" && isReserved(o.key)) continue;
        const rest = o.key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) continue; // direct file of this level, not in a subfolder
        const folder = prefix + rest.slice(0, slash + 1);
        const s = stats[folder] || (stats[folder] = { size: 0, count: 0, modified: null });
        if (!o.key.endsWith("/")) { s.size += o.size; s.count++; }
        if (!s.modified || o.uploaded > s.modified) s.modified = o.uploaded;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  const folders = folderNames.map((p) => ({
    prefix: p,
    size: (stats[p] || {}).size || 0,
    count: (stats[p] || {}).count || 0,
    modified: (stats[p] || {}).modified || null,
  }));

  return Response.json({ prefix, folders, files });
}

async function handleUpload(request, url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (isReserved(key)) return new Response("Reserved prefix", { status: 400 });

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
  if (isReserved(key)) return new Response("Use /api/trash/*", { status: 400 });
  await moveObject(env, key, TRASH + key);
  return new Response("OK");
}

// Rename and move share this: both are "move object to a new key".
async function handleRename(url, env) {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return new Response("Missing from/to", { status: 400 });
  if (isReserved(from) || isReserved(to)) {
    return new Response("Reserved prefix", { status: 400 });
  }
  if (from === to) return new Response("OK");
  if (await env.DRIVE_BUCKET.head(to)) {
    return new Response("Target exists", { status: 409 }); // never overwrite silently
  }
  await moveObject(env, from, to);
  return new Response("OK");
}

// ---------- Thumbnails ----------

// The grid used to point its tiles at the original photos and let CSS shrink
// them, so browsing a folder of 3 MB JPEGs meant decoding hundreds of megabytes.
// This resizes the R2 bytes through the Images binding instead. Nothing extra
// is stored anywhere: the small copy only ever lives in Cloudflare's cache,
// keyed by the object's etag so replacing a file shows the new picture.
// Transforms are billed once per unique image per month (5 000/month free).
// Videos go through the Media binding instead, which grabs a still frame; it
// reads the R2 body directly, so nothing about the bucket has to be public.
const THUMB_WIDTH = 400;
// A second in, because the first frame of a phone video is often black or
// still focusing.
const FRAME_TIME = "1s";
const VIDEO_EXTS = ["mp4", "webm", "mov", "m4v"];

function isVideoKey(key) {
  return VIDEO_EXTS.indexOf(key.split(".").pop().toLowerCase()) !== -1;
}

async function handleThumb(request, url, env, ctx) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (isReserved(key)) return new Response("Reserved prefix", { status: 400 });

  const head = await env.DRIVE_BUCKET.head(key);
  if (!head) return new Response("Not found", { status: 404 });

  const video = isVideoKey(key);

  // Cache lookup happens only after the session check above, so a cached
  // thumbnail can never be served to someone who isn't signed in.
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set("e", head.etag);
  cacheUrl.searchParams.set("w", String(THUMB_WIDTH));
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let response = null;
  if (video) {
    response = await videoFrame(env, key);
  } else if (env.IMAGES) {
    try {
      const object = await env.DRIVE_BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const out = await env.IMAGES.input(object.body)
        .transform({ width: THUMB_WIDTH })
        .output({ format: "image/webp", quality: 75 });
      const produced = out.response();
      response = new Response(produced.body, {
        headers: {
          "content-type": produced.headers.get("content-type") || "image/webp",
          "cache-control": "public, max-age=604800",
        },
      });
    } catch (err) {
      // Unsupported input, over the 20 MB input limit, or the monthly free
      // transform quota is used up: fall through to the original file.
      response = null;
    }
  }

  if (!response) {
    // For a photo, handing back the original is a fine (if heavy) thumbnail.
    // For a video it would be megabytes of MP4 in an <img>, so say so instead
    // and let the grid keep its icon.
    if (video) return new Response("No frame", { status: 415 });
    const original = await env.DRIVE_BUCKET.get(key);
    if (!original) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    original.writeHttpMetadata(headers);
    headers.set("cache-control", "public, max-age=3600");
    headers.set("x-thumb", "original"); // no resize happened
    return new Response(original.body, { headers });
  }

  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Pulls a still out of a video. A clip shorter than FRAME_TIME has no frame
// there, so a failure retries at the very start before giving up. The body has
// to be re-fetched per attempt: a Media input can't be reused across
// transformations. Returns null when no frame can be made at all — an
// unsupported codec, or over the binding's 100 MB input limit.
async function videoFrame(env, key) {
  if (!env.MEDIA) return null;
  for (const time of [FRAME_TIME, "0s"]) {
    try {
      const object = await env.DRIVE_BUCKET.get(key);
      if (!object) return null;
      const out = await env.MEDIA.input(object.body)
        .transform({ width: THUMB_WIDTH })
        .output({ mode: "frame", time, format: "jpg" })
        .response();
      if (!out || !out.ok) continue;
      return new Response(out.body, {
        headers: {
          "content-type": out.headers.get("content-type") || "image/jpeg",
          "cache-control": "public, max-age=604800",
        },
      });
    } catch (err) {
      // try the start, then fall through
    }
  }
  return null;
}

async function handleMkdir(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  if (isReserved(key)) return new Response("Reserved prefix", { status: 400 });
  const folderKey = key.endsWith("/") ? key : key + "/";
  await env.DRIVE_BUCKET.put(folderKey, new Uint8Array());
  return new Response("OK");
}

// Raw keys under a prefix (folder markers included) — lets the client move a
// folder key-by-key with a progress bar.
async function handleKeys(url, env) {
  const prefix = url.searchParams.get("prefix") || "";
  if (isReserved(prefix)) return new Response("Reserved prefix", { status: 400 });
  const keys = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return Response.json({ keys });
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
      if (isReserved(o.key) || o.key.endsWith("/")) continue;
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
      else if (o.key.startsWith(CONFIG)) continue;
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
  const dest = key.slice(TRASH.length);
  if (await env.DRIVE_BUCKET.head(dest)) {
    return new Response("Target exists", { status: 409 }); // never overwrite silently
  }
  await moveObject(env, key, dest);
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
  /* iOS Safari inflates font sizes in some blocks unless told not to, which
     grows buttons past the width they were laid out for. */
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
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
    --sel: #dbe6fe;
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
      --sel: #23314f;
    }
  }
  * { box-sizing: border-box; }
  /* iOS Safari inflates font sizes in some blocks unless told not to, which
     grows buttons past the width they were laid out for. */
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
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
  /* The generous bottom padding / min-height is deliberate: it leaves blank
     space below the list to start a rubber-band selection in. */
  main { flex: 1; min-width: 0; padding: 24px 32px 140px; min-height: 70vh; }
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
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--accent); }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  /* One click selects, two open — so don't let a double click highlight text. */
  tr.row, .tile { user-select: none; -webkit-user-select: none; }
  tr.row:hover { background: var(--hover); }
  .name { cursor: pointer; overflow-wrap: anywhere; }
  .name:hover { color: var(--accent); }
  .size, .date { color: var(--muted); white-space: nowrap; }
  .actions { text-align: right; white-space: nowrap; }
  .actions button { padding: 3px 8px; font-size: 12px; margin-left: 4px; }
  #empty { color: var(--muted); text-align: center; padding: 40px 0; }
  #progress { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  #progressBarWrap {
    display: none;
    height: 6px;
    border-radius: 3px;
    background: var(--hover);
    overflow: hidden;
    margin-bottom: 12px;
  }
  #progressBarFill {
    height: 100%;
    width: 0%;
    background: var(--accent);
    border-radius: 3px;
    transition: width .2s;
  }
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
  /* Floats over the content instead of sitting in the flow: appearing must
     never push the file list around. z-index stays below the preview overlay. */
  #selectionBar {
    position: fixed;
    left: 50%;
    bottom: 24px;
    z-index: 9;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    box-shadow: 0 6px 24px rgba(0, 0, 0, .18);
    visibility: hidden;
    opacity: 0;
    transform: translate(-50%, 10px);
    /* visibility is a discrete property: give it a delay on the way out and
       none on the way in, so the bar fades rather than popping mid-transition */
    transition: opacity .15s ease, transform .15s ease, visibility 0s linear .15s;
  }
  #selectionBar.show {
    visibility: visible;
    opacity: 1;
    transform: translate(-50%, 0);
    transition: opacity .15s ease, transform .15s ease, visibility 0s;
  }
  #selectionBar button { padding: 3px 10px; font-size: 12px; }
  #selectionHint { color: var(--muted); font-size: 12px; }
  .sel { width: 26px; }
  .sel input { accent-color: var(--accent); }
  tr.row.selected > td { background: var(--sel); }
  tr.row.selected:hover > td { background: var(--sel); }
  .tile.selected { outline: 2px solid var(--accent); outline-offset: -2px; }
  .tile.selected .tname { background: var(--sel); }
  /* While rubber-banding, kill text selection so the drag doesn't highlight names. */
  body.marqueeing, body.marqueeing * { user-select: none; -webkit-user-select: none; }
  /* ...and stop the list reacting to hover: sweeping the cursor over a folder of
     photos would otherwise lay out each tile's action buttons in turn. The drag
     itself is tracked on document, so the list needs no pointer events. */
  body.marqueeing #rows, body.marqueeing #grid { pointer-events: none; }
  #marquee {
    position: absolute;
    z-index: 15;
    border: 1px solid var(--accent);
    background: rgba(37, 99, 235, .14);
    border-radius: 2px;
    pointer-events: none;
    /* Own compositing layer: resizing a translucent box that sits in the page
       layer would repaint every photo underneath it, every frame. */
    will-change: transform;
  }
  tr.droptarget { outline: 2px solid var(--accent); outline-offset: -2px; }
  #grid {
    display: none;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 12px;
  }
  .tile {
    position: relative;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    cursor: pointer;
    /* keeps a tile's style/layout changes from invalidating the whole grid */
    contain: layout paint;
  }
  .tile:hover { border-color: var(--accent); }
  .tile .thumb { width: 100%; height: 110px; object-fit: cover; display: block; background: var(--hover); }
  .tile .thumbIcon { height: 110px; display: flex; align-items: center; justify-content: center; font-size: 42px; background: var(--hover); }
  .tile .tname { font-size: 12px; padding: 6px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A video's thumbnail is just a frame out of it, so without this badge a
     video tile is indistinguishable from a photo. Centred on the 110px thumb. */
  .tile .playBadge {
    position: absolute;
    top: 55px;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding-left: 3px; /* optical centring: the glyph's mass sits left */
    border-radius: 50%;
    background: rgba(0, 0, 0, .55);
    color: #fff;
    font-size: 13px;
    pointer-events: none;
  }
  /* opacity, not display: toggling display forces a layout pass on every tile
     the rubber band crosses, which is what made big folders crawl. */
  .tile .tilecb {
    position: absolute;
    top: 6px;
    left: 6px;
    accent-color: var(--accent);
    opacity: 0;
    pointer-events: none;
  }
  .tile:hover .tilecb, .tile .tilecb:checked { opacity: 1; pointer-events: auto; }
  .tile .tacts { position: absolute; top: 4px; right: 4px; display: none; gap: 3px; }
  .tile:hover .tacts { display: flex; }
  .tile .tacts button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: 6px;
    background: var(--bg);
    color: var(--muted);
    box-shadow: 0 1px 4px rgba(0, 0, 0, .15);
  }
  .tile .tacts button:hover { color: var(--accent); background: var(--bg); }
  .tile .tacts button.danger:hover { color: var(--danger); }
  .tile .tacts svg { display: block; }
  .tile.droptarget { outline: 2px solid var(--accent); outline-offset: -2px; }
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
  #previewOverlay:focus { outline: none; }
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
  #previewCount { color: var(--muted); font-size: 12px; margin-left: 8px; white-space: nowrap; }
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
  #hoverPreview {
    position: fixed;
    z-index: 20;
    width: 320px;
    height: 380px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, .3);
    overflow: hidden;
    pointer-events: none;
    display: none;
  }
  #hoverPreview iframe { width: 100%; height: 100%; border: none; background: white; }
  #hoverPreview img { width: 100%; height: 100%; object-fit: contain; }
  /* Compact "⋯" menus. On a phone the four per-row action buttons and the
     toolbar's secondary actions collapse into these rather than wrapping onto
     three or four lines each. */
  .menu {
    position: fixed;
    z-index: 14;
    display: none;
    flex-direction: column;
    gap: 2px;
    min-width: 170px;
    max-width: calc(100vw - 16px);
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg);
    box-shadow: 0 8px 30px rgba(0, 0, 0, .28);
  }
  .menu.open { display: flex; }
  .menu button {
    width: 100%;
    margin: 0;
    padding: 10px 12px;
    font-size: 14px;
    text-align: left;
    border-color: transparent;
  }
  .kebab { display: none; }
  #treeBtn { display: none; margin-right: 10px; padding: 7px 10px; font-size: 16px; line-height: 1; }
  #moreBtn { min-width: 40px; }
  #sidebarBackdrop {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 11;
    background: rgba(0, 0, 0, .45);
  }
  .titleWrap { display: flex; align-items: center; min-width: 0; }
  /* Touch devices, at any width: everything the desktop reveals on :hover has
     to be permanently visible, because there is no hover to reveal it with. */
  @media (hover: none) {
    /* Files can't be dragged in from a phone's file system — Upload is the way. */
    #dropzone { display: none; }
    /* Without this the grid view is read-only on a phone: the tile checkbox is
       transparent AND pointer-events:none, and the action buttons never show. */
    .tile .tilecb {
      opacity: 1;
      pointer-events: auto;
      width: 20px;
      height: 20px;
      filter: drop-shadow(0 0 2px rgba(0, 0, 0, .55));
    }
    .tile .tacts { display: flex; }
    .sel input { width: 18px; height: 18px; }
    /* No rubber-band selection on touch, so the deliberate blank space under
       the list is just wasted screen — keep only enough for the floating bar. */
    main { padding-bottom: 96px; min-height: 0; }
  }
  @media (max-width: 820px) {
    #selectionHint { display: none; } /* keep the floating bar narrow */
  }
  @media (max-width: 700px) {
    /* A single element wider than the screen makes iOS Safari widen the whole
       layout viewport, and then everything else — grid, table, header — is
       laid out against that wider page and pans off the right edge. So on a
       phone nothing is allowed to overflow: the guard below is the backstop,
       and the rules after it are what keep it from being needed. */
    html, body { overflow-x: hidden; }
    header { padding: 10px 12px; gap: 8px; }
    header h1 { font-size: 15px; }
    main { padding: 14px 12px 96px; }
    /* One row that provably fits at 320px: only the search box flexes, and the
       button labels shorten (see syncCompactToolbar). Wrapping is off because
       a wrapped toolbar was what overflowed in the first place. */
    .toolbar { width: 100%; gap: 6px; flex-wrap: nowrap; }
    .toolbar > button { flex: 0 0 auto; padding: 8px 10px; white-space: nowrap; }
    #searchBox { flex: 1 1 60px; min-width: 0; width: auto; padding: 8px 10px; }
    .titleWrap { flex: 1 1 auto; }
    .titleWrap > div { min-width: 0; }
    #breadcrumb { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #treeBtn { display: inline-flex; flex-shrink: 0; }
    /* The sidebar becomes a slide-in drawer. Hiding it outright (what this
       breakpoint used to do) left no way at all to reach the folder tree or
       the storage figure from a phone. */
    #sidebar {
      display: flex;
      position: fixed;
      top: 0;
      left: 0;
      width: min(78vw, 300px);
      /* An explicit height, not top/bottom insets: as an out-of-flow child of a
         flex container the drawer inherits align-self:flex-start and refuses to
         stretch. dvh so the phone's collapsing address bar doesn't clip it. */
      height: 100vh;
      height: 100dvh;
      max-height: none;
      z-index: 12;
      background: var(--bg);
      box-shadow: 0 0 30px rgba(0, 0, 0, .3);
      transform: translateX(-100%);
      transition: transform .2s ease;
    }
    #sidebar.open { transform: none; }
    #sidebarBackdrop.open { display: block; }
    .treeRow { padding: 9px 6px; font-size: 14px; }
    /* One "⋯" per row instead of four buttons: they took 217px of a 375px
       screen and squeezed the file name column down to 41px. */
    .actions button { display: none; }
    .actions .kebab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      margin: 0;
      padding: 0;
      font-size: 16px;
    }
    .tile .tacts button { display: none; }
    .tile .tacts .kebab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      font-size: 15px;
    }
    .date { display: none; }
    th, td { padding: 8px 4px; }
    /* Fixed columns from the header row. With auto layout a long unbroken
       filename widens the table past the screen no matter how the name cell
       wraps, which is exactly the overflow that dragged the page sideways. */
    table { table-layout: fixed; }
    .sel { width: 34px; }
    .size { width: 74px; }
    .actions { width: 46px; }
    #grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 10px; }
    #selectionBar {
      left: 10px;
      right: 10px;
      bottom: 10px;
      justify-content: center;
      border-radius: 14px;
      transform: translate(0, 10px);
    }
    #selectionBar.show { transform: none; }
    #selectionBar button { padding: 8px 12px; font-size: 13px; }
    #previewHeader { flex-wrap: wrap; padding: 8px 10px; }
    #previewHeader button { padding: 8px 12px; }
    #previewBody img, #previewBody video { max-width: 100%; max-height: 100%; }
  }
</style>
</head>
<body>
<header>
  <div class="titleWrap">
    <button id="treeBtn" title="Folders" aria-label="Show folders">&#9776;</button>
    <div>
      <h1>Damien's Drive</h1>
      <div id="breadcrumb"></div>
    </div>
  </div>
  <div class="toolbar" id="toolbar">
    <input id="searchBox" type="search" placeholder="Search files…" />
    <button id="viewToggleBtn">Grid view</button>
    <button id="newFolderBtn">New folder</button>
    <button id="uploadBtn" class="primary">Upload files</button>
    <button id="uploadFolderBtn">Upload folder</button>
    <button id="backupBtn">Backup</button>
    <button id="sharesBtn">Shares</button>
    <button id="trashBtn">Trash</button>
    <button id="backBtn" style="display:none">&larr; Back to files</button>
    <button id="restoreAllBtn" style="display:none">Restore all</button>
    <button id="emptyTrashBtn" class="danger" style="display:none">Empty trash</button>
    <button id="revokeAllBtn" class="danger" style="display:none">Revoke all</button>
    <button id="logoutBtn">Log out</button>
    <input id="fileInput" type="file" multiple style="display:none" />
    <input id="folderInput" type="file" webkitdirectory multiple style="display:none" />
    <button id="moreBtn" title="More actions" aria-label="More actions" style="display:none">&hellip;</button>
  </div>
</header>
<div id="sidebarBackdrop"></div>
<div id="overflowMenu" class="menu"></div>
<div id="itemMenu" class="menu"></div>
<div id="layout">
  <nav id="sidebar"><div id="tree"></div><div id="usage"></div></nav>
  <main>
    <div id="dropzone">Drag files here, or click Upload</div>
    <div id="progress"></div>
    <div id="progressBarWrap"><div id="progressBarFill"></div></div>
    <div id="selectionBar">
      <span id="selectionCount"></span>
      <button id="bulkDownloadBtn">Download</button>
      <button id="bulkMoveBtn">Move to…</button>
      <button id="bulkDeleteBtn" class="danger">Delete</button>
      <button id="bulkClearBtn">Clear</button>
      <span id="selectionHint">Double-click opens · Shift-click a range · Ctrl-click to add · Ctrl+A all · Esc clears</span>
    </div>
    <table id="fileTable">
      <thead><tr><th class="sel"><input type="checkbox" id="selectAll" /></th><th id="thName" class="sortable">Name</th><th id="thSize" class="size sortable">Size</th><th class="date sortable" id="dateHeader">Modified</th><th class="actions"></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <div id="grid"></div>
    <div id="empty" style="display:none"></div>
  </main>
</div>
<div id="hoverPreview"></div>
<div id="previewOverlay" style="display:none" tabindex="-1">
  <div id="previewHeader">
    <span><span id="previewTitle"></span><span id="previewCount"></span></span>
    <div class="toolbar">
      <button id="previewPrevBtn" title="Previous (←)">&lsaquo;</button>
      <button id="previewNextBtn" title="Next (→)">&rsaquo;</button>
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
var selectAnchor = null; // last item clicked, the pivot for Shift-click ranges
var lastFiles = [];      // file keys in display order (drives preview next/prev)
var lastItems = [];      // selectable keys in display order: folders, then files
var fileMeta = {};       // key -> {size, uploaded} for the listing on screen, for zip stamps
// Touch keeps tap-to-open: double-tap is a poor gesture, and the checkboxes
// are the practical way to multi-select there. Decided per gesture rather than
// per device, so a mouse still gets click-to-select on a touchscreen laptop.
var lastPointerType = "mouse";
document.addEventListener("pointerdown", function (e) {
  lastPointerType = e.pointerType || "mouse";
}, true);
var searchTimer = null;
var lastDragEnd = 0;
var sortBy = "name";
var sortDir = 1;
// Both the grid (thumbnail via a still frame) and the preview need these.
var VIDEO_EXTS = ["mp4", "webm", "mov", "m4v"];
var IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];
// Only photos and videos can have a real thumbnail — nothing on the platform
// rasterises a PDF or a slide deck. So the rest lean on the icon to say what
// they are, rather than every one of them being the same sheet of paper.
var FILE_ICONS = {
  pdf: "📕",
  doc: "📘", docx: "📘", odt: "📘", rtf: "📘", pages: "📘",
  xls: "📊", xlsx: "📊", csv: "📊", ods: "📊", numbers: "📊",
  ppt: "📙", pptx: "📙", odp: "📙", key: "📙",
  zip: "📦", rar: "📦", "7z": "📦", tar: "📦", gz: "📦",
  mp3: "🎵", wav: "🎵", m4a: "🎵", ogg: "🎵", flac: "🎵",
  js: "📜", json: "📜", html: "📜", htm: "📜", css: "📜", py: "📜", sh: "📜",
  xml: "📜", yml: "📜", yaml: "📜", ini: "📜"
};

function iconFor(key) {
  var ext = extOf(key);
  if (IMAGE_EXTS.indexOf(ext) !== -1) return "🖼️";
  if (VIDEO_EXTS.indexOf(ext) !== -1) return "🎬";
  return FILE_ICONS[ext] || "📄";
}

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
  // Cheap no-op unless the width crossed the phone breakpoint; belt and braces
  // in case neither the resize nor the media-query event reached us.
  syncCompactToolbar();
  mode = m;
  var files = m === "files";
  var trash = m === "trash";
  var shares = m === "shares";
  document.getElementById("newFolderBtn").style.display = files ? "" : "none";
  document.getElementById("uploadBtn").style.display = files ? "" : "none";
  document.getElementById("uploadFolderBtn").style.display = files ? "" : "none";
  document.getElementById("trashBtn").style.display = trash ? "none" : "";
  document.getElementById("sharesBtn").style.display = shares ? "none" : "";
  document.getElementById("backBtn").style.display = (trash || shares) ? "" : "none";
  document.getElementById("restoreAllBtn").style.display = trash ? "" : "none";
  document.getElementById("emptyTrashBtn").style.display = trash ? "" : "none";
  document.getElementById("revokeAllBtn").style.display = shares ? "" : "none";
  document.getElementById("dropzone").style.display = files ? "" : "none";
  updateSortHeaders();
  document.getElementById("selectAll").style.visibility = (trash || m === "shares") ? "hidden" : "";
  document.getElementById("viewToggleBtn").style.display = files ? "" : "none";
  document.getElementById("backupBtn").style.display = files ? "" : "none";
  if (m !== "search") document.getElementById("searchBox").value = "";
  clearSelection();
}

// ---- Sorting ----

function sortArrow(k) {
  return sortBy === k ? (sortDir > 0 ? " ▲" : " ▼") : "";
}

function updateSortHeaders() {
  var dateLabel = mode === "trash" ? "Deleted" : mode === "shares" ? "Expires" : "Modified";
  document.getElementById("thName").textContent = "Name" + sortArrow("name");
  document.getElementById("thSize").textContent = "Size" + sortArrow("size");
  document.getElementById("dateHeader").textContent = dateLabel + sortArrow("date");
}

function setSort(key) {
  if (sortBy === key) { sortDir = -sortDir; } else { sortBy = key; sortDir = 1; }
  updateSortHeaders();
  refresh();
}

function sortList(list, getName, getSize, getDate) {
  list.sort(function (a, b) {
    var r;
    if (sortBy === "size") r = getSize(a) - getSize(b);
    else if (sortBy === "date") r = new Date(getDate(a) || 0) - new Date(getDate(b) || 0);
    else r = getName(a).localeCompare(getName(b));
    return r * sortDir;
  });
}

// ---- Multi-select ----
//
// "selected" holds file keys and folder prefixes (folders keep their trailing
// slash, which is what tells the two apart). The DOM is the mirror, never the
// source of truth: everything that changes the selection goes through
// setSelection() so the checkboxes, highlight and bulk-action bar stay in step.

function isFolderKey(k) { return k.charAt(k.length - 1) === "/"; }

function splitItems(items) {
  var out = { folders: [], files: [] };
  items.forEach(function (k) { (isFolderKey(k) ? out.folders : out.files).push(k); });
  return out;
}

function selectableEls() {
  return document.querySelectorAll("#rows tr[data-key], #grid .tile[data-key]");
}

function setSelection(keys) {
  selected = keys;
  syncSelectionUI();
}

function syncSelectionUI() {
  // A lookup map, not repeated indexOf: with 200 items in the folder that was
  // 40 000 string comparisons per frame while dragging a band.
  var picked = Object.create(null);
  selected.forEach(function (k) { picked[k] = true; });
  Array.prototype.forEach.call(selectableEls(), function (el) {
    var on = picked[el._key] === true;
    if (el.classList.contains("selected") !== on) el.classList.toggle("selected", on);
    // _selcb is cached by wireItem: a querySelector per row per frame is
    // wasteful while a rubber band is being dragged.
    var cb = el._selcb;
    if (cb && cb.checked !== on) cb.checked = on;
  });
  var all = document.getElementById("selectAll");
  if (all) {
    all.checked = lastItems.length > 0 && selected.length === lastItems.length;
    all.indeterminate = selected.length > 0 && selected.length < lastItems.length;
  }
  document.getElementById("selectionBar").classList.toggle("show", selected.length > 0);
  document.getElementById("selectionCount").textContent = selected.length + " selected";
}

function toggleSelect(key, on) {
  var i = selected.indexOf(key);
  if (on && i === -1) selected.push(key);
  if (!on && i !== -1) selected.splice(i, 1);
  syncSelectionUI();
}

function clearSelection() {
  selectAnchor = null;
  setSelection([]);
}

function selectAllItems() {
  selectAnchor = null;
  setSelection(lastItems.slice());
}

// Shift-click: everything between the anchor and the clicked item, in the
// order they are currently displayed.
function selectRange(fromKey, toKey, additive) {
  var i = lastItems.indexOf(fromKey), j = lastItems.indexOf(toKey);
  if (i === -1 || j === -1) { toggleSelect(toKey, true); return; }
  if (i > j) { var t = i; i = j; j = t; }
  var keys = additive ? selected.slice() : [];
  for (var n = i; n <= j; n++) {
    if (keys.indexOf(lastItems[n]) === -1) keys.push(lastItems[n]);
  }
  setSelection(keys);
}

// Wires one row or tile: a click selects it, a double click opens it (folders
// navigate, files preview), Ctrl/Cmd-click toggles and Shift-click takes a
// range. "openItem" may be null for views where nothing opens.
function wireItem(el, key, openItem) {
  el.dataset.key = key;
  el._key = key; // dataset reads are slow in a per-frame loop
  el._selcb = el.querySelector(".selcb");
  if (selected.indexOf(key) !== -1) el.classList.add("selected");

  function open() {
    // swallow the phantom click that can follow a drag gesture
    if (!openItem || Date.now() - lastDragEnd < 400) return;
    openItem();
  }

  el.addEventListener("mousedown", function (e) {
    if (e.shiftKey) e.preventDefault(); // stop the browser selecting text
  });
  el.addEventListener("click", function (e) {
    // buttons and the checkbox keep their own behaviour
    if (e.target.closest("button, input, a")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && selectAnchor !== null) {
      selectRange(selectAnchor, key, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelect(key, selected.indexOf(key) === -1);
      selectAnchor = key;
    } else if (lastPointerType === "touch") {
      open();
    } else {
      // Plain click replaces the selection. Note this runs on mouseup, so
      // dragging a multi-selection still carries the whole group.
      setSelection([key]);
      selectAnchor = key;
    }
  });
  el.addEventListener("dblclick", function (e) {
    if (e.target.closest("button, input, a")) return;
    e.preventDefault();
    open();
  });
}

function openItemKey(key) {
  if (isFolderKey(key)) { setMode("files"); load(key); }
  else openPreview(key);
}

// Dragging an item that is part of the selection carries the whole selection.
function setDragPayload(e, key) {
  if (selected.length && selected.indexOf(key) !== -1) {
    e.dataTransfer.setData("application/x-drive-keys", JSON.stringify(selected));
  } else if (isFolderKey(key)) {
    e.dataTransfer.setData("application/x-drive-dir", key);
  } else {
    e.dataTransfer.setData("application/x-drive-key", key);
  }
  e.dataTransfer.effectAllowed = "move";
}

function makeCheckbox(key) {
  var cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "selcb";
  cb.checked = selected.indexOf(key) !== -1;
  cb.onchange = function () { toggleSelect(key, cb.checked); selectAnchor = key; };
  cb.onclick = function (e) { e.stopPropagation(); };
  return cb;
}

function makeSelTd(key) {
  var td = document.createElement("td");
  td.className = "sel";
  if (key) td.appendChild(makeCheckbox(key));
  return td;
}

function makeTileCb(key) {
  var cb = makeCheckbox(key);
  cb.className = "selcb tilecb";
  return cb;
}

// ---- Compact layout (phones) ----
//
// Below 700px the toolbar's secondary actions and every row's action buttons
// collapse into "⋯" menus, and the folder tree becomes a slide-in drawer.
// The overflow buttons are MOVED into the menu rather than cloned, so setMode()
// keeps driving the very same elements whichever layout is in force.

var narrowMQ = window.matchMedia("(max-width: 700px)");
var OVERFLOW_IDS = ["newFolderBtn", "uploadFolderBtn", "backupBtn", "sharesBtn",
  "trashBtn", "restoreAllBtn", "emptyTrashBtn", "revokeAllBtn", "logoutBtn"];
var toolbarOrder = null;
var compactApplied = null; // which layout the toolbar is currently in
var menuAnchor = null;

function closeMenus() {
  document.getElementById("itemMenu").classList.remove("open");
  document.getElementById("overflowMenu").classList.remove("open");
  menuAnchor = null;
}

// Anchors a menu under its button, pulled back inside the viewport if it would
// run off the right edge, and flipped above the button near the bottom.
function placeMenu(menu, anchor) {
  menu.style.left = "0px";
  menu.style.top = "0px";
  var r = anchor.getBoundingClientRect();
  var m = menu.getBoundingClientRect();
  var left = Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8));
  var top = r.bottom + 6;
  if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 6);
  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
}

// Returns true if the menu ended up open. A second tap on the same button closes it.
function toggleMenu(menu, anchor) {
  var reopening = menu.classList.contains("open") && menuAnchor === anchor;
  closeMenus();
  if (reopening) return false;
  menu.classList.add("open");
  menuAnchor = anchor;
  placeMenu(menu, anchor);
  return true;
}

function openItemMenu(anchor, actions) {
  var menu = document.getElementById("itemMenu");
  menu.innerHTML = "";
  actions.forEach(function (a) {
    var b = document.createElement("button");
    b.textContent = a.label;
    if (a.danger) b.className = "danger";
    b.onclick = function (e) { e.stopPropagation(); closeMenus(); a.onClick(); };
    menu.appendChild(b);
  });
  toggleMenu(menu, anchor);
}

// The "⋯" that stands in for a row's or tile's action buttons on a phone.
// Hidden by CSS on wide screens, where the buttons themselves are shown.
function makeKebab(actions) {
  var b = document.createElement("button");
  b.className = "kebab";
  b.type = "button";
  b.textContent = "⋯";
  b.title = "Actions";
  b.setAttribute("aria-label", "Actions");
  b.onclick = function (e) { e.stopPropagation(); openItemMenu(b, actions); };
  return b;
}

// Driven by window resize (which covers a phone being rotated across the
// breakpoint) rather than the media query's own change event, which some
// browsers don't fire for programmatic viewport changes. Cheap to call: it
// returns immediately unless the layout actually has to swap.
function syncCompactToolbar() {
  var bar = document.getElementById("toolbar");
  var menu = document.getElementById("overflowMenu");
  if (compactApplied === narrowMQ.matches) return;
  compactApplied = narrowMQ.matches;
  // Captured before anything moves, so going back to the wide layout restores
  // the authored order exactly.
  if (!toolbarOrder) toolbarOrder = Array.prototype.slice.call(bar.children);
  if (narrowMQ.matches) {
    OVERFLOW_IDS.forEach(function (id) { menu.appendChild(document.getElementById(id)); });
  } else {
    toolbarOrder.forEach(function (el) { bar.appendChild(el); });
  }
  document.getElementById("moreBtn").style.display = narrowMQ.matches ? "" : "none";
  // Short labels on a phone: "Upload files" and "Grid view" together overflow
  // the one toolbar row that has to hold them.
  document.getElementById("uploadBtn").textContent = narrowMQ.matches ? "Upload" : "Upload files";
  document.getElementById("backBtn").textContent = narrowMQ.matches ? "← Back" : "← Back to files";
  document.getElementById("viewToggleBtn").textContent = viewToggleLabel(folderViewStyle(currentPrefix));
  closeMenus();
}

function viewToggleLabel(style) {
  if (narrowMQ.matches) return style === "grid" ? "List" : "Grid";
  return style === "grid" ? "List view" : "Grid view";
}

function setDrawer(open) {
  document.getElementById("sidebar").classList.toggle("open", open);
  document.getElementById("sidebarBackdrop").classList.toggle("open", open);
}

// ---- Rubber-band selection (drag a box over empty space) ----

var mq = null;

function startMarquee(e) {
  mq = {
    x0: e.pageX, y0: e.pageY, x1: e.pageX, y1: e.pageY,
    cy: e.clientY,
    base: (e.ctrlKey || e.metaKey || e.shiftKey) ? selected.slice() : [],
    el: null, timer: null, raf: 0, boxes: null
  };
  document.addEventListener("mousemove", onMarqueeMove);
  document.addEventListener("mouseup", endMarquee);
}

// Rows don't move while the band is being dragged, so measure them once. Page
// coordinates are scroll-independent, which keeps the snapshot valid while the
// list auto-scrolls. Measuring per mousemove instead would force a full layout
// on every event — the difference is very visible in a folder of 200 photos.
function marqueeSnapshot() {
  mq.boxes = Array.prototype.map.call(selectableEls(), function (el) {
    var r = el.getBoundingClientRect();
    return {
      key: el._key,
      l: r.left + window.scrollX, t: r.top + window.scrollY,
      r: r.right + window.scrollX, b: r.bottom + window.scrollY
    };
  });
}

function onMarqueeMove(e) {
  if (!mq) return;
  mq.x1 = e.pageX;
  mq.y1 = e.pageY;
  mq.cy = e.clientY;
  if (!mq.el) {
    // a few px of slop so a plain click on empty space isn't a 0x0 drag
    if (Math.abs(mq.x1 - mq.x0) < 5 && Math.abs(mq.y1 - mq.y0) < 5) return;
    mq.el = document.createElement("div");
    mq.el.id = "marquee";
    document.body.appendChild(mq.el);
    document.body.classList.add("marqueeing");
    hideHoverPreview();
    marqueeSnapshot();
    mq.timer = setInterval(marqueeAutoScroll, 40);
  }
  e.preventDefault();
  scheduleMarqueeDraw();
}

// Redraw at most once per frame, however fast the mouse reports.
function scheduleMarqueeDraw() {
  if (!mq || mq.raf) return;
  mq.raf = requestAnimationFrame(function () {
    if (!mq) return;
    mq.raf = 0;
    drawMarquee();
  });
}

function drawMarquee() {
  var l = Math.min(mq.x0, mq.x1), t = Math.min(mq.y0, mq.y1);
  var r = Math.max(mq.x0, mq.x1), b = Math.max(mq.y0, mq.y1);
  mq.el.style.left = l + "px";
  mq.el.style.top = t + "px";
  mq.el.style.width = (r - l) + "px";
  mq.el.style.height = (b - t) + "px";

  var keys = mq.base.slice();
  var seen = Object.create(null);
  keys.forEach(function (k) { seen[k] = true; });
  mq.boxes.forEach(function (box) {
    if (box.l < r && box.r > l && box.t < b && box.b > t && seen[box.key] !== true) {
      seen[box.key] = true;
      keys.push(box.key);
    }
  });
  // Only touch the DOM when the set actually changed: dragging across empty
  // space shouldn't rewrite 200 checkboxes every frame.
  if (!sameKeys(keys, selected)) setSelection(keys);
}

function sameKeys(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Dragging past the top/bottom edge keeps the list moving under the box.
function marqueeAutoScroll() {
  if (!mq || !mq.el) return;
  var edge = 60, speed = 0;
  if (mq.cy < edge) speed = -Math.min(28, (edge - mq.cy) / 2);
  else if (mq.cy > window.innerHeight - edge) speed = Math.min(28, (mq.cy - (window.innerHeight - edge)) / 2);
  if (!speed) return;
  var before = window.scrollY;
  window.scrollBy(0, speed);
  var moved = window.scrollY - before;
  if (moved) { mq.y1 += moved; scheduleMarqueeDraw(); }
}

function endMarquee(e) {
  document.removeEventListener("mousemove", onMarqueeMove);
  document.removeEventListener("mouseup", endMarquee);
  if (!mq) return;
  if (mq.raf) cancelAnimationFrame(mq.raf);
  // Apply the final rectangle: releasing the button before the next frame
  // would otherwise drop the last part of the drag.
  if (mq.el) drawMarquee();
  if (mq.el) {
    clearInterval(mq.timer);
    mq.el.remove();
    document.body.classList.remove("marqueeing");
    lastDragEnd = Date.now(); // swallow the click that follows the drag
  } else if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
    clearSelection(); // plain click on empty space
  }
  mq = null;
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
    var label = "Trash";
    if (mode === "search") label = 'Search: "' + searchQuery + '"';
    if (mode === "shares") label = "Shared links";
    t.textContent = label;
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

function makeRow(nameText, icon, sizeText, dateText, actionButtons) {
  var tr = document.createElement("tr");
  tr.className = "row";

  var nameTd = document.createElement("td");
  nameTd.className = "name";
  nameTd.textContent = icon + " " + nameText;
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
  actionsTd.appendChild(makeKebab(actionButtons || []));
  tr.appendChild(actionsTd);

  return tr;
}

function showEmpty(count, message) {
  var el = document.getElementById("empty");
  el.textContent = message;
  el.style.display = count === 0 ? "block" : "none";
}

// Folder navigation is mirrored into the URL hash so the browser's
// back/forward buttons walk the folder levels, and reloads keep the place.
// The whole ancestor chain is pushed each time, so Back always goes UP one
// level (Rennes -> France -> Home) even after jumping straight to a deep
// folder from the tree.
function pushPrefixHash(prefix) {
  var chain = [""];
  var acc = "";
  prefix.split("/").filter(Boolean).forEach(function (p) {
    acc += p + "/";
    chain.push(acc);
  });
  chain.forEach(function (pfx) {
    var h = "#/" + encodeURI(pfx);
    if (location.hash === h) return;
    if (!location.hash && pfx === "") {
      history.replaceState(null, "", h);
    } else {
      history.pushState(null, "", h);
    }
  });
}

function applyHash() {
  if (location.hash === "#trash") { setMode("trash"); loadTrash(); return; }
  if (location.hash === "#shares") { setMode("shares"); loadShares(); return; }
  var prefix = "";
  if (location.hash.indexOf("#/") === 0) prefix = decodeURI(location.hash.slice(2));
  setMode("files");
  load(prefix, true);
}

// Per-folder view style: folders named "photos" default to the tile grid;
// the toggle button stores an override per folder.
function folderViewStyle(prefix) {
  var saved = localStorage.getItem("viewstyle:" + prefix);
  if (saved) return saved;
  var seg = prefix.replace(/\/$/, "").split("/").pop().toLowerCase();
  return seg === "photos" ? "grid" : "list";
}

function showListLayout() {
  document.getElementById("fileTable").style.display = "";
  var grid = document.getElementById("grid");
  grid.style.display = "none";
  grid.innerHTML = "";
}

function renameFolder(folder) {
  var name = folder.replace(/\/$/, "").split("/").pop();
  var input = prompt("Rename folder to:", name);
  if (input === null) return;
  input = input.trim().replace(/\/+$/, "");
  if (!input || input === name) return;
  if (input.indexOf("/") !== -1) { alert("The name cannot contain /"); return; }
  var parent = folder.slice(0, folder.length - name.length - 1);
  var to = parent + input + "/";
  movePrefixWithProgress(folder, to, input);
}

function load(prefix, fromHistory) {
  currentPrefix = prefix;
  if (!fromHistory) pushPrefixHash(prefix);
  clearSelection();
  renderBreadcrumb();
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      sortList(data.folders,
        function (f) { return f.prefix; },
        function (f) { return f.size; },
        function (f) { return f.modified; });
      sortList(data.files,
        function (f) { return f.key; },
        function (f) { return f.size; },
        function (f) { return f.uploaded; });
      lastFiles = data.files.map(function (f) { return f.key; });
      fileMeta = {};
      data.files.forEach(function (f) { fileMeta[f.key] = { size: f.size, uploaded: f.uploaded }; });
      // Folders render first in both layouts, so ranges follow that order.
      lastItems = data.folders.map(function (f) { return f.prefix; }).concat(lastFiles);
      var style = folderViewStyle(prefix);
      document.getElementById("viewToggleBtn").textContent = viewToggleLabel(style);
      var table = document.getElementById("fileTable");
      var grid = document.getElementById("grid");
      document.getElementById("rows").innerHTML = "";
      grid.innerHTML = "";
      if (style === "grid") {
        table.style.display = "none";
        grid.style.display = "grid";
        renderGrid(data, prefix);
      } else {
        table.style.display = "";
        grid.style.display = "none";
        renderListRows(data, prefix);
      }
      showEmpty(data.folders.length + data.files.length, "This folder is empty.");
      updateTreeActive();
    });
}

function renderListRows(data, prefix) {
  var rows = document.getElementById("rows");

  data.folders.forEach(function (f) {
    var folder = f.prefix;
    var name = folder.slice(prefix.length).replace(/\/$/, "");
    var sizeText = f.count ? humanSize(f.size) : "";
    var dateText = f.modified ? humanDate(f.modified) : "";
    var tr = makeRow(name, "📁", sizeText, dateText, [
      { label: "Rename", onClick: function () { renameFolder(folder); } },
      { label: "Delete", onClick: function () { removeFolder(folder); } }
    ]);
    makeDropTarget(tr, folder);
    tr.insertBefore(makeSelTd(folder), tr.firstChild);
    wireItem(tr, folder, function () { load(folder); });
    tr.draggable = true;
    tr.addEventListener("dragstart", function (e) { setDragPayload(e, folder); });
    tr.addEventListener("dragend", function () { lastDragEnd = Date.now(); });
    rows.appendChild(tr);
  });

  data.files.forEach(function (file) {
    var name = file.key.slice(prefix.length);
    var tr = makeRow(name, iconFor(file.key), humanSize(file.size), humanDate(file.uploaded), [
      { label: "Share", onClick: function () { shareFile(file.key); } },
      { label: "Rename", onClick: function () { renameFile(file.key); } },
      { label: "Download", onClick: function () { download(file.key); } },
      { label: "Delete", onClick: function () { removeFile(file.key); } }
    ]);
    tr.insertBefore(makeSelTd(file.key), tr.firstChild);
    wireItem(tr, file.key, function () { openPreview(file.key); });
    tr.draggable = true;
    tr.addEventListener("dragstart", function (e) {
      hideHoverPreview();
      setDragPayload(e, file.key);
    });
    tr.addEventListener("mouseenter", function (e) {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () { showHoverPreview(file.key, e.clientX, e.clientY); }, 450);
    });
    tr.addEventListener("mousemove", function (e) {
      var hp = document.getElementById("hoverPreview");
      if (hp.style.display === "block") positionHover(hp, e.clientX, e.clientY);
    });
    tr.addEventListener("mouseleave", hideHoverPreview);
    tr.addEventListener("dragend", function () { lastDragEnd = Date.now(); });
    rows.appendChild(tr);
  });
}

var ICONS = {
  share: "<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7'/><path d='M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'/></svg>",
  rename: "<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'/></svg>",
  download: "<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/><polyline points='7 10 12 15 17 10'/><line x1='12' y1='15' x2='12' y2='3'/></svg>",
  trash: "<svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='3 6 5 6 21 6'/><path d='M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'/><path d='M10 11v6'/><path d='M14 11v6'/><path d='M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'/></svg>"
};

function tileActions(buttons) {
  var d = document.createElement("div");
  d.className = "tacts";
  buttons.forEach(function (b) {
    var btn = document.createElement("button");
    btn.innerHTML = ICONS[b.icon];
    btn.title = b.title;
    if (b.danger) btn.className = "danger";
    btn.onclick = function (e) { e.stopPropagation(); b.onClick(); };
    d.appendChild(btn);
  });
  // Same actions as a labelled list, for the phone layout.
  d.appendChild(makeKebab(buttons.map(function (b) {
    return { label: b.title, danger: b.danger, onClick: b.onClick };
  })));
  return d;
}

function fileIcon(emoji) {
  var d = document.createElement("div");
  d.className = "thumbIcon";
  d.textContent = emoji;
  return d;
}

function renderGrid(data, prefix) {
  var grid = document.getElementById("grid");

  data.folders.forEach(function (f) {
    var folder = f.prefix;
    var name = folder.slice(prefix.length).replace(/\/$/, "");
    var tile = document.createElement("div");
    tile.className = "tile";
    tile.appendChild(fileIcon("📁"));
    var nm = document.createElement("div");
    nm.className = "tname";
    nm.textContent = name;
    nm.title = name;
    tile.appendChild(nm);
    tile.appendChild(tileActions([
      { icon: "rename", title: "Rename", onClick: function () { renameFolder(folder); } },
      { icon: "trash", title: "Delete", danger: true, onClick: function () { removeFolder(folder); } }
    ]));
    tile.appendChild(makeTileCb(folder));
    wireItem(tile, folder, function () { load(folder); });
    makeDropTarget(tile, folder);
    tile.draggable = true;
    tile.addEventListener("dragstart", function (e) { setDragPayload(e, folder); });
    tile.addEventListener("dragend", function () { lastDragEnd = Date.now(); });
    grid.appendChild(tile);
  });

  data.files.forEach(function (file) {
    var name = file.key.slice(prefix.length);
    var tile = document.createElement("div");
    tile.className = "tile";
    var ext = extOf(file.key);
    var isVid = VIDEO_EXTS.indexOf(ext) !== -1;
    if (IMAGE_EXTS.indexOf(ext) !== -1 || isVid) {
      var im = document.createElement("img");
      im.className = "thumb";
      im.loading = "lazy";
      im.decoding = "async";
      // Resized (photos) or a still frame (videos), both server-side.
      im.src = "/api/thumb?key=" + encodeURIComponent(file.key);
      // A frame on its own looks exactly like a photo, so mark it as playable.
      var badge = null;
      if (isVid) {
        badge = document.createElement("div");
        badge.className = "playBadge";
        badge.textContent = "▶";
      }
      im.onerror = function () {
        im.onerror = null;
        if (isVid) {
          // No frame could be produced — unsupported codec, or too large. The
          // original is a whole video, so an icon is all that's left, and 🎬
          // already says "video" without the badge on top of it.
          tile.replaceChild(fileIcon("🎬"), im);
          badge.remove();
        } else {
          im.src = "/api/object?key=" + encodeURIComponent(file.key) + "&view=1";
        }
      };
      tile.appendChild(im);
      if (badge) tile.appendChild(badge);
    } else {
      tile.appendChild(fileIcon(iconFor(file.key)));
    }
    var nm = document.createElement("div");
    nm.className = "tname";
    nm.textContent = name;
    nm.title = name;
    tile.appendChild(nm);

    tile.appendChild(makeTileCb(file.key));

    tile.appendChild(tileActions([
      { icon: "share", title: "Share", onClick: function () { shareFile(file.key); } },
      { icon: "rename", title: "Rename", onClick: function () { renameFile(file.key); } },
      { icon: "download", title: "Download", onClick: function () { download(file.key); } },
      { icon: "trash", title: "Delete", danger: true, onClick: function () { removeFile(file.key); } }
    ]));

    wireItem(tile, file.key, function () { openPreview(file.key); });
    tile.draggable = true;
    tile.addEventListener("dragstart", function (e) {
      hideHoverPreview();
      setDragPayload(e, file.key);
    });
    tile.addEventListener("dragend", function () { lastDragEnd = Date.now(); });
    grid.appendChild(tile);
  });
}

function loadTrash() {
  showListLayout();
  renderBreadcrumb();
  return fetch("/api/trash/list")
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      var rows = document.getElementById("rows");
      rows.innerHTML = "";

      lastFiles = [];
      lastItems = [];
      sortList(data.files,
        function (f) { return f.original; },
        function (f) { return f.size; },
        function (f) { return f.deleted; });
      data.files.forEach(function (file) {
        var tr = makeRow(file.original, "🗑️", humanSize(file.size), humanDate(file.deleted), [
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
  if (mode === "shares") return loadShares();
  return load(currentPrefix);
}

function loadShares() {
  showListLayout();
  renderBreadcrumb();
  return fetch("/api/shares")
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (mode !== "shares") return;
      var rows = document.getElementById("rows");
      rows.innerHTML = "";
      lastFiles = [];
      lastItems = [];
      var now = Math.floor(Date.now() / 1000);
      data.shares.forEach(function (s) {
        var expText = s.exp ? new Date(s.exp * 1000).toLocaleString() : "?";
        var tr = makeRow(s.key, "🔗", s.exp < now ? "expired" : "active", expText, [
          { label: "Copy link", onClick: function () {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(s.url);
              } else {
                prompt("Copy the share link:", s.url);
              }
            } },
          { label: "Revoke", danger: true, onClick: function () { revokeShare(s.id); } }
        ]);
        tr.insertBefore(makeSelTd(null), tr.firstChild);
        rows.appendChild(tr);
      });
      showEmpty(data.shares.length, "No share links. Use a file's Share button to create one.");
      updateTreeActive();
    });
}

function revokeShare(id) {
  fetch("/api/shares/revoke?id=" + encodeURIComponent(id), { method: "POST" })
    .then(checkAuth).then(refresh);
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

// ---- Hover preview (small popup following the cursor) ----

var hoverTimer = null;

function positionHover(el, x, y) {
  var w = 320, h = 380, m = 12;
  var left = x + 18, top = y + 18;
  if (left + w + m > window.innerWidth) left = x - w - 18;
  if (top + h + m > window.innerHeight) top = Math.max(m, window.innerHeight - h - m);
  if (left < m) left = m;
  el.style.left = left + "px";
  el.style.top = top + "px";
}

function showHoverPreview(key, x, y) {
  if (mq && mq.el) return; // not while a rubber band is being dragged
  var ext = extOf(key);
  var url = "/api/object?key=" + encodeURIComponent(key) + "&view=1";
  var imgs = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"];
  var texts = ["txt", "md", "csv", "json", "js", "css", "log", "yml", "yaml", "ini", "py", "sh"];
  var node = null;
  if (imgs.indexOf(ext) !== -1) {
    node = document.createElement("img");
    // The popup is 320px wide, so the resized copy is plenty and loads instantly.
    node.src = "/api/thumb?key=" + encodeURIComponent(key);
  } else if (ext === "pdf") {
    node = document.createElement("iframe");
    node.src = url + "#toolbar=0&navpanes=0&scrollbar=0&view=FitH";
  } else if (texts.indexOf(ext) !== -1) {
    node = document.createElement("iframe");
    node.src = url;
  }
  if (!node) return; // other types: no hover preview, click opens the full one
  var el = document.getElementById("hoverPreview");
  el.innerHTML = "";
  el.appendChild(node);
  positionHover(el, x, y);
  el.style.display = "block";
}

function hideHoverPreview() {
  clearTimeout(hoverTimer);
  var el = document.getElementById("hoverPreview");
  el.style.display = "none";
  el.innerHTML = "";
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

// Chrome's PDF viewer grabs keyboard focus when it loads, which would swallow
// the Escape key. Take focus back, and also listen for Escape inside
// same-origin preview frames as a best effort.
function escFrame(frame) {
  frame.addEventListener("load", function () {
    setTimeout(function () {
      var ov = document.getElementById("previewOverlay");
      if (ov.style.display !== "none") ov.focus();
    }, 50);
    try {
      frame.contentWindow.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closePreview();
        else if (e.key === "ArrowLeft") stepPreview(-1);
        else if (e.key === "ArrowRight") stepPreview(1);
      });
    } catch (err) { /* cross-origin frame (Office viewer): ignore */ }
  });
}

function stepPreview(delta) {
  if (!previewKey) return;
  var i = lastFiles.indexOf(previewKey);
  var j = i + delta;
  if (i === -1 || j < 0 || j >= lastFiles.length) return;
  openPreview(lastFiles[j]);
}

function openPreview(key) {
  hideHoverPreview();
  previewKey = key;
  document.getElementById("previewTitle").textContent = key.split("/").pop();
  var pos = lastFiles.indexOf(key);
  document.getElementById("previewCount").textContent =
    pos === -1 ? "" : (pos + 1) + " / " + lastFiles.length;
  var body = document.getElementById("previewBody");
  body.innerHTML = "";
  document.getElementById("previewOverlay").style.display = "flex";

  document.getElementById("previewOverlay").focus();

  var inlineUrl = "/api/object?key=" + encodeURIComponent(key) + "&view=1";
  var ext = extOf(key);
  var images = IMAGE_EXTS;
  var texts = ["txt", "md", "csv", "json", "js", "css", "html", "htm", "xml", "svg", "log", "yml", "yaml", "ini", "py", "sh"];
  var office = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];
  var audios = ["mp3", "wav", "m4a", "ogg", "flac"];
  var videos = VIDEO_EXTS;

  if (images.indexOf(ext) !== -1) {
    var img = document.createElement("img");
    img.src = inlineUrl;
    body.appendChild(img);
  } else if (ext === "pdf" || texts.indexOf(ext) !== -1) {
    var frame = document.createElement("iframe");
    frame.src = inlineUrl;
    escFrame(frame);
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
        escFrame(frame);
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
          escFrame(frame2);
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

// Moves any mix of files and folders into destPrefix. Folders are expanded to
// the keys underneath them (markers included) so everything travels as one job
// with a single progress bar.
function moveItems(items, destPrefix) {
  items = items.filter(Boolean);
  if (!items.length) return;

  var nested = items.filter(function (k) {
    return isFolderKey(k) && folderTarget(k, destPrefix).indexOf(k) === 0;
  });
  if (nested.length) { alert("Cannot move a folder inside itself."); return; }

  setProgress("Preparing…", 0, 1);
  Promise.all(items.map(function (k) {
    if (!isFolderKey(k)) {
      return Promise.resolve([{ from: k, to: destPrefix + k.split("/").pop() }]);
    }
    var to = folderTarget(k, destPrefix);
    return fetch("/api/keys?prefix=" + encodeURIComponent(k))
      .then(checkAuth)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        return data.keys.map(function (sub) { return { from: sub, to: to + sub.slice(k.length) }; });
      });
  })).then(function (groups) {
    var pairs = [];
    groups.forEach(function (g) {
      g.forEach(function (p) { if (p.from !== p.to) pairs.push(p); });
    });
    runMoves(pairs);
  });
}

function folderTarget(prefix, destPrefix) {
  return destPrefix + prefix.replace(/\/$/, "").split("/").pop() + "/";
}

// Renames pairs three at a time so a big folder doesn't fire hundreds of
// requests at once.
function runMoves(pairs, label) {
  var what = label ? "Moving " + label : "Moving";
  if (!pairs.length) {
    hideProgress();
    clearSelection();
    initTree();
    refresh();
    return;
  }
  var idx = 0, active = 0, done = 0, failed = 0;
  setProgress(what + ": 0/" + pairs.length, 0, pairs.length);
  function pump() {
    while (active < 3 && idx < pairs.length) {
      (function (p) {
        active++;
        fetchRetry("/api/rename?from=" + encodeURIComponent(p.from) + "&to=" + encodeURIComponent(p.to), { method: "POST" })
          .then(checkAuth)
          .then(function (res) { if (!res.ok) failed++; })
          .catch(function () { failed++; })
          .then(function () {
            active--;
            done++;
            setProgress(what + ": " + done + "/" + pairs.length, done, pairs.length);
            if (done === pairs.length) {
              hideProgress();
              if (failed) alert(failed + " item(s) could not be moved (name conflicts) and stayed in place.");
              clearSelection();
              initTree();
              refreshUsage();
              refresh();
            } else {
              pump();
            }
          });
      })(pairs[idx]);
      idx++;
    }
  }
  pump();
}

function loadSearch() {
  clearSelection();
  showListLayout();
  renderBreadcrumb();
  return fetch("/api/search?q=" + encodeURIComponent(searchQuery))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (mode !== "search") return; // user navigated away while we were fetching
      var rows = document.getElementById("rows");
      rows.innerHTML = "";
      sortList(data.files,
        function (f) { return f.key; },
        function (f) { return f.size; },
        function (f) { return f.uploaded; });
      lastFiles = data.files.map(function (f) { return f.key; });
      lastItems = lastFiles.slice();

      data.files.forEach(function (file) {
        var tr = makeRow(file.key, iconFor(file.key), humanSize(file.size), humanDate(file.uploaded), [
          { label: "Share", onClick: function () { shareFile(file.key); } },
          { label: "Rename", onClick: function () { renameFile(file.key); } },
          { label: "Download", onClick: function () { download(file.key); } },
          { label: "Delete", onClick: function () { removeFile(file.key); } }
        ]);
        tr.insertBefore(makeSelTd(file.key), tr.firstChild);
        wireItem(tr, file.key, function () { openPreview(file.key); });
        tr.draggable = true;
        tr.addEventListener("dragstart", function (e) {
          hideHoverPreview();
          setDragPayload(e, file.key);
        });
        tr.addEventListener("mouseenter", function (e) {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(function () { showHoverPreview(file.key, e.clientX, e.clientY); }, 450);
        });
        tr.addEventListener("mousemove", function (e) {
          var hp = document.getElementById("hoverPreview");
          if (hp.style.display === "block") positionHover(hp, e.clientX, e.clientY);
        });
        tr.addEventListener("mouseleave", hideHoverPreview);
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
  fetch("/api/sign?key=" + encodeURIComponent(key) + "&ttl=" + ttl + "&share=1")
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

// ---- Full-drive backup (ZIP built client-side, stored uncompressed) ----

var crcTable = null;
function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  var crc = 0xffffffff;
  for (var i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  if (isNaN(d.getTime())) d = new Date();
  var year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function listAllFiles(prefix) {
  return fetch("/api/list?prefix=" + encodeURIComponent(prefix))
    .then(checkAuth)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var subs = data.folders.map(function (f) { return listAllFiles(f.prefix); });
      return Promise.all(subs).then(function (nested) {
        var all = data.files.slice();
        nested.forEach(function (n) { all = all.concat(n); });
        return all;
      });
    });
}

// Backup and "Download selected" both land here: files are fetched one at a
// time and appended to a stored (uncompressed) ZIP assembled in the browser, so
// the Worker never holds an archive in memory. stripPrefix trims a leading
// folder off the entry names, which keeps a selection's zip flat instead of
// burying it under the folder it came from.
function zipFiles(files, zipName, label, stripPrefix) {
  var enc = new TextEncoder();
  var parts = [];
  var central = [];
  var offset = 0;
  var i = 0;

  function next() {
    if (i >= files.length) { finish(); return; }
    var f = files[i];
    setProgress(label + " " + (i + 1) + "/" + files.length + ": " + f.key, i, files.length);
    fetchRetry("/api/object?key=" + encodeURIComponent(f.key))
      .then(checkAuth)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        var data = new Uint8Array(buf);
        var name = f.key;
        if (stripPrefix && name.indexOf(stripPrefix) === 0) name = name.slice(stripPrefix.length);
        var nameBytes = enc.encode(name);
        var crc = crc32(data);
        // A search or trash selection may carry no upload stamp; dosDateTime
        // already falls back to now for an invalid date.
        var dt = dosDateTime(new Date(f.uploaded));
        var lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);
        lh.setUint16(6, 0x0800, true); // UTF-8 file names
        lh.setUint16(8, 0, true);      // stored, no compression
        lh.setUint16(10, dt.time, true);
        lh.setUint16(12, dt.date, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, data.length, true);
        lh.setUint32(22, data.length, true);
        lh.setUint16(26, nameBytes.length, true);
        lh.setUint16(28, 0, true);
        parts.push(new Uint8Array(lh.buffer), nameBytes, data);
        central.push({ name: nameBytes, crc: crc, size: data.length, time: dt.time, date: dt.date, offset: offset });
        offset += 30 + nameBytes.length + data.length;
        i++;
        next();
      })
      .catch(function () {
        hideProgress();
        alert(label + " aborted: could not download " + f.key + ". Try again.");
      });
  }

  function finish() {
    var cdStart = offset;
    central.forEach(function (c) {
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, c.time, true);
      ch.setUint16(14, c.date, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.name.length, true);
      ch.setUint32(42, c.offset, true);
      parts.push(new Uint8Array(ch.buffer), c.name);
      offset += 46 + c.name.length;
    });
    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, offset - cdStart, true);
    eocd.setUint32(16, cdStart, true);
    parts.push(new Uint8Array(eocd.buffer));

    var blob = new Blob(parts, { type: "application/zip" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
    hideProgress();
  }

  next();
}

function backupDrive() {
  setProgress("Preparing backup…", 0, 1);
  listAllFiles("").then(function (files) {
    if (!files.length) { hideProgress(); alert("Nothing to back up."); return; }
    zipFiles(files, "drive-backup-" + todayStamp() + ".zip", "Backing up", "");
  });
}

// "Download" on a selection. One file comes down as itself; anything else is
// zipped. Selected folders are expanded first so their contents keep their
// shape inside the archive, and entry names are relative to the folder on
// screen — grabbing ten photos out of Transfer/ gives you ten photos, not
// ten photos nested under Transfer/.
function downloadSelected() {
  if (!selected.length) return;
  var picked = splitItems(selected);
  if (!picked.folders.length && picked.files.length === 1) { download(picked.files[0]); return; }

  setProgress("Preparing download…", 0, 1);
  var loose = picked.files.map(function (k) {
    var m = fileMeta[k] || {};
    return { key: k, size: m.size, uploaded: m.uploaded };
  });
  Promise.all(picked.folders.map(function (p) { return listAllFiles(p); })).then(function (nested) {
    var files = loose.slice();
    nested.forEach(function (n) { files = files.concat(n); });
    if (!files.length) { hideProgress(); alert("Nothing to download — the selected folder is empty."); return; }
    if (files.length === 1) { hideProgress(); download(files[0].key); return; }
    // The whole archive is assembled as one Blob, so a huge selection is worth
    // a warning before the tab tries to hold it all at once.
    var bytes = files.reduce(function (n, f) { return n + (f.size || 0); }, 0);
    if (bytes > 512 * 1024 * 1024 &&
        !confirm("Zip " + files.length + " files (" + humanSize(bytes) + ")? The archive is built in the browser, so it has to fit in memory.")) {
      hideProgress();
      return;
    }
    zipFiles(files, "drive-selection-" + todayStamp() + ".zip", "Zipping", currentPrefix);
  });
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function dragKind(e) {
  var t = e.dataTransfer.types;
  if (Array.prototype.indexOf.call(t, "application/x-drive-keys") !== -1) return "files";
  if (Array.prototype.indexOf.call(t, "application/x-drive-key") !== -1) return "file";
  if (Array.prototype.indexOf.call(t, "application/x-drive-dir") !== -1) return "dir";
  return null;
}

// Renaming a folder = moving every object under it to the new prefix. (Moving
// a folder into another folder goes through moveItems instead, which keeps the
// folder's own name.)
function movePrefixWithProgress(srcPrefix, destPrefix, label) {
  setProgress("Preparing…", 0, 1);
  fetch("/api/keys?prefix=" + encodeURIComponent(srcPrefix))
    .then(checkAuth)
    .then(function (res) { return res.json(); })
    .then(function (data) {
      runMoves(data.keys.map(function (k) {
        return { from: k, to: destPrefix + k.slice(srcPrefix.length) };
      }), label);
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
    if (kind === "files") {
      moveItems(JSON.parse(e.dataTransfer.getData("application/x-drive-keys")), destPrefix);
    } else if (kind === "file") {
      moveItems([e.dataTransfer.getData("application/x-drive-key")], destPrefix);
    } else {
      moveItems([e.dataTransfer.getData("application/x-drive-dir")], destPrefix);
    }
  });
}

// ---- Folder tree (lazy-loaded) ----

function treeNode(prefix, name, depth) {
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
          children.appendChild(treeNode(sub.prefix, sub.prefix.slice(prefix.length).replace(/\/$/, ""), depth + 1));
        });
        if (data.folders.length === 0) arrow.style.visibility = "hidden";
      });
  };

  row.onclick = function () { setDrawer(false); setMode("files"); load(prefix); };
  makeDropTarget(row, prefix);

  wrap.appendChild(row);
  wrap.appendChild(children);
  // Auto-expand the first three levels; deeper branches open via the arrows.
  if (depth < 3) arrow.onclick(new Event("click"));
  return wrap;
}

function initTree() {
  var tree = document.getElementById("tree");
  tree.innerHTML = "";
  tree.appendChild(treeNode("", "Home", 1));
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
      var subfolders = data.folders.map(function (sub) { return deleteFolderContents(sub.prefix); });
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

// fetch with up to 3 attempts on network errors and 5xx responses.
function fetchRetry(url, opts, tries) {
  tries = tries === undefined ? 3 : tries;
  return fetch(url, opts).then(function (res) {
    if (res.status >= 500 && tries > 1) throw new Error("server " + res.status);
    return res;
  }).catch(function (err) {
    if (tries <= 1) throw err;
    return new Promise(function (r) { setTimeout(r, 800); }).then(function () {
      return fetchRetry(url, opts, tries - 1);
    });
  });
}

function setProgress(text, done, total) {
  document.getElementById("progress").textContent = text;
  document.getElementById("progressBarWrap").style.display = "block";
  var pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById("progressBarFill").style.width = pct + "%";
}

function hideProgress() {
  document.getElementById("progress").textContent = "";
  document.getElementById("progressBarWrap").style.display = "none";
  document.getElementById("progressBarFill").style.width = "0%";
}

// fetch() never says how much of a request body has gone out, so an upload
// could only ever move the bar between files — drop one big file in and it sat
// at 0% for the whole transfer, then jumped to done. XHR does report it.
// Resolves with the HTTP status; rejects only if the request never landed.
function putWithProgress(url, file, onProgress) {
  return new Promise(function (resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = function () {
      if (xhr.status === 401) { // session expired — the reload checkAuth does
        window.location.reload();
        var err = new Error("session expired");
        err.fatal = true;
        reject(err);
        return;
      }
      resolve(xhr.status);
    };
    xhr.onerror = function () { reject(new Error("network")); };
    xhr.send(file);
  });
}

// Same retry rule as fetchRetry: three tries, for network errors and 5xx only.
function putRetry(url, file, onProgress, tries) {
  tries = tries === undefined ? 3 : tries;
  return putWithProgress(url, file, onProgress).then(function (status) {
    if (status >= 500 && tries > 1) throw new Error("server " + status);
    return status;
  }).catch(function (err) {
    if (err.fatal || tries <= 1) throw err;
    onProgress(0); // a retry re-sends the file from the start
    return new Promise(function (r) { setTimeout(r, 800); }).then(function () {
      return putRetry(url, file, onProgress, tries - 1);
    });
  });
}

function uploadItems(items) {
  var i = 0;
  var failed = [];
  // The bar counts bytes, not files: with a single file the file counter never
  // moves, so the bar stayed at 0% for the whole upload — the one case where
  // it mattered most.
  var totalBytes = items.reduce(function (n, it) { return n + (it.file.size || 0); }, 0);
  var doneBytes = 0;

  function show(it, sent) {
    var label = "Uploading " + (i + 1) + "/" + items.length + ": " + it.relPath;
    if (!totalBytes) { setProgress(label, i, items.length); return; }
    setProgress(label + " — " + humanSize(doneBytes + sent) + " / " + humanSize(totalBytes),
      doneBytes + sent, totalBytes);
  }

  function next() {
    if (i >= items.length) {
      hideProgress();
      if (failed.length) {
        alert(failed.length + " file(s) failed to upload:\n" + failed.slice(0, 10).join("\n") +
          (failed.length > 10 ? "\n…" : ""));
      }
      refreshUsage();
      initTree();
      refresh();
      return;
    }
    var it = items[i];
    show(it, 0);
    putRetry("/api/object?key=" + encodeURIComponent(currentPrefix + it.relPath), it.file,
      function (sent) { show(it, sent); })
      .then(function (status) { if (status < 200 || status >= 300) failed.push(it.relPath); })
      .catch(function (err) { if (!err.fatal) failed.push(it.relPath); })
      .then(function () { doneBytes += it.file.size || 0; i++; next(); });
  }
  next();
}

function uploadFiles(fileList) {
  // webkitRelativePath is set when a whole folder was picked: keep its structure.
  var items = Array.prototype.map.call(fileList, function (f) {
    return { file: f, relPath: f.webkitRelativePath || f.name };
  });
  uploadItems(items);
}

// Walks a dropped directory tree (webkitGetAsEntry API) into {file, relPath} items.
function traverseEntry(entry, path) {
  return new Promise(function (resolve) {
    if (entry.isFile) {
      entry.file(
        function (f) { resolve([{ file: f, relPath: path + f.name }]); },
        function () { resolve([]); }
      );
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      var pending = [];
      function readBatch() {
        reader.readEntries(function (entries) {
          if (!entries.length) {
            Promise.all(pending).then(function (nested) {
              resolve(nested.reduce(function (a, b) { return a.concat(b); }, []));
            });
            return;
          }
          entries.forEach(function (en) { pending.push(traverseEntry(en, path + entry.name + "/")); });
          readBatch(); // readEntries returns at most ~100 entries per call
        }, function () { resolve([]); });
      }
      readBatch();
    } else {
      resolve([]);
    }
  });
}

document.getElementById("uploadBtn").onclick = function () { document.getElementById("fileInput").click(); };
document.getElementById("fileInput").onchange = function (e) { uploadFiles(e.target.files); e.target.value = ""; };
document.getElementById("uploadFolderBtn").onclick = function () { document.getElementById("folderInput").click(); };
document.getElementById("folderInput").onchange = function (e) { uploadFiles(e.target.files); e.target.value = ""; };

document.getElementById("newFolderBtn").onclick = function () {
  var name = prompt("Folder name:");
  if (!name) return;
  fetch("/api/mkdir?key=" + encodeURIComponent(currentPrefix + name + "/"), { method: "POST" })
    .then(checkAuth).then(function () { initTree(); refresh(); });
};

document.getElementById("trashBtn").onclick = function () {
  setMode("trash");
  if (location.hash !== "#trash") history.pushState(null, "", "#trash");
  loadTrash();
};
document.getElementById("sharesBtn").onclick = function () {
  setMode("shares");
  if (location.hash !== "#shares") history.pushState(null, "", "#shares");
  loadShares();
};
document.getElementById("revokeAllBtn").onclick = function () {
  if (!confirm("Revoke ALL share links? Anyone using them loses access immediately.")) return;
  fetch("/api/shares/revokeall", { method: "POST" }).then(checkAuth).then(refresh);
};
document.getElementById("restoreAllBtn").onclick = function () {
  fetch("/api/trash/list").then(checkAuth).then(function (r) { return r.json(); }).then(function (data) {
    if (!data.files.length) return;
    if (!confirm("Restore all " + data.files.length + " file(s) from the trash?")) return;
    var i = 0, failed = 0;
    function next() {
      if (i >= data.files.length) {
        hideProgress();
        if (failed) alert(failed + " file(s) could not be restored (a file with the same name exists).");
        refreshUsage();
        initTree();
        refresh();
        return;
      }
      var f = data.files[i];
      setProgress("Restoring " + (i + 1) + "/" + data.files.length + ": " + f.original, i, data.files.length);
      fetchRetry("/api/trash/restore?key=" + encodeURIComponent(f.key), { method: "POST" })
        .then(checkAuth)
        .then(function (res) { if (!res.ok) failed++; })
        .catch(function () { failed++; })
        .then(function () { i++; next(); });
    }
    next();
  });
};
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
  var entries = [];
  if (e.dataTransfer.items) {
    for (var j = 0; j < e.dataTransfer.items.length; j++) {
      var en = e.dataTransfer.items[j].webkitGetAsEntry && e.dataTransfer.items[j].webkitGetAsEntry();
      if (en) entries.push(en);
    }
  }
  if (entries.length) {
    // Handles dropped folders (recursively) as well as plain files.
    Promise.all(entries.map(function (en) { return traverseEntry(en, ""); }))
      .then(function (nested) {
        uploadItems(nested.reduce(function (a, b) { return a.concat(b); }, []));
      });
  } else if (e.dataTransfer.files.length) {
    uploadFiles(e.dataTransfer.files);
  }
});

document.getElementById("previewCloseBtn").onclick = closePreview;
document.getElementById("previewDownloadBtn").onclick = function () { if (previewKey) download(previewKey); };
document.getElementById("previewOverlay").addEventListener("click", function (e) {
  if (e.target === document.getElementById("previewBody")) closePreview();
});
document.addEventListener("keydown", function (e) {
  if (previewKey && e.key === "ArrowLeft") { stepPreview(-1); return; }
  if (previewKey && e.key === "ArrowRight") { stepPreview(1); return; }
  if (e.key === "Escape") {
    if (menuAnchor) closeMenus();
    else if (previewKey) closePreview();
    else if (document.getElementById("sidebar").classList.contains("open")) setDrawer(false);
    else if (selected.length) clearSelection();
    return;
  }
  var t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A") && !previewKey) {
    if (!lastItems.length) return;
    e.preventDefault();
    selectAllItems();
  } else if (e.key === "Enter" && !previewKey && selected.length === 1) {
    e.preventDefault();
    openItemKey(selected[0]);
  }
});
document.getElementById("previewPrevBtn").onclick = function () { stepPreview(-1); };
document.getElementById("previewNextBtn").onclick = function () { stepPreview(1); };
document.getElementById("thName").onclick = function () { setSort("name"); };
document.getElementById("thSize").onclick = function () { setSort("size"); };
document.getElementById("dateHeader").onclick = function () { setSort("date"); };

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
  if (this.checked) selectAllItems(); else clearSelection();
};

document.getElementById("bulkDownloadBtn").onclick = downloadSelected;
document.getElementById("bulkClearBtn").onclick = clearSelection;

// Rubber-band: only starts on empty space, so it never fights the row/tile
// drag-and-drop that moves files into folders.
document.querySelector("main").addEventListener("mousedown", function (e) {
  if (e.button !== 0) return;
  // Touch fires compatibility mouse events after a tap; a rubber band there
  // would only fight the page's own scrolling.
  if (lastPointerType === "touch") return;
  if (mode === "trash" || mode === "shares") return;
  if (document.getElementById("previewOverlay").style.display !== "none") return;
  if (e.target.closest("tr, .tile, button, input, textarea, select, a, #dropzone, #selectionBar")) return;
  e.preventDefault();
  startMarquee(e);
});

document.getElementById("backupBtn").onclick = function () {
  fetch("/api/usage")
    .then(checkAuth)
    .then(function (r) { return r.json(); })
    .then(function (u) {
      if (!confirm("Download a full backup of the drive as a ZIP (" + humanSize(u.driveBytes) + ", " + u.driveCount + " files)?")) return;
      backupDrive();
    });
};

document.getElementById("viewToggleBtn").onclick = function () {
  var next = folderViewStyle(currentPrefix) === "grid" ? "list" : "grid";
  localStorage.setItem("viewstyle:" + currentPrefix, next);
  load(currentPrefix, true);
};

document.getElementById("bulkDeleteBtn").onclick = function () {
  if (!selected.length) return;
  var s = splitItems(selected);
  var what = [];
  if (s.files.length) what.push(s.files.length + " file(s)");
  if (s.folders.length) what.push(s.folders.length + " folder(s) and everything inside");
  if (!confirm("Move " + what.join(" and ") + " to the trash?")) return;
  var jobs = s.files.map(function (k) {
    return fetch("/api/object?key=" + encodeURIComponent(k), { method: "DELETE" });
  }).concat(s.folders.map(function (p) { return deleteFolderContents(p); }));
  Promise.all(jobs).then(function () {
    clearSelection();
    initTree();
    refreshUsage();
    refresh();
  });
};

document.getElementById("bulkMoveBtn").onclick = function () {
  if (!selected.length) return;
  var dest = prompt('Destination folder (empty = Home, e.g. "Documents/"):', currentPrefix);
  if (dest === null) return;
  dest = dest.trim();
  if (dest && dest.charAt(dest.length - 1) !== "/") dest += "/";
  moveItems(selected.slice(), dest);
};

document.getElementById("treeBtn").onclick = function (e) {
  e.stopPropagation();
  setDrawer(!document.getElementById("sidebar").classList.contains("open"));
};
document.getElementById("sidebarBackdrop").onclick = function () { setDrawer(false); };

document.getElementById("moreBtn").onclick = function (e) {
  e.stopPropagation();
  toggleMenu(document.getElementById("overflowMenu"), this);
};
document.getElementById("overflowMenu").addEventListener("click", function (e) {
  if (e.target.closest("button")) closeMenus();
});

document.addEventListener("click", function (e) {
  if (menuAnchor && !e.target.closest(".menu, .kebab, #moreBtn")) closeMenus();
});
// A menu is positioned in viewport coordinates, so it has to go when the page
// moves underneath it.
window.addEventListener("scroll", closeMenus, true);
window.addEventListener("resize", function () { closeMenus(); syncCompactToolbar(); });
window.addEventListener("orientationchange", syncCompactToolbar);
if (narrowMQ.addEventListener) narrowMQ.addEventListener("change", syncCompactToolbar);
else if (narrowMQ.addListener) narrowMQ.addListener(syncCompactToolbar); // Safari < 14

window.addEventListener("popstate", applyHash);

syncCompactToolbar();
setMode("files");
initTree();
applyHash();
refreshUsage();
</script>
</body>
</html>`;
