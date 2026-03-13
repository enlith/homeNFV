// HMAC signing for Worker → Agent requests

export async function signRequest(method: string, fullPath: string, secret: string): Promise<{ timestamp: string; signature: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Sign only the path portion (before query string) to match agent verification
  const pathOnly = fullPath.split("?")[0];
  const message = `${method}:${pathOnly}:${timestamp}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const signature = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { timestamp, signature };
}
