import { verifyJWT } from "./crypto";

export interface AuthContext {
  userId: string;
  username: string;
  role: "admin" | "user";
}

interface Env {
  JWT_SECRET: string;
}

export async function authenticate(req: Request, env: Env): Promise<AuthContext | null> {
  const cookie = req.headers.get("Cookie") || "";
  const match = cookie.match(/token=([^;]+)/);
  if (!match) return null;

  const payload = await verifyJWT(match[1], env.JWT_SECRET);
  if (!payload) return null;

  return {
    userId: payload.sub as string,
    username: payload.username as string,
    role: payload.role as "admin" | "user",
  };
}

export function requireAuth(ctx: AuthContext | null): Response | null {
  if (!ctx) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  return null;
}

export function requireAdmin(ctx: AuthContext | null): Response | null {
  const authErr = requireAuth(ctx);
  if (authErr) return authErr;
  if (ctx!.role !== "admin") return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } });
  return null;
}
