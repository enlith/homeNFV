// Usage limits to stay within Cloudflare free tier

export const LIMITS = {
  MAX_R2_STORAGE_BYTES: 8 * 1024 * 1024 * 1024,  // 8GB (buffer below 10GB free limit)
  MAX_FILE_SIZE: 25 * 1024 * 1024,                 // 25MB per file (R2 temp)
  MAX_DAILY_UPLOADS: 500,
  MAX_DAILY_REQUESTS: 80000,
};

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
}

// In-memory request counter — resets when isolate recycles, good enough for rate limiting
let requestCount = 0;
let requestDay = "";

export async function checkUploadAllowed(fileSize: number, env: Env): Promise<{ allowed: boolean; reason?: string }> {
  if (fileSize > LIMITS.MAX_FILE_SIZE) {
    return { allowed: false, reason: `File too large (max ${LIMITS.MAX_FILE_SIZE / 1024 / 1024}MB)` };
  }

  // Check daily upload count from D1 instead of KV
  const today = new Date().toISOString().slice(0, 10);
  const result = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM files WHERE created_at >= unixepoch(?) AND created_at < unixepoch(?, '+1 day')"
  ).bind(today, today).first<{ cnt: number }>();
  if ((result?.cnt || 0) >= LIMITS.MAX_DAILY_UPLOADS) {
    return { allowed: false, reason: "Daily upload limit reached. Try again tomorrow." };
  }

  const sizeResult = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) as total FROM files").first<{ total: number }>();
  const totalUsed = sizeResult?.total || 0;
  if (totalUsed + fileSize > LIMITS.MAX_R2_STORAGE_BYTES) {
    return { allowed: false, reason: `Storage limit reached (${formatGB(totalUsed)} / ${formatGB(LIMITS.MAX_R2_STORAGE_BYTES)} used)` };
  }

  return { allowed: true };
}

export async function incrementUploadCount(_env: Env): Promise<void> {
  // No-op: upload count now derived from D1 files table
}

export function checkRequestAllowed(_env: Env): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (requestDay !== today) {
    requestDay = today;
    requestCount = 0;
  }
  requestCount++;
  return requestCount < LIMITS.MAX_DAILY_REQUESTS;
}

function formatGB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + "GB";
}
