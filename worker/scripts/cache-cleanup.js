// R2 Cache Cleanup Script
// Runs via GitHub Actions (nightly or manual maintenance)
// Removes cached files that haven't been accessed recently
// and temp files that have already been synced

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BUCKET_NAME = process.env.R2_BUCKET_NAME || "homenfv-cache";
const D1_DATABASE_ID = process.env.D1_DATABASE_ID;
const MAX_CACHE_GB = 8; // Stay under 10GB free tier
const STALE_DAYS = 7; // Remove cache entries older than 7 days

async function cfApi(path, method = "GET", body) {
  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

async function listR2Objects(prefix = "") {
  const objects = [];
  let cursor = "";
  do {
    const params = new URLSearchParams({ prefix });
    if (cursor) params.set("cursor", cursor);
    const data = await cfApi(`/r2/buckets/${BUCKET_NAME}/objects?${params}`);
    if (data.result?.objects) objects.push(...data.result.objects);
    cursor = data.result?.truncated ? data.result.cursor : "";
  } while (cursor);
  return objects;
}

async function deleteR2Object(key) {
  await cfApi(`/r2/buckets/${BUCKET_NAME}/objects/${encodeURIComponent(key)}`, "DELETE");
}

async function queryD1(sql) {
  const data = await cfApi(`/d1/database/${D1_DATABASE_ID}/query`, "POST", { sql });
  return data.result?.[0]?.results || [];
}

async function main() {
  console.log("=== R2 Cache Cleanup ===\n");

  // 1. Clean synced temp files (pending_sync = 0 but still in R2 temp/)
  console.log("Checking for synced temp files...");
  const tempObjects = await listR2Objects("temp/");
  let tempDeleted = 0;

  if (D1_DATABASE_ID) {
    const synced = await queryD1("SELECT path FROM files WHERE pending_sync = 0");
    const syncedPaths = new Set(synced.map((r) => r.path));

    for (const obj of tempObjects) {
      const filePath = obj.key.replace(/^temp/, "");
      if (syncedPaths.has(filePath)) {
        await deleteR2Object(obj.key);
        tempDeleted++;
      }
    }
  }
  console.log(`  Deleted ${tempDeleted} synced temp files`);

  // 2. Clean stale cache entries
  console.log("\nChecking for stale cache entries...");
  const cacheObjects = await listR2Objects("cache/");
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STALE_DAYS);
  let cacheDeleted = 0;

  for (const obj of cacheObjects) {
    const uploaded = new Date(obj.uploaded);
    if (uploaded < cutoff) {
      await deleteR2Object(obj.key);
      cacheDeleted++;

      // Update D1 metadata
      if (D1_DATABASE_ID) {
        const filePath = obj.key.replace(/^cache/, "");
        await queryD1(`UPDATE files SET cached_in_r2 = 0 WHERE path = '${filePath.replace(/'/g, "''")}'`);
      }
    }
  }
  console.log(`  Deleted ${cacheDeleted} cache entries older than ${STALE_DAYS} days`);

  // 3. Report storage usage
  const allObjects = await listR2Objects();
  const totalBytes = allObjects.reduce((sum, o) => sum + (o.size || 0), 0);
  const totalGB = (totalBytes / 1024 / 1024 / 1024).toFixed(2);
  console.log(`\n=== Storage: ${totalGB}GB / ${MAX_CACHE_GB}GB cap (${allObjects.length} objects) ===`);

  // 4. Emergency cleanup if over cap
  if (totalBytes > MAX_CACHE_GB * 1024 * 1024 * 1024) {
    console.log("\n⚠️  Over storage cap! Removing oldest cache entries...");
    const sorted = cacheObjects
      .filter((o) => o.key.startsWith("cache/"))
      .sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));

    let freed = 0;
    for (const obj of sorted) {
      if (totalBytes - freed <= MAX_CACHE_GB * 1024 * 1024 * 1024 * 0.8) break; // Free to 80%
      await deleteR2Object(obj.key);
      freed += obj.size || 0;
    }
    console.log(`  Freed ${(freed / 1024 / 1024).toFixed(1)}MB`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
