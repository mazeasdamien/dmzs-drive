// "Ask your documents": AI Search for passages, Claude for the answer.

import Anthropic from "@anthropic-ai/sdk";
import { CONFIG } from "./shared.js";

// ---------- Ask your documents ----------
//
// Answers questions from the documents in Ressources/. An AI Search instance
// (the DOCS_SEARCH binding in wrangler.jsonc) indexes those files straight
// from the bucket and re-syncs on its own; this route asks it for the
// passages closest to the question, hands them to Claude as search results,
// and streams the answer back along with the passages Claude cited.
//
// The reply is NDJSON, one event per line:
//   {"t":"status","v":"searching"|"writing"}
//   {"t":"consulted","docs":[{key,title}]}      every document retrieval returned
//   {"t":"text","i":n,"v":"..."}                answer text for content block n
//   {"t":"cite","i":n,"key","title","text"}     a passage block n draws on
//   {"t":"error","v":"..."}
//   {"t":"usage","input","output","cost","month":{...}}   what this answer cost
//   {"t":"done"}
// Citations are keyed by block rather than by position in the text because
// the API may deliver a block's citation before or after its text.

export const CHAT_MODEL = "claude-sonnet-5-5";
export const CHAT_MAX_MESSAGES = 10;
export const CHAT_SYSTEM = `You answer questions about the user's own documents, stored in the Ressources folder of their personal drive: reports, presentations, proposals, letters, CVs and the like. With each question you get the passages that a search over those documents returned, as search results. Earlier turns of the conversation are included for context, without their passages.

Base the answer on those passages and cite them. When they don't contain the answer, say so plainly and mention what the closest documents do cover, instead of filling the gap from general knowledge. If the user explicitly asks for something beyond their documents, you may answer it, saying that this part doesn't come from the documents.

Quote figures, dates, names and identifiers exactly as they are written. Answer in the language of the question. Keep the answer as short as the question allows. The chat renders paragraphs, **bold**, "- " bullet lists, "1." numbered lists and "###" headings; it does not render tables.`;

