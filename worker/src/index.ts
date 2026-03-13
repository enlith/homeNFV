import { handleRegister, handleLogin, handleLogout } from "./auth";
import { handleListUsers, handleApproveUser, handleRejectUser } from "./admin";
import { handleBrowse, handleDownload, handleUpload, handleDelete, handleMkdir } from "./files";
import { handlePendingList, handlePendingDownload, handlePendingAck, handleMetadataPush, handleMetadataDelete } from "./sync";
import { authenticate, requireAuth, requireAdmin } from "./middleware";

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
  AGENT_URL: string;
  AGENT_SHARED_SECRET: string;
  JWT_SECRET: string;
}

// Verify agent-to-worker HMAC auth
async function verifyAgentAuth(req: Request, env: Env): Promise<boolean> {
  const ts = req.headers.get("X-HomeNFV-Timestamp");
  const sig = req.headers.get("X-HomeNFV-Signature");
  if (!ts || !sig) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts)) > 30) return false;

  const url = new URL(req.url);
  const message = `${req.method}:${url.pathname}:${ts}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AGENT_SHARED_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expectedHex = [...new Uint8Array(expected)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === expectedHex;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Health check
    if (pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Agent sync routes (HMAC auth)
    if (pathname.startsWith("/api/sync/")) {
      if (!(await verifyAgentAuth(request, env))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      if (pathname === "/api/sync/pending" && method === "GET") return handlePendingList(env);
      if (pathname === "/api/sync/pending/download" && method === "GET") {
        const p = url.searchParams.get("path");
        if (!p) return new Response(JSON.stringify({ error: "path required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        return handlePendingDownload(p, env);
      }
      if (pathname === "/api/sync/pending/ack" && method === "POST") {
        const p = url.searchParams.get("path");
        if (!p) return new Response(JSON.stringify({ error: "path required" }), { status: 400, headers: { "Content-Type": "application/json" } });
        return handlePendingAck(p, env);
      }
      if (pathname === "/api/sync/metadata" && method === "POST") return handleMetadataPush(request, env);
      if (pathname === "/api/sync/metadata" && method === "DELETE") return handleMetadataDelete(request, env);
    }

    // Auth routes (no auth required)
    if (pathname === "/api/auth/register" && method === "POST") return handleRegister(request, env);
    if (pathname === "/api/auth/login" && method === "POST") return handleLogin(request, env);
    if (pathname === "/api/auth/logout" && method === "POST") return handleLogout();

    // All routes below require user auth
    const ctx = await authenticate(request, env);

    if (pathname === "/api/auth/me" && method === "GET") {
      const err = requireAuth(ctx);
      if (err) return err;
      return new Response(JSON.stringify({ userId: ctx!.userId, username: ctx!.username, role: ctx!.role }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Admin routes
    if (pathname === "/api/admin/users" && method === "GET") {
      const err = requireAdmin(ctx);
      if (err) return err;
      return handleListUsers(env);
    }
    const approveMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/approve$/);
    if (approveMatch && method === "POST") {
      const err = requireAdmin(ctx);
      if (err) return err;
      return handleApproveUser(approveMatch[1], env);
    }
    const rejectMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/reject$/);
    if (rejectMatch && method === "POST") {
      const err = requireAdmin(ctx);
      if (err) return err;
      return handleRejectUser(rejectMatch[1], env);
    }

    // File routes (auth required)
    if (pathname.startsWith("/api/files")) {
      const err = requireAuth(ctx);
      if (err) return err;
      const filePath = url.searchParams.get("path") || "/";
      if (method === "GET" && url.searchParams.get("download") === "true") return handleDownload(filePath, env);
      if (method === "GET") return handleBrowse(filePath, env);
      if (method === "PUT") return handleUpload(filePath, request, env);
      if (method === "DELETE") return handleDelete(filePath, env);
    }

    if (pathname === "/api/mkdir" && method === "POST") {
      const err = requireAuth(ctx);
      if (err) return err;
      const filePath = url.searchParams.get("path");
      if (!filePath) return new Response(JSON.stringify({ error: "path required" }), { status: 400, headers: { "Content-Type": "application/json" } });
      return handleMkdir(filePath, env);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
