#!/usr/bin/env bash
# Idempotent bootstrap for immutable Navigation API releases on the Contabo VPS.
# Run as ubuntu on the VPS (or via SSH with an admin key).
#
# Usage:
#   ./ops/bootstrap-vps-deploy.sh [--pubkey-file /path/to/deploy_key.pub]
set -euo pipefail

ROOT="/home/ubuntu/navigation-api"
LEGACY_APP="/home/ubuntu/navigation_app"
SERVICE_SRC="$(cd "$(dirname "$0")" && pwd)/navigation-api.service"
DEPLOY_SRC="$(cd "$(dirname "$0")" && pwd)/navigation-deploy"
HEALTH_SRC="$(cd "$(dirname "$0")" && pwd)/health-check.sh"
PUBKEY_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pubkey-file)
      PUBKEY_FILE="${2:?}"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$ROOT/releases" "$ROOT/shared" "$ROOT/bin" "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

if [[ -f "$LEGACY_APP/.env" && ! -f "$ROOT/shared/.env" ]]; then
  echo "copying existing secrets from legacy checkout"
  cp "$LEGACY_APP/.env" "$ROOT/shared/.env"
  chmod 600 "$ROOT/shared/.env"
fi

if [[ ! -f "$ROOT/shared/.env" ]]; then
  echo "missing $ROOT/shared/.env — create it before switching the service" >&2
  exit 1
fi

install -m 755 "$DEPLOY_SRC" "$ROOT/bin/navigation-deploy"
install -m 755 "$HEALTH_SRC" "$ROOT/bin/health-check.sh"

sudo install -m 644 "$SERVICE_SRC" /etc/systemd/system/navigation-api.service
sudo systemctl daemon-reload

if [[ -n "$PUBKEY_FILE" ]]; then
  if [[ ! -f "$PUBKEY_FILE" ]]; then
    echo "pubkey file not found: $PUBKEY_FILE" >&2
    exit 1
  fi
  PUBKEY="$(tr -d '\n' <"$PUBKEY_FILE")"
  AUTH="$HOME/.ssh/authorized_keys"
  touch "$AUTH"
  chmod 600 "$AUTH"
  # Remove any previous Navigation deploy forced-command entries, then append.
  if grep -q 'navigation-deploy' "$AUTH" 2>/dev/null; then
    grep -v 'navigation-deploy' "$AUTH" >"${AUTH}.tmp" || true
    mv "${AUTH}.tmp" "$AUTH"
    chmod 600 "$AUTH"
  fi
  # Forced command: only allow navigation-deploy with a SHA argument.
  # SSH_ORIGINAL_COMMAND must be exactly: navigation-deploy <40-hex-sha>
  FORCED="command=\"$ROOT/bin/navigation-deploy-wrapper\",restrict,no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ${PUBKEY}"
  printf '%s\n' "$FORCED" >>"$AUTH"
  echo "installed restricted deploy key in $AUTH"
fi

# Wrapper invoked by forced-command SSH key: validates and forwards SHA.
cat >"$ROOT/bin/navigation-deploy-wrapper" <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
ROOT="/home/ubuntu/navigation-api"
CMD="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$CMD" =~ ^navigation-deploy[[:space:]]+([0-9a-f]{40})$ ]]; then
  echo "forbidden command: ${CMD:-<empty>}" >&2
  exit 1
fi
exec "$ROOT/bin/navigation-deploy" "${BASH_REMATCH[1]}"
WRAP
chmod 755 "$ROOT/bin/navigation-deploy-wrapper"

echo "bootstrap complete"
echo "  layout: $ROOT"
echo "  shared env: $ROOT/shared/.env"
echo "  deploy: $ROOT/bin/navigation-deploy <sha>"
echo "Next: build first release (navigation-deploy <sha>), then:"
echo "  sudo systemctl enable --now navigation-api.service"
