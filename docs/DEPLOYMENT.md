# Production deployment

Frontend and backend deploy from the same GitHub `main` commit, but through different pipelines.

## Frontend (Cloudflare Pages)

1. Push to `main`
2. Pages builds `apps/web` with `VITE_API_BASE_URL` set to the HTTPS API tunnel URL
3. Static assets publish automatically

No VPS steps are required for the web app.

## Backend (Contabo VPS, immutable releases)

Layout on the VPS:

```text
/home/ubuntu/navigation-api/
  current → releases/<sha>
  releases/<sha>/          # immutable checkout + build
  shared/.env              # secrets (never in Git)
  shared/DEPLOYED_SHA
  bin/navigation-deploy
  bin/health-check.sh
  bin/navigation-deploy-wrapper
  repo.git                 # mirror used by navigation-deploy
```

systemd unit: `navigation-api.service`  
Working directory: `/home/ubuntu/navigation-api/current`  
Secrets: `/home/ubuntu/navigation-api/shared/.env`

Required production values in that file:

```text
HOST=127.0.0.1
TRUST_PROXY=true
DOCS_ENABLED=false
CORS_ORIGINS=https://YOUR-PROJECT.pages.dev
```

`NODE_ENV=production` is set by `navigation-api.service`. Without `CORS_ORIGINS`, browsers (including Cloudflare Pages) cannot call the API.

### TLS

Do not expose Node on public `:3010`. Terminate HTTPS, then close the port:

1. Point DNS at the VPS (or a Cloudflare tunnel hostname).
2. Install [Caddy](https://caddyserver.com) and run `ops/Caddyfile` with `API_HOSTNAME` and `CADDY_ACME_EMAIL`.
3. Set `HOST=127.0.0.1` and `TRUST_PROXY=true` as above.
4. `sudo ufw delete allow 3010/tcp` (keep 22, 80, 443).

The Node process then only accepts local reverse-proxy traffic. Cloudflare Pages must use the `https://` origin in `VITE_API_BASE_URL`.

### Automatic deploy

GitHub Actions workflow [`.github/workflows/deploy-api.yml`](../.github/workflows/deploy-api.yml):

1. Spin up PostGIS, migrate, import fixture GTFS
2. Typecheck, test, build contracts + API
3. SSH to the VPS with a **restricted** deploy key
4. Run `navigation-deploy <sha>` (forced SSH command)
5. On the VPS: fetch SHA from `origin/main`, `npm ci`, build, migrate, flip `current`, restart, health-check
6. On health failure: restore previous `current` symlink and restart

Concurrency group `deploy-api` prevents overlapping deploys.

### Health checks

`/health` returns HTTP 200 even when the database is down (`status: "degraded"`).  
Deploy scripts **must** parse JSON and require:

```json
{ "status": "ok", "database": true }
```

See [`ops/health-check.sh`](../ops/health-check.sh).

### GitHub secrets

| Secret | Purpose |
|--------|---------|
| `VPS_SSH_PRIVATE_KEY` | Private half of the restricted deploy key |
| `VPS_KNOWN_HOSTS` | Exact `ssh-keyscan` line(s) for the VPS |
| `PUBLIC_API_BASE_URL` | Optional HTTPS tunnel base for a second health probe |

Host/user (`169.58.152.118` / `ubuntu`) are non-secret workflow config.

Generated local files (gitignored; do not commit):

```text
/Users/eladweller/projects/navigationApp/.deploy-secrets/navigation-vps-deploy      → VPS_SSH_PRIVATE_KEY
/Users/eladweller/projects/navigationApp/.deploy-secrets/navigation-vps.known_hosts → VPS_KNOWN_HOSTS
/Users/eladweller/projects/navigationApp/.deploy-secrets/README.txt
```

Paste each file’s full contents into GitHub → Settings → Secrets and variables → Actions.

### Bootstrap (once per VPS)

From a machine with admin SSH access:

```bash
# 1) Generate a dedicated deploy key (do not reuse your personal key)
ssh-keygen -t ed25519 -f ./navigation-vps-deploy -N "" -C "navigation-api-deploy"

# 2) Capture known_hosts
ssh-keyscan -H 169.58.152.118 > ./navigation-vps.known_hosts

# 3) Copy ops scripts + public key to the VPS, then:
ssh ubuntu@169.58.152.118 'bash -s' < ops/bootstrap-vps-deploy.sh --pubkey-file /path/to/navigation-vps-deploy.pub

# Or scp the ops/ directory and public key, then run bootstrap on the VPS.
```

Then build the first release and enable the service:

```bash
# On VPS (admin SSH), after bootstrap:
/home/ubuntu/navigation-api/bin/navigation-deploy <full-sha-from-main>
sudo systemctl enable --now navigation-api.service
```

Add the private key and known_hosts contents as GitHub Actions secrets (never commit them).

### Rollback

- **Application:** deploy an older SHA that is still an ancestor of `origin/main`, or manually `ln -sfn` a previous `releases/<sha>` and restart.
- **Database:** migrations are forward-only. Prefer expand/contract migrations so app rollback remains safe. There is no automatic schema rollback.

### Legacy checkout

`/home/ubuntu/navigation_app` may remain as a historical fallback, but production traffic should use `/home/ubuntu/navigation-api/current` only.

### What does not run on deploy

- Full Israel GTFS import (`npm run db:import`) — long-running; use a scheduled job separately.
- Cloudflare Pages publish — handled by Pages from the same push.
