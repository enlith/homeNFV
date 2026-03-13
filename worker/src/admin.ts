import type { User } from "./auth";

interface Env {
  KV: KVNamespace;
}

export async function handleListUsers(env: Env): Promise<Response> {
  const list = await env.KV.list({ prefix: "user:" });
  const users: Omit<User, "passwordHash">[] = [];

  for (const key of list.keys) {
    if (key.name.startsWith("user_id:")) continue;
    const data = await env.KV.get(key.name);
    if (!data) continue;
    const { passwordHash, ...user } = JSON.parse(data) as User;
    users.push(user);
  }

  return json({ users });
}

export async function handleApproveUser(userId: string, env: Env): Promise<Response> {
  return setUserStatus(userId, "active", env);
}

export async function handleRejectUser(userId: string, env: Env): Promise<Response> {
  return setUserStatus(userId, "rejected", env);
}

async function setUserStatus(userId: string, status: User["status"], env: Env): Promise<Response> {
  const username = await env.KV.get(`user_id:${userId}`);
  if (!username) return json({ error: "User not found" }, 404);

  const data = await env.KV.get(`user:${username}`);
  if (!data) return json({ error: "User not found" }, 404);

  const user: User = JSON.parse(data);
  user.status = status;
  await env.KV.put(`user:${username}`, JSON.stringify(user));

  return json({ message: `User ${status}`, username, status });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
