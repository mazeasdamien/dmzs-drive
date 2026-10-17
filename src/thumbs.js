// Thumbnails: photos through the Images binding, video frames through Media.

import { FILE_CSP, isReserved } from "./shared.js";

// ---------- Thumbnails ----------

// The grid used to point its tiles at the original photos and let CSS shrink
// them, so browsing a folder of 3 MB JPEGs meant decoding hundreds of megabytes.
// This resizes the R2 bytes through the Images binding instead. Nothing extra
// is stored anywhere: the small copy only ever lives in Cloudflare's cache,
// keyed by the object's etag so replacing a file shows the new picture.
// Transforms are billed once per unique image per month (5 000/month free).
// Videos go through the Media binding instead, which grabs a still frame; it
// reads the R2 body directly, so nothing about the bucket has to be public.
export const THUMB_WIDTH = 400;
// A second in, because the first frame of a phone video is often black or
// still focusing.
export const FRAME_TIME = "1s";
export const VIDEO_EXTS = ["mp4", "webm", "mov", "m4v"];

export function isVideoKey(key) {
  return VIDEO_EXTS.indexOf(key.split(".").pop().toLowerCase()) !== -1;
}

export async function handleThumb(request, url, env, ctx) {
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
      console.warn("thumbnail transform failed", key, String(err));
      response = null;
    }
  }

  if (!response) {
    // For a photo, handing back the original is a fine (if heavy) thumbnail.
    // For a video it would be megabytes of MP4 in an <img>, so say so instead
    // and let the grid keep its icon.
    if (video) return new Response("No frame", { status: 415 });
    // Only a real raster image goes back as itself. An HTML or SVG file always
    // fails the transform, and returned here with its stored type it would
    // run script on the drive's origin: /api/object downgrades those, this
    // route must not be the way round that.
    const type = ((head.httpMetadata || {}).contentType || "").toLowerCase();
    if (!type.startsWith("image/") || type.includes("svg")) {
      return new Response("No thumbnail", { status: 415 });
    }
    const original = await env.DRIVE_BUCKET.get(key);
    if (!original) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    original.writeHttpMetadata(headers);
    headers.set("content-type", type);
    headers.set("content-security-policy", FILE_CSP);
    headers.set("cache-control", "private, max-age=3600");
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
export async function videoFrame(env, key) {
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
      console.warn("video frame failed", key, String(err));
      // try the start, then fall through
    }
  }
  return null;
}
