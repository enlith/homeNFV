// Usage limits to stay within Cloudflare free tier

export const LIMITS = {
  MAX_R2_STORAGE_BYTES: 8 * 1024 * 1024 * 1024,  // 8GB (buffer below 10GB free limit)
  MAX_FILE_SIZE: 25 * 1024 * 1024,                 // 25MB per file (R2 temp)
  MAX_DAILY_UPLOADS: 500,                           // Stay well under 10M Class A ops/month
  MAX_DAILY_REQUESTS: 80000,                        // Buffer below 100k/day Workers limit
};

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
}

export async function checkUploadAllowed(fileSize: number, env: Env): Promise<{ allowed: boolean; reason?: string }> {
  // Check file size
  if (fileSize > LIMITS.MAX_FILE_SIZE) {
    return { allowed: false, reason: `File too large (max ${LIMITS.MAX_FILE_SIZE / 1024 / 1024}MB)` };
  }

  // Check daily upload count
  const today = new Date().toISOString().slice(0, 10);
  const countKey = `quota:uploads:${today}`;
  const count = parseInt((await env.KV.get(countKey)) || "0");
  if (count >= LIMITS.MAX_DAILY_UPLOADS) {
    return { allowed: false, reason: "Daily upload limit reached. Try again tomorrow." };
  }

  // Check total R2 storage estimate from D1
  const result = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) as total FROM files").first<{ total: number }>();
  const totalUsed = result?.total || 0;
  if (totalUsed + fileSize > LIMITS.MAX_R2_STORAGE_BYTES) {
    return { allowed: false, reason: `Storage limit reached (${formatGB(totalUsed)} / ${formatGB(LIMITS.MAX_R2_STORAGE_BYTES)} used)` };
  }

  return { allowed: true };
}

export async function incrementUploadCount(env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const countKey = `quota:uploads:${today}`;
  const count = parseInt((await env.KV.get(countKey)) || "0");
  await env.KV.put(countKey, String(count + 1), { expirationTtl: 86400 });
}

export async function checkRequestAllowed(env: Env): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  const countKey = `quota:requests:${today}`;
  const count = parseInt((await env.KV.get(countKey)) || "0");
  if (count >= LIMITS.MAX_DAILY_REQUESTS) return false;
  // Increment every 10th request to reduce KV writes (1k writes/day limit)
  if (count % 10 === 0) {
    await env.KV.put(countKey, String(count + 10), { expirationTtl: 86400 });
  }
  return true;
}

function formatGB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + "GB";
}
