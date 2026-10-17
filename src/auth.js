// Sign-in (password + TOTP), sessions, signed links and share records.

import { SESSIONS, SESSION_COOKIE, SESSION_DAYS, SHARES, TOTP_LAST } from "./shared.js";

// ---------- Auth ----------

export async function handleLogin(request, env) {
  // Checked before the credentials are, so whoever is guessing gets a handful
  // of tries a minute per IP however fast they can send them — the 800 ms
  // delay below only slows one request down, not a thousand in parallel. The
  // binding is absent in local dev, where that delay is the only brake.
  if (env.LOGIN_LIMIT) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.LOGIN_LIMIT.limit({ key: "login:" + ip });
    if (!success) return new Response("Too many attempts", { status: 429 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {}

  const passOk = !!env.AUTH_PASS && (await safeEqual(body.password || "", env.AUTH_PASS));
  const step = env.TOTP_SECRET ? await verifyTotp(env.TOTP_SECRET, body.code || "") : -1;
  // A code is good for one sign-in: without this, the same six digits worked
  // again for the rest of their ~90 s window.
  let fresh = false;
  if (passOk && step >= 0) {
    const last = await env.DRIVE_BUCKET.head(TOTP_LAST);
    fresh = step > parseInt(((last && last.customMetadata) || {}).step || "-1", 10);
    if (fresh) await env.DRIVE_BUCKET.put(TOTP_LAST, new Uint8Array(), { customMetadata: { step: String(step) } });
  }
  if (!passOk || !fresh) {
    await new Promise((r) => setTimeout(r, 800)); // slow down brute-force attempts
    return new Response("Invalid credentials", { status: 401 });
  }

  // Each sign-in gets a record, so logging out really ends the session
  // instead of only forgetting the cookie in this one browser.
  const maxAge = SESSION_DAYS * 86400;
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  const id = crypto.randomUUID();
  await env.DRIVE_BUCKET.put(SESSIONS + id, new Uint8Array(), {
    customMetadata: { exp: String(exp), agent: (request.headers.get("user-agent") || "").slice(0, 200) },
  });
  const token = id + "." + exp + "." + (await hmacHex(sessionKey(env), "session|" + id + "|" + exp));
  return new Response("OK", {
    headers: {
      "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    },
  });
}

export async function handleLogout(request, env) {
  const s = await parseSession(request, env);
  if (s) {
    await env.DRIVE_BUCKET.delete(SESSIONS + s.id);
    knownSessions.delete(s.id);
  }
  return new Response("OK", {
    headers: { "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
  });
}

// Changing either secret invalidates every outstanding session and link.
export function sessionKey(env) {
  return env.AUTH_PASS + "|" + env.TOTP_SECRET;
}

// The cookie is "<id>.<expiry>.<hmac>": the signature proves it was issued
// here, the record under .config/sessions/ that it hasn't been logged out.
export async function parseSession(request, env) {
  if (!env.AUTH_PASS || !env.TOTP_SECRET) return null;
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)__Host-session=([^;]+)/);
  if (!m) return null;
  const [id, expStr, sig] = m[1].split(".");
  const exp = parseInt(expStr, 10);
  if (!/^[0-9a-f-]{36}$/.test(id || "") || !exp || Math.floor(Date.now() / 1000) > exp) return null;
  const expected = await hmacHex(sessionKey(env), "session|" + id + "|" + expStr);
  return (await safeEqual(sig || "", expected)) ? { id, exp } : null;
}

// Record lookups are remembered for a minute per isolate, so a folder of
// thumbnails doesn't cost one R2 read each; a logout elsewhere takes effect
// within that minute.
export const knownSessions = new Map();
export async function isAuthed(request, env) {
  const s = await parseSession(request, env);
  if (!s) return false;
  const seen = knownSessions.get(s.id);
  if (seen && Date.now() - seen < 60000) return true;
  if (!(await env.DRIVE_BUCKET.head(SESSIONS + s.id))) return false;
  knownSessions.set(s.id, Date.now());
  return true;
}

export async function hmacHex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time-ish comparison: compare fixed-length digests instead of the
// raw variable-length strings.
export async function safeEqual(a, b) {
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

export const SIGNED_URL_TTL_SECONDS = 300;

export async function handleSign(url, env) {
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });
  // 5 min for previews; only share links, which are recorded and can be
  // revoked, may ask for up to 7 days.
  const requested = parseInt(url.searchParams.get("ttl") || "", 10);
  const longest = url.searchParams.get("share") === "1" ? 7 * 86400 : SIGNED_URL_TTL_SECONDS;
  const ttl = Math.min(Math.max(requested || SIGNED_URL_TTL_SECONDS, 60), longest);
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

export async function verifySignedUrl(url, env) {
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

export async function handleSharesList(env) {
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

export async function handleShareRevoke(url, env) {
  const id = url.searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Bad id", { status: 400 });
  await env.DRIVE_BUCKET.delete(SHARES + id);
  return new Response("OK");
}

export async function handleShareRevokeAll(env) {
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

// Returns the time step the code belongs to, or -1 if it matches none.
export async function verifyTotp(secretB32, code) {
  if (!/^\d{6}$/.test(code)) return -1;
  const key = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) { // allow one step of clock drift either way
    if ((await hotp(key, step + w)) === code) return step + w;
  }
  return -1;
}

export async function hotp(keyBytes, counter) {
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

export function base32Decode(s) {
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
