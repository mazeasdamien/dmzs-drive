// Just enough of the Workers runtime to run the Worker in Node: an in-memory
// R2 bucket (pages of 1000, ranges, conditional gets), the Cache API and
// FixedLengthStream. Plus helpers to sign in the way a browser would.
import { createHmac } from "node:crypto";

export const PASS = "test-pass";
export const TOTP_SECRET = "JBSWY3DPEHPK3PXP"; // a throwaway test seed

const cacheStore = new Map();
const cacheKey = (k) => (typeof k === "string" ? k : k.url);
globalThis.caches = {
  default: {
    async match(k) {
      const v = cacheStore.get(cacheKey(k));
      return v ? new Response(v.body, { status: v.status, headers: v.headers }) : undefined;
    },
    async put(k, res) {
      cacheStore.set(cacheKey(k), { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] });
    },
  },
};
// The real one checks the byte count; here it only has to pass bytes through.
globalThis.FixedLengthStream = class extends TransformStream {
  constructor() { super(); }
};

function r2Object(key, o, bytes) {
  const etag = "e" + o.version;
  const obj = {
    key, size: o.bytes.length, uploaded: o.uploaded, etag, httpEtag: '"' + etag + '"',
    httpMetadata: { contentType: o.type }, customMetadata: o.meta || {},
    writeHttpMetadata(h) { if (o.type) h.set("content-type", o.type); },
  };
  // Like R2: only an object fetched with its contents has a body at all.
  if (bytes) {
    obj.body = new Blob([bytes]).stream();
    obj.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    obj.json = async () => JSON.parse(new TextDecoder().decode(bytes));
  }
  return obj;
}

export function fakeBucket() {
  const store = new Map();
  let version = 0;
  const bucket = {
    store,
    listCalls: 0,
    seed(key, text, type = "text/plain") {
      store.set(key, { bytes: new TextEncoder().encode(text), type, uploaded: new Date(), version: ++version });
    },
    async head(k) { const o = store.get(k); return o ? r2Object(k, o) : null; },
    async get(k, opts = {}) {
      const o = store.get(k);
      if (!o) return null;
      if (opts.onlyIf instanceof Headers && opts.onlyIf.get("if-none-match") === '"e' + o.version + '"') return r2Object(k, o);
      let range;
      if (opts.range instanceof Headers) {
        const m = /bytes=(\d*)-(\d*)/.exec(opts.range.get("range") || "");
        if (m) {
          const n = o.bytes.length;
          const start = m[1] === "" ? n - +m[2] : +m[1];
          const end = m[1] === "" || m[2] === "" ? n - 1 : Math.min(+m[2], n - 1);
          range = { offset: start, length: end - start + 1 };
        }
      } else if (opts.range) range = opts.range;
      const bytes = range ? o.bytes.slice(range.offset, range.offset + range.length) : o.bytes;
      const obj = r2Object(k, o, bytes);
      if (range) obj.range = range;
      return obj;
    },
    async put(k, body, opts = {}) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      store.set(k, {
        bytes, type: opts.httpMetadata && opts.httpMetadata.contentType, meta: opts.customMetadata,
        uploaded: new Date(), version: ++version,
      });
    },
    async delete(k) { for (const x of [].concat(k)) store.delete(x); },
    async list({ prefix = "", delimiter, cursor } = {}) {
      bucket.listCalls++;
      const entries = [];
      const seen = new Set();
      for (const k of [...store.keys()].sort()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (delimiter && rest.includes("/")) {
          const dp = prefix + rest.slice(0, rest.indexOf("/") + 1);
          if (!seen.has(dp)) { seen.add(dp); entries.push({ dp }); }
          continue;
        }
        entries.push({ o: r2Object(k, store.get(k)) });
      }
      const from = cursor ? +cursor : 0;
      const page = entries.slice(from, from + 1000);
      const truncated = from + 1000 < entries.length;
      return {
        objects: page.filter((e) => e.o).map((e) => e.o),
        delimitedPrefixes: page.filter((e) => e.dp).map((e) => e.dp),
        truncated,
        cursor: truncated ? String(from + 1000) : undefined,
      };
    },
  };
  return bucket;
}

// Each test gets a fresh bucket, so it gets a fresh cache too.
export function makeEnv() {
  cacheStore.clear();
  return {
    DRIVE_BUCKET: fakeBucket(),
    AUTH_PASS: PASS,
    TOTP_SECRET,
    DOCS_SEARCH: {},
    ANTHROPIC_API_KEY: "test",
  };
}

function base32(s) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s) bits += a.indexOf(c).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}

export function totp(stepOffset = 0) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(Date.now() / 30000) + stepOffset, 4);
  const h = createHmac("sha1", base32(TOTP_SECRET)).update(buf).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

// A request as the drive's own page would send it.
export function req(path, opts = {}) {
  const headers = new Headers(opts.headers || {});
  if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  return new Request("https://drive.test" + path, { ...opts, headers });
}

export async function signIn(worker, env, code = totp()) {
  const res = await worker.fetch(req("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASS, code }),
  }), env, { waitUntil() {} });
  const set = res.headers.get("set-cookie") || "";
  return { res, cookie: set.split(";")[0] };
}