export async function handleChat(request, env, ctx) {
  if (!env.DOCS_SEARCH) {
    return new Response("Document search isn't set up: the DOCS_SEARCH binding is missing.", { status: 503 });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return new Response("ANTHROPIC_API_KEY isn't set: run npx wrangler secret put ANTHROPIC_API_KEY.", { status: 503 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const history = chatHistory(body && body.messages);
  if (!history) return new Response("Expected messages ending with a question", { status: 400 });

  // A ceiling on what the chat can spend in a month (CHAT_MONTHLY_BUDGET in
  // wrangler.jsonc, in dollars), so a loop or a stolen session can't run up
  // the Anthropic bill.
  const budget = parseFloat(env.CHAT_MONTHLY_BUDGET || "20");
  if ((await readChatUsage(env)).cost >= budget) {
    return new Response(
      "This month's chat budget ($" + budget.toFixed(2) + ") is used up. Raise CHAT_MONTHLY_BUDGET in wrangler.jsonc to keep going.",
      { status: 429 },
    );
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  // Once the browser has gone away a write fails; from then on there is no
  // one to stream to, so answerChat stops paying for tokens nobody will read.
  let gone = false;
  const send = (event) => {
    if (gone) return;
    writer.write(enc.encode(JSON.stringify(event) + "\n")).catch(() => { gone = true; });
  };
  const run = answerChat(env, history, send, () => gone)
    .catch((err) => {
      console.error("chat failed", err && err.stack ? err.stack : err);
      send({ t: "error", v: chatErrorMessage(err) });
    })
    .finally(() => {
      send({ t: "done" });
      return writer.close().catch(() => {});
    });
  ctx.waitUntil(run);
  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

// The browser keeps the conversation and sends it whole; only plain text
// turns are accepted, ending with the user's question.
export function chatHistory(messages) {
  if (!Array.isArray(messages)) return null;
  const turns = messages
    .slice(-CHAT_MAX_MESSAGES)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user") return null;
  return turns;
}

export async function answerChat(env, history, send, isGone) {
  send({ t: "status", v: "searching" });
  // Follow-ups ("and in 2025?") only make sense with the turns before them,
  // so the search gets the recent conversation and rewrites it into a query.
  // No reranking: the only reranker on offer (bge-reranker-base) is English,
  // and it scores French passages near zero — measured at 0.01–0.2 on the
  // right answer — so its threshold threw every result away. The hybrid
  // (vector + keyword) ranking already puts the right document first.
  const found = await env.DOCS_SEARCH.search({
    messages: history.slice(-6),
    ai_search_options: {
      retrieval: { max_num_results: 10, context_expansion: 1 },
      query_rewrite: { enabled: history.length > 1 },
    },
  });
  const chunks = (found.chunks || []).filter((c) => c.text && c.item && c.item.key);
  const consulted = [];
  for (const c of chunks) {
    if (!consulted.some((d) => d.key === c.item.key)) consulted.push({ key: c.item.key, title: fileTitle(c.item.key) });
  }
  send({ t: "consulted", docs: consulted });

  const question = history[history.length - 1].content;
  const content = chunks.map((c) => ({
    type: "search_result",
    source: c.item.key,
    title: fileTitle(c.item.key),
    content: passageBlocks(c.text),
    citations: { enabled: true },
  }));
  content.push({
    type: "text",
    text: chunks.length ? question : "(The search returned no passages for this question.)\n\n" + question,
  });

  send({ t: "status", v: "writing" });
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 64000,
    // If a safety classifier declines, the API retries on the model it
    // recommends for that case instead of returning the refusal.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system: CHAT_SYSTEM,
    messages: [...history.slice(0, -1), { role: "user", content }],
  });
  for await (const event of stream) {
    if (isGone()) {
      stream.abort();
      return;
    }
    if (event.type !== "content_block_delta") continue;
    const d = event.delta;
    if (d.type === "text_delta") {
      send({ t: "text", i: event.index, v: d.text });
    } else if (d.type === "citations_delta" && d.citation.type === "search_result_location") {
      send({ t: "cite", i: event.index, key: d.citation.source, title: d.citation.title, text: d.citation.cited_text });
    }
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") send({ t: "error", v: "Claude declined to answer this question." });
  const u = final.usage || {};
  const cost = chatCost(final.model, u);
  const month = await addChatUsage(env, u, cost);
  send({ t: "usage", input: chatInputTokens(u), output: u.output_tokens || 0, cost, month });
}

// ---------- Chat cost counter ----------
//
// What the answers cost on the Anthropic key, worked out from the token counts
// each response reports, priced per million tokens. Only Claude is counted:
// the AI Search side stays within its monthly free allowance at this volume.
// Totals are kept per calendar month (UTC) in the hidden .config/ area, so
// they follow the user from one device to the next.

export const CHAT_PRICES = {
  // $ per million tokens: input, output, cache read, cache write
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-opus-4-8": [5, 25, 0.5, 6.25],
};
export const CHAT_USAGE = CONFIG + "chat-usage/";

export function chatInputTokens(u) {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

export function chatCost(model, u) {
  // A fallback answer reports the model that served it; anything unlisted is
  // priced as the default model rather than silently counted as free.
  const p = CHAT_PRICES[model] || CHAT_PRICES[CHAT_MODEL];
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1]
    + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
}

export function chatMonthKey() {
  return CHAT_USAGE + new Date().toISOString().slice(0, 7) + ".json";
}

export async function readChatUsage(env) {
  const obj = await env.DRIVE_BUCKET.get(chatMonthKey());
  const month = new Date().toISOString().slice(0, 7);
  if (!obj) return { month, questions: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
  return { month, ...(await obj.json()) };
}

// Read-modify-write without a lock: one person asking one question at a time
// is the only writer, so a lost update would need two answers finishing in
// the same instant.
export async function addChatUsage(env, u, cost) {
  const t = await readChatUsage(env);
  t.questions += 1;
  t.input_tokens += chatInputTokens(u);
  t.output_tokens += u.output_tokens || 0;
  t.cost += cost;
  await env.DRIVE_BUCKET.put(chatMonthKey(), JSON.stringify(t), {
    httpMetadata: { contentType: "application/json" },
  });
  return t;
}

export async function handleChatUsage(env) {
  return Response.json(await readChatUsage(env));
}

// Smaller blocks give Claude finer citation boundaries: it cites whole blocks,
// so one block per chunk would make every citation the entire chunk.
export function passageBlocks(text) {
  const blocks = [];
  let cur = "";
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    cur = cur ? cur + "\n\n" + p : p;
    if (cur.length >= 400) {
      blocks.push({ type: "text", text: cur });
      cur = "";
    }
  }
  if (cur) blocks.push({ type: "text", text: cur });
  return blocks.length ? blocks : [{ type: "text", text }];
}

export function fileTitle(key) {
  return key.split("/").pop();
}

export function chatErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key was rejected: check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Too many requests to Claude right now; try again in a moment.";
  if (err instanceof Anthropic.APIError) return "Claude API error" + (err.status ? " " + err.status : "") + ": " + err.message;
  return "Error: " + (err && err.message ? err.message : String(err));
}
