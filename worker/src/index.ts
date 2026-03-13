import { handleRegister, handleLogin, handleLogout } from "./auth";
import { handleListUsers, handleApproveUser, handleRejectUser } from "./admin";
import { handleBrowse, handleDownload, handleUpload, handleDelete, handleMkdir } from "./files";
import { handlePendingList, handlePendingDownload, handlePendingAck, handleMetadataPush, handleMetadataDelete } from "./sync";
import { authenticate, requireAuth, requireAdmin, type AuthContext } from "./middleware";
import { checkRequestAllowed } from "./quota";
import { loginPage, registerPage, browsePage, adminPage } from "./views";

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
  AGENT_URL: string;
  AGENT_SHARED_SECRET: string;
  JWT_SECRET: string;
  DISABLE_REGISTRATION?: string;
}

async function verifyAgentAuth(req: Request, env: Env): Promise<boolean> {
  const ts = req.headers.get("X-HomeNFV-Timestamp");
  const sig = req.headers.get("X-HomeNFV-Signature");
  if (!ts || !sig) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts)) > 30) return false;
  const url = new URL(req.url);
  const message = `${req.method}:${url.pathname}:${ts}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.AGENT_SHARED_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expectedHex = [...new Uint8Array(expected)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sig === expectedHex;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html;charset=utf-8" } });
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    const ctx = await authenticate(request, env);

    // --- Health ---
    if (pathname === "/api/health") {
      return Response.json({ status: "ok" });
    }

    // --- Rate limit ---
    if (!(await checkRequestAllowed(env))) {
      return Response.json({ error: "Daily request limit reached" }, { status: 429 });
    }

    // --- Agent sync routes (HMAC auth) ---
    if (pathname.startsWith("/api/sync/")) {
      if (!(await verifyAgentAuth(request, env))) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (pathname === "/api/sync/pending" && method === "GET") return handlePendingList(env);
      if (pathname === "/api/sync/pending/download" && method === "GET") {
        const p = url.searchParams.get("path");
        return p ? handlePendingDownload(p, env) : Response.json({ error: "path required" }, { status: 400 });
      }
      if (pathname === "/api/sync/pending/ack" && method === "POST") {
        const p = url.searchParams.get("path");
        return p ? handlePendingAck(p, env) : Response.json({ error: "path required" }, { status: 400 });
      }
      if (pathname === "/api/sync/metadata" && method === "POST") return handleMetadataPush(request, env);
      if (pathname === "/api/sync/metadata" && method === "DELETE") return handleMetadataDelete(request, env);
    }

    // --- HTML pages ---
    if (pathname === "/" || pathname === "") {
      return redirect(ctx ? "/browse" : "/login");
    }

    if (pathname === "/login") {
      if (ctx) return redirect("/browse");
      if (method === "POST") {
        const form = await request.formData();
        const username = form.get("username") as string;
        const password = form.get("password") as string;
        const fakeReq = new Request(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const resp = await handleLogin(fakeReq, env);
        if (resp.ok) {
          const cookie = resp.headers.get("Set-Cookie")!;
          return new Response(null, { status: 302, headers: { Location: "/browse", "Set-Cookie": cookie } });
        }
        const data = await resp.json<{ error: string }>();
        return html(loginPage(data.error));
      }
      return html(loginPage());
    }

    if (pathname === "/register") {
      if (env.DISABLE_REGISTRATION === "true") return html(registerPage("Registration is disabled"));
      if (method === "POST") {
        const form = await request.formData();
        const username = form.get("username") as string;
        const password = form.get("password") as string;
        const fakeReq = new Request(request.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const resp = await handleRegister(fakeReq, env);
        const data = await resp.json<{ message?: string; error?: string }>();
        if (resp.ok) return html(registerPage(undefined, data.message));
        return html(registerPage(data.error));
      }
      return html(registerPage());
    }

    // --- JSON API routes (no auth required) ---
    if (pathname === "/api/auth/register" && method === "POST") {
      if (env.DISABLE_REGISTRATION === "true") return Response.json({ error: "Registration disabled" }, { status: 403 });
      return handleRegister(request, env);
    }
    if (pathname === "/api/auth/login" && method === "POST") return handleLogin(request, env);
    if (pathname === "/api/auth/logout" && method === "POST") return handleLogout();

    // Pages below require auth
    if (!ctx) return redirect("/login");
    const user = { username: ctx.username, role: ctx.role };

    if (pathname === "/browse") {
      const filePath = url.searchParams.get("path") || "/";
      const resp = await handleBrowse(filePath, env);
      const data = await resp.json<{ files: any[]; offline?: boolean }>();
      return html(browsePage(filePath, data.files, user, data.offline));
    }

    if (pathname === "/admin") {
      if (ctx.role !== "admin") return redirect("/browse");
      const resp = await handleListUsers(env);
      const data = await resp.json<{ users: any[] }>();
      return html(adminPage(data.users, user));
    }

    // --- JSON API routes (auth required) ---

    if (pathname === "/api/auth/me" && method === "GET") {
      const err = requireAuth(ctx);
      if (err) return err;
      return Response.json({ userId: ctx!.userId, username: ctx!.username, role: ctx!.role });
    }

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
      if (!filePath) return Response.json({ error: "path required" }, { status: 400 });
      return handleMkdir(filePath, env);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
