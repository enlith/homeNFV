# HomeNFV — Home Network File Vault

A personal cloud drive backed by your home machine, with Cloudflare as the edge layer.

## Architecture

- **Worker** (Cloudflare Edge) — Auth, file routing, caching
- **Agent** (Home ARM64 server) — Local file operations, sync
- **KV** — User accounts, sessions
- **D1** — File/directory metadata (consistent reads)
- **R2** — File cache + temp storage when home is offline

## Project Structure

```
homeNFV/
├── worker/          # Cloudflare Worker (TypeScript)
├── agent/           # Home agent daemon (Go, ARM64)
├── deploy/          # Tunnel + systemd configs
└── .github/         # CI/CD + maintenance workflows
```

## Setup

### Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [Go 1.22+](https://go.dev/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- Cloudflare account (free tier)
- ARM64 Linux machine (e.g. Rock 4SE) with `cloudflared`

### 1. Cloudflare Resources

```bash
# Create KV namespace
npx wrangler kv namespace create KV
# Update the ID in worker/wrangler.toml

# Create D1 database
npx wrangler d1 create homenfv-db
# Update the ID in worker/wrangler.toml

# Create R2 bucket
npx wrangler r2 bucket create homenfv-cache
```

### 2. Secrets

```bash
# Generate secrets
SHARED_SECRET=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)

# Set Worker secrets
cd worker
npx wrangler secret put AGENT_SHARED_SECRET  # paste $SHARED_SECRET
npx wrangler secret put JWT_SECRET            # paste $JWT_SECRET

# Set Agent config (on ARM board)
cp agent/config.example.env /etc/homenfv/config.env
# Edit /etc/homenfv/config.env with the same SHARED_SECRET
```

### 3. Cloudflare Tunnel (on ARM board)

```bash
cloudflared tunnel login
cloudflared tunnel create homenfv
cp deploy/cloudflared.example.yml /etc/cloudflared/config.yml
# Edit with your tunnel ID and domain
sudo systemctl enable --now cloudflared
```

### 4. Deploy

```bash
# Worker
cd worker && npm ci && npx wrangler deploy

# Agent (cross-compile or build on board)
cd agent && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o homenfv-agent ./cmd/agent/
# Copy binary to /usr/local/bin/homenfv-agent on the board
sudo cp deploy/homenfv.service /etc/systemd/system/
sudo systemctl enable --now homenfv
```

### 5. GitHub Secrets (for CI/CD)

Set these in GitHub → Settings → Secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Set this in GitHub → Settings → Variables:

- `WORKER_DOMAIN` (e.g. `drive.yourdomain.com`)

## GitHub Workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| CI | Push / PR | Lint + test both projects |
| Deploy Worker | Push to main (worker/) | Deploy to Cloudflare |
| Build Agent | Push to main (agent/) | Cross-compile ARM64 binary |
| D1 Migrations | Push to main (migrations/) | Apply schema changes |
| Health Check | Every 15 min | Ping worker endpoint |
| Nightly | 3 AM UTC daily | D1 backup + cache cleanup |
| Maintenance | Manual dispatch | On-demand tasks |

## License

See [LICENSE](LICENSE).
