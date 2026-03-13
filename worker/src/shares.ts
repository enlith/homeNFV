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

export async function handleCreateShare(path: string, username: string, env: Env): Promise<Response> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const expires = Math.floor(Date.now() / 1000) + 7 * 86400; // 7 days
  await env.DB.prepare("INSERT INTO shares (id, path, created_by, expires_at) VALUES (?, ?, ?, ?)")
    .bind(id, path, username, expires)
    .run();
  return json({ id, url: `/s/${id}`, expires_at: expires }, 201);
}

export async function handleShareDownload(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT path, expires_at FROM shares WHERE id = ?").bind(id).first<{ path: string; expires_at: number | null }>();
  if (!row) return json({ error: "Share not found" }, 404);
  if (row.expires_at && row.expires_at < Math.floor(Date.now() / 1000)) {
    await env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(id).run();
    return json({ error: "Share expired" }, 410);
  }
  return handleDownload(row.path, env);
}
