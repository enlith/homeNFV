import { handleDownload } from "./files";

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
  AGENT_URL: string;
  AGENT_SHARED_SECRET: string;
  JWT_SECRET: string;
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
};

export async function handleCreateShare(path: string, username: string, env: Env): Promise<Response> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const expires = Math.floor(Date.now() / 1000) + 7 * 86400;
  await env.DB.prepare("INSERT INTO shares (id, path, created_by, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, path, username, expires)
    .run();
  return json({ id, url: `/s/${id}`, expires_at: expires }, 201);
}

export async function handleShareDownload(id: string, request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  const row = await env.DB.prepare("SELECT path, expires_at FROM shares WHERE id = ?").bind(id).first<{ path: string; expires_at: number | null }>();
  if (!row) return json({ error: "Share not found" }, 404);
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) {
    await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(id).run();
    return json({ error: "Share expired" }, 410);
  }
  const resp = await handleDownload(row.path, env, request);
  // Add CORS headers
  const newResp = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(CORS)) newResp.headers.set(k, v);
  return newResp;
}
