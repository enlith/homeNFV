import { hashPassword, verifyPassword, createJWT } from "./crypto";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "user";
  status: "pending" | "active" | "rejected";
  createdAt: number;
}

interface Env {
  KV: KVNamespace;
  JWT_SECRET: string;
}

export async function handleRegister(req: Request, env: Env): Promise<Response> {
  const { username, password } = await req.json<{ username: string; password: string }>();
  if (!username || !password || password.length < 8) {
    return json({ error: "Username and password (min 8 chars) required" }, 400);
  }

  const existing = await env.KV.get(`user:${username}`);
  if (existing) return json({ error: "Username taken" }, 409);

  // First user becomes admin and is auto-approved
  const userCount = parseInt((await env.KV.get("meta:user_count")) || "0");
  const isFirst = userCount === 0;

  const user: User = {
    id: crypto.randomUUID(),
    username,
    passwordHash: await hashPassword(password),
    role: isFirst ? "admin" : "user",
    status: isFirst ? "active" : "pending",
    createdAt: Date.now(),
  };

  await env.KV.put(`user:${username}`, JSON.stringify(user));
  await env.KV.put(`user_id:${user.id}`, username);
  await env.KV.put("meta:user_count", String(userCount + 1));

  return json({
    message: isFirst ? "Admin account created" : "Registration pending approval",
    username: user.username,
    status: user.status,
  }, 201);
}

export async function handleLogin(req: Request, env: Env): Promise<Response> {
  const { username, password } = await req.json<{ username: string; password: string }>();
  if (!username || !password) return json({ error: "Username and password required" }, 400);

  const data = await env.KV.get(`user:${username}`);
  if (!data) return json({ error: "Invalid credentials" }, 401);

  const user: User = JSON.parse(data);
  if (user.status !== "active") return json({ error: "Account not active" }, 403);
  if (!(await verifyPassword(password, user.passwordHash))) return json({ error: "Invalid credentials" }, 401);

  const token = await createJWT({ sub: user.id, username: user.username, role: user.role }, env.JWT_SECRET);

  return json({ message: "Logged in" }, 200, {
    "Set-Cookie": `token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
  });
}

export async function handleLogout(): Promise<Response> {
  return json({ message: "Logged out" }, 200, {
    "Set-Cookie": "token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
