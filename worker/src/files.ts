import { signRequest } from "./agent-auth";
import { checkUploadAllowed, incrementUploadCount, LIMITS } from "./quota";

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
  AGENT_URL: string;
  AGENT_SHARED_SECRET: string;
}

// Proxy a request to the home agent with HMAC auth
async function agentFetch(env: Env, method: string, agentPath: string, body?: ReadableStream | null, extraHeaders?: Record<string, string>): Promise<Response | null> {
  const { timestamp, signature } = await signRequest(method, agentPath, env.AGENT_SHARED_SECRET);
  try {
    const resp = await fetch(`${env.AGENT_URL}${agentPath}`, {
      method,
      headers: {
        "X-HomeNFV-Timestamp": timestamp,
        "X-HomeNFV-Signature": signature,
        ...extraHeaders,
      },
      body,
    });
    return resp;
  } catch {
    return null; // Agent unreachable
  }
}

// Browse directory
export async function handleBrowse(filePath: string, env: Env): Promise<Response> {
  // Try agent first
  const agentResp = await agentFetch(env, "GET", `/api/files?path=${encodeURIComponent(filePath)}`);
  if (agentResp?.ok) {
    // Update D1 metadata from agent response
    const data = await agentResp.json() as { files: Array<{ name: string; is_dir: boolean; size: number; modified: number }> };
    await syncDirMetadata(env, filePath, data.files);
    return json(data);
  }

  // Fallback: serve from D1 metadata
  const rows = await env.DB.prepare("SELECT name, is_dir, size, modified FROM files WHERE parent = ?").bind(filePath).all();
  return json({
    path: filePath,
    files: rows.results.map((r: any) => ({ name: r.name, is_dir: !!r.is_dir, size: r.size, modified: r.modified })),
    offline: true,
  });
}

// Download file
export async function handleDownload(filePath: string, env: Env, request?: Request): Promise<Response> {
  const r2Key = `cache/${filePath}`;
  const rangeHeader = request?.headers.get("Range") || undefined;
  const fileName = filePath.split("/").pop() || "download";
  const disposition = `attachment; filename="${fileName}"`;

  // Check R2 cache first
  const r2Opts: R2GetOptions = rangeHeader ? { range: { suffix: 0 } } : {};
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) r2Opts.range = { offset: parseInt(m[1]), length: m[2] ? parseInt(m[2]) - parseInt(m[1]) + 1 : undefined };
  }
  const cached = await env.R2.get(r2Key, r2Opts);
  if (cached) {
    const headers: Record<string, string> = { "Content-Type": cached.httpMetadata?.contentType || "application/octet-stream", "Accept-Ranges": "bytes", "Content-Disposition": disposition };
    const status = rangeHeader && "range" in cached ? 206 : 200;
    return new Response(cached.body, { status, headers });
  }

  // Try agent — forward Range header
  const extra: Record<string, string> = {};
  if (rangeHeader) extra["Range"] = rangeHeader;
  const agentResp = await agentFetch(env, "GET", `/api/files?path=${encodeURIComponent(filePath)}`, null, extra);
  if (agentResp && (agentResp.ok || agentResp.status === 206)) {
    const contentType = agentResp.headers.get("Content-Type") || "application/octet-stream";
    const respHeaders: Record<string, string> = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Content-Disposition": disposition };
    const cr = agentResp.headers.get("Content-Range");
    if (cr) respHeaders["Content-Range"] = cr;
    const cl = agentResp.headers.get("Content-Length");
    if (cl) respHeaders["Content-Length"] = cl;

    // Cache full responses in R2
    if (!rangeHeader) {
      const size = parseInt(agentResp.headers.get("X-File-Size") || "0");
      if (size > 0 && size <= LIMITS.MAX_FILE_SIZE) {
        const [stream1, stream2] = agentResp.body!.tee();
        env.R2.put(r2Key, stream2, { httpMetadata: { contentType } }).catch(() => {});
        await updateFileMetadata(env, filePath, { cached_in_r2: 1 });
        return new Response(stream1, { status: agentResp.status, headers: respHeaders });
      }
    }

    return new Response(agentResp.body, { status: agentResp.status, headers: respHeaders });
  }

  // Check R2 temp storage
  const temp = await env.R2.get(`temp/${filePath}`, r2Opts);
  if (temp) {
    const headers: Record<string, string> = { "Content-Type": temp.httpMetadata?.contentType || "application/octet-stream", "Accept-Ranges": "bytes", "Content-Disposition": disposition };
    const status = rangeHeader && "range" in temp ? 206 : 200;
    return new Response(temp.body, { status, headers });
  }

  return json({ error: "File unavailable — home server offline and not cached" }, 503);
}

