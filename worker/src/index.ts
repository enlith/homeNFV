import { handleRegister, handleLogin, handleLogout } from "./auth";
import { handleListUsers, handleApproveUser, handleRejectUser } from "./admin";
import { authenticate, requireAuth, requireAdmin } from "./middleware";

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
  AGENT_URL: string;
  AGENT_SHARED_SECRET: string;
  JWT_SECRET: string;
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

    // Auth routes (no auth required)
    if (pathname === "/api/auth/register" && method === "POST") return handleRegister(request, env);
    if (pathname === "/api/auth/login" && method === "POST") return handleLogin(request, env);
    if (pathname === "/api/auth/logout" && method === "POST") return handleLogout();

    // All routes below require auth
    const ctx = await authenticate(request, env);

    // Auth status
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

    // TODO: file routes (next step)

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
