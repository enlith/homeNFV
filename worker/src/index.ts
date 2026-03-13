export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return new Response("HomeNFV is running");
  },
};

interface Env {
  KV: KVNamespace;
  R2: R2Bucket;
  DB: D1Database;
  AGENT_URL: string;
  AGENT_SHARED_SECRET: string;
  JWT_SECRET: string;
}
