// MCP server: lets an outside LLM (Claude Desktop, Claude Code, ...) search
// the documents in Ressources/ through the same AI Search index as
// "Ask your documents". No Claude call happens here, so it costs nothing on
// the chat budget: the client's own model reads the passages.
//
// Streamable HTTP transport, stateless: every POST /mcp carries one JSON-RPC
// message and gets a plain JSON reply. Auth is a bearer token (the MCP_TOKEN
// secret), separate from the browser session so a client never needs the
// password or a TOTP code.

import { safeEqual } from "./auth.js";
import { fileTitle } from "./chat.js";

export const MCP_PROTOCOL = "2025-06-18";
export const DOCS_PREFIX = "Ressources/";

const TOOLS = [
  {
    name: "search_documents",
    description: "Search the PDFs and Word files in the Ressources folder of Damien's drive (reports, presentations, proposals, letters, CVs). Returns the most relevant passages, each with the file it comes from. Hybrid search: works with keywords or a natural-language question, in French or English.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        max_results: { type: "integer", minimum: 1, maximum: 20, description: "Passages to return (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_documents",
    description: "List the files in the Ressources folder (or one of its subfolders), with size and date.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Subfolder of Ressources/, e.g. \"Orange docs\". Empty for all." },
      },
    },
  },
];

export async function handleMcp(request, env) {
  if (!env.MCP_TOKEN) {
    return new Response("MCP isn't set up: run npx wrangler secret put MCP_TOKEN.", { status: 503 });
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !(await safeEqual(token, env.MCP_TOKEN))) {
    return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  // Stateless: no server-initiated stream to open, no session to end.
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }

  let msg;
  try {
    msg = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "Invalid request");
  }
  // Notifications (no id) get no reply.
  if (msg.id === undefined) return new Response(null, { status: 202 });

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        protocolVersion: MCP_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "dmzs-drive", version: "1.0.0" },
        instructions: "Search Damien's documents (Ressources folder of the drive). Cite the file name of each passage you rely on.",
      });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params || {};
      try {
        if (name === "search_documents") return rpcResult(msg.id, await searchDocuments(env, args));
        if (name === "list_documents") return rpcResult(msg.id, await listDocuments(env, args));
        return rpcError(msg.id, -32602, "Unknown tool: " + name);
      } catch (err) {
        console.error("mcp", name, err && err.stack ? err.stack : err);
        return rpcResult(msg.id, toolText("Error: " + (err && err.message ? err.message : String(err)), true));
      }
    }
    default:
      return rpcError(msg.id, -32601, "Method not found: " + msg.method);
  }
}

async function searchDocuments(env, args) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return toolText("query is required.", true);
  if (!env.DOCS_SEARCH) return toolText("Document search isn't set up: the DOCS_SEARCH binding is missing.", true);
  const max = Math.min(Math.max(parseInt(args.max_results, 10) || 10, 1), 20);
  // Same settings as the chat, minus the query rewrite: the calling model
  // already turns the conversation into a self-contained query.
  const found = await env.DOCS_SEARCH.search({
    messages: [{ role: "user", content: query.slice(0, 2000) }],
    ai_search_options: { retrieval: { max_num_results: max, context_expansion: 1 } },
  });
  const chunks = (found.chunks || []).filter((c) => c.text && c.item && c.item.key);
  if (!chunks.length) return toolText("No passages matched this query.");
  const text = chunks
    .map((c, i) => `[${i + 1}] ${fileTitle(c.item.key)}\nPath: ${c.item.key}\n\n${c.text.trim()}`)
    .join("\n\n---\n\n");
  return toolText(text);
}

async function listDocuments(env, args) {
  const folder = typeof args.folder === "string" ? args.folder.replace(/^\/+|\/+$/g, "") : "";
  if (folder.split("/").includes("..")) return toolText("Invalid folder.", true);
  const prefix = DOCS_PREFIX + (folder ? folder + "/" : "");
  const lines = [];
  let cursor;
  do {
    const page = await env.DRIVE_BUCKET.list({ prefix, cursor });
    for (const o of page.objects) {
      if (o.key.endsWith("/")) continue;
      lines.push(`${o.key}\t${o.size} bytes\t${new Date(o.uploaded).toISOString().slice(0, 10)}`);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return toolText(lines.length ? lines.join("\n") : "No files in " + prefix);
}

function toolText(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function rpcResult(id, result) {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
}

function rpcError(id, code, message) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
