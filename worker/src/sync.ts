// Worker-side sync endpoints called by the home agent

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
  AGENT_SHARED_SECRET: string;
}

// Returns list of files pending sync (uploaded to R2 temp while agent was offline)
export async function handlePendingList(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT path, size FROM files WHERE pending_sync = 1 LIMIT 50"
  ).all();
  return json({ files: rows.results });
}

// Agent calls this to download a pending file from R2 temp
export async function handlePendingDownload(filePath: string, env: Env): Promise<Response> {
  const obj = await env.R2.get(`temp/${filePath}`);
  if (!obj) return json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream" },
  });
}

// Agent calls this after successfully saving a pending file to local disk
export async function handlePendingAck(filePath: string, env: Env): Promise<Response> {
  await env.R2.delete(`temp/${filePath}`);
  await env.DB.prepare("UPDATE files SET pending_sync = 0 WHERE path = ?").bind(filePath).run();
  return json({ status: "ok" });
}

// Agent pushes directory metadata after inotify detects changes
export async function handleMetadataPush(request: Request, env: Env): Promise<Response> {
  const { entries } = await request.json<{
    entries: Array<{ path: string; parent: string; name: string; is_dir: boolean; size: number; modified: number }>;
  }>();

  if (!entries?.length) return json({ status: "ok", synced: 0 });

  const stmts = entries.map((e) =>
    env.DB.prepare(
      "INSERT OR REPLACE INTO files (path, parent, name, is_dir, size, modified) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(e.path, e.parent, e.name, e.is_dir ? 1 : 0, e.size, e.modified)
  );
  await env.DB.batch(stmts);

  return json({ status: "ok", synced: entries.length });
}

// Agent reports deleted paths
export async function handleMetadataDelete(request: Request, env: Env): Promise<Response> {
  const { paths } = await request.json<{ paths: string[] }>();
  if (!paths?.length) return json({ status: "ok" });

  const stmts = paths.map((p) => env.DB.prepare("DELETE FROM files WHERE path = ?").bind(p));
  await env.DB.batch(stmts);

  // Also clean R2 cache for deleted files
  for (const p of paths) {
    await env.R2.delete(`cache/${p}`);
  }

  return json({ status: "ok", deleted: paths.length });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