// Upload file
export async function handleUpload(filePath: string, request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("Content-Type") || "application/octet-stream";

  // Clone body so we can read size if Content-Length is missing
  const body = await request.arrayBuffer();
  const fileSize = body.byteLength;

  // Check quota
  const quota = await checkUploadAllowed(fileSize, env);
  if (!quota.allowed) return json({ error: quota.reason }, 403);

  // Try agent first
  const agentResp = await agentFetch(env, "PUT", `/api/files?path=${encodeURIComponent(filePath)}`, new Blob([body]).stream());
  if (agentResp?.ok) {
    await incrementUploadCount(env);
    await updateFileMetadata(env, filePath, { size: fileSize, pending_sync: 0 });
    return json({ status: "uploaded" }, 201);
  }

  // Agent offline — store in R2 temp if within size limit
  if (fileSize > LIMITS.MAX_FILE_SIZE) {
    return json({ error: `Home offline. File too large for temp storage (max ${LIMITS.MAX_FILE_SIZE / 1024 / 1024}MB)` }, 413);
  }

  await env.R2.put(`temp/${filePath}`, body, { httpMetadata: { contentType } });
  await incrementUploadCount(env);
  await updateFileMetadata(env, filePath, { size: fileSize, pending_sync: 1 });

  return json({ status: "queued", message: "Home offline — file queued for sync" }, 202);
}

// Delete file
export async function handleDelete(filePath: string, env: Env): Promise<Response> {
  const agentResp = await agentFetch(env, "DELETE", `/api/files?path=${encodeURIComponent(filePath)}`);
  if (!agentResp?.ok) {
    return json({ error: "Cannot delete — home server offline" }, 503);
  }

  // Clean up R2 and D1
  await env.R2.delete(`cache/${filePath}`);
  await env.R2.delete(`temp/${filePath}`);
  await env.DB.prepare("DELETE FROM files WHERE path = ?").bind(filePath).run();

  return json({ status: "deleted" });
}

// Create directory
export async function handleMkdir(filePath: string, env: Env): Promise<Response> {
  // Try agent, but don't fail if offline — just create in D1
  await agentFetch(env, "POST", `/api/mkdir?path=${encodeURIComponent(filePath)}`);

  const parent = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
  const name = filePath.substring(filePath.lastIndexOf("/") + 1);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO files (path, parent, name, is_dir, size, modified) VALUES (?, ?, ?, 1, 0, ?)"
  ).bind(filePath, parent, name, Math.floor(Date.now() / 1000)).run();

  return json({ status: "created" }, 201);
}

// Upload file from URL
export async function handleUploadFromURL(filePath: string, sourceURL: string, env: Env): Promise<Response> {
  // Try agent first — agent fetches URL directly to disk (no memory limit)
  const agentResp = await agentFetch(env, "POST", "/api/fetch-url",
    new Blob([JSON.stringify({ url: sourceURL, path: filePath })]).stream());
  if (agentResp && (agentResp.ok || agentResp.status === 202)) {
    await incrementUploadCount(env);
    await updateFileMetadata(env, filePath, { size: 0, pending_sync: 0 });
    return json({ status: "downloading", message: "Agent is downloading the file" }, 202);
  }

  // Agent offline — Worker fetches URL and stores in R2 temp (≤25MB)
  let resp: globalThis.Response;
  try {
    resp = await fetch(sourceURL, { redirect: "follow" });
  } catch {
    return json({ error: "Failed to fetch URL" }, 400);
  }
  if (!resp.ok) return json({ error: `URL returned ${resp.status}` }, 400);

  const body = await resp.arrayBuffer();
  const fileSize = body.byteLength;
  const contentType = resp.headers.get("Content-Type") || "application/octet-stream";

  const quota = await checkUploadAllowed(fileSize, env);
  if (!quota.allowed) return json({ error: quota.reason }, 403);

  if (fileSize > LIMITS.MAX_FILE_SIZE) {
    return json({ error: `Home offline. File too large for temp storage (max ${LIMITS.MAX_FILE_SIZE / 1024 / 1024}MB)` }, 413);
  }

  await env.R2.put(`temp/${filePath}`, body, { httpMetadata: { contentType } });
  await incrementUploadCount(env);
  await updateFileMetadata(env, filePath, { size: fileSize, pending_sync: 1 });

  return json({ status: "queued", message: "Home offline — file queued for sync", size: fileSize }, 202);
}

// Sync directory listing from agent into D1
async function syncDirMetadata(env: Env, dirPath: string, files: Array<{ name: string; is_dir: boolean; size: number; modified: number }>) {
  const stmts = files.map((f) => {
    const path = dirPath === "/" ? `/${f.name}` : `${dirPath}/${f.name}`;
    return env.DB.prepare(
      "INSERT OR REPLACE INTO files (path, parent, name, is_dir, size, modified) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(path, dirPath, f.name, f.is_dir ? 1 : 0, f.size, f.modified);
  });
  if (stmts.length > 0) await env.DB.batch(stmts);
}

async function updateFileMetadata(env: Env, filePath: string, updates: Record<string, unknown>) {
  const parent = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
  const name = filePath.substring(filePath.lastIndexOf("/") + 1);
  const cols = Object.keys(updates);
  const sets = cols.map((c) => `${c} = ?`).join(", ");
  await env.DB.prepare(
    `INSERT INTO files (path, parent, name, ${cols.join(", ")}) VALUES (?, ?, ?, ${cols.map(() => "?").join(", ")})
     ON CONFLICT(path) DO UPDATE SET ${sets}`
  ).bind(filePath, parent, name, ...cols.map((c) => updates[c]), ...cols.map((c) => updates[c])).run();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
