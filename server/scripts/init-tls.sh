#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# init-tls.sh - one-shot Let's Encrypt bootstrap for the FPV server.
#
# Solves the nginx-won't-start-without-certs chicken-and-egg:
#   1. Plant a short-lived self-signed cert at the path nginx expects so the
#      nginx container can boot with TLS config enabled.
#   2. Bring up nginx (port 80 serves ACME challenges + redirects to HTTPS).
#   3. Ask certbot for a real cert via the webroot plugin, then atomically
#      swap it in over the self-signed one. If certbot fails, the self-signed
#      stays in place so nginx keeps running and we can retry.
#   4. Reload nginx to pick up the real cert.
#   5. Start the renewal sidecar.
#
# Idempotent: re-running after a successful bootstrap just runs `certbot renew`.
#
# Usage (from the server/ directory):
#   ./scripts/init-tls.sh
#
# Prerequisites:
#   - docker compose available
#   - server/.env contains SERVER_DOMAIN and LETSENCRYPT_EMAIL
#   - DNS A/AAAA record for SERVER_DOMAIN already points to this host
#   - Ports 80 and 443 reachable from the public internet
# -----------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${SERVER_DIR}"

if [[ ! -f .env ]]; then
  echo "error: ${SERVER_DIR}/.env not found. Copy .env.example first." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${SERVER_DOMAIN:?SERVER_DOMAIN must be set in .env}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL must be set in .env}"

if [[ "${SERVER_DOMAIN}" == "your.domain.com" || "${SERVER_DOMAIN}" == "localhost" ]]; then
  echo "error: SERVER_DOMAIN is still the placeholder (${SERVER_DOMAIN})." >&2
  echo "       Set it to a real FQDN that resolves to this host before running." >&2
  exit 1
fi

LIVE_DIR="/etc/letsencrypt/live/${SERVER_DOMAIN}"
RENEWAL_CONF="/etc/letsencrypt/renewal/${SERVER_DOMAIN}.conf"

echo "==> Using SERVER_DOMAIN=${SERVER_DOMAIN}"

# ---- Detect an already-managed Let's Encrypt cert --------------------------
# The renewal config is what certbot uses to decide if a cert is "its"; a
# self-signed bootstrap cert won't have one, a real LE cert will.
echo "==> Checking for existing Let's Encrypt certificate..."
if docker compose run --rm --no-deps --entrypoint sh certbot \
    -c "test -f ${RENEWAL_CONF}" >/dev/null 2>&1; then
  echo "    found managed certificate, will renew if needed."
  HAVE_REAL_CERT=1
else
  HAVE_REAL_CERT=0
fi

# ---- Step 1: Plant self-signed so nginx can start --------------------------
if [[ "${HAVE_REAL_CERT}" -eq 0 ]]; then
  echo "==> Planting temporary self-signed cert so nginx can boot..."
  docker compose run --rm --no-deps \
      -e DOMAIN="${SERVER_DOMAIN}" \
      --entrypoint sh certbot -c '
    set -e
    LIVE="/etc/letsencrypt/live/$DOMAIN"
    if [ ! -f "$LIVE/fullchain.pem" ] || [ ! -f "$LIVE/privkey.pem" ]; then
      mkdir -p "$LIVE"
      openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
        -keyout "$LIVE/privkey.pem" \
        -out    "$LIVE/fullchain.pem" \
        -subj   "/CN=$DOMAIN" \
        >/dev/null 2>&1
    fi
  '
fi

# ---- Step 2: Start nginx + friends ----------------------------------------
echo "==> Starting nginx + control-relay + janus..."
docker compose up -d nginx control-relay janus
sleep 3

# ---- Step 3: Obtain (or renew) the real certificate -----------------------
if [[ "${HAVE_REAL_CERT}" -eq 0 ]]; then
  echo "==> Requesting real certificate from Let's Encrypt..."
  # NOTE: we do NOT delete the self-signed cert before calling certbot. That
  # way if the ACME challenge fails (DNS, firewall, rate limit) nginx stays
  # up on the self-signed and we can re-run this script to retry.
  # Side effect: because ${LIVE_DIR} is occupied by the self-signed, certbot
  # writes the new lineage to ${SERVER_DOMAIN}-0001. We fix that up below.
  docker compose run --rm --no-deps --entrypoint certbot certbot \
    certonly \
    --webroot -w /var/www/certbot \
    --email "${LETSENCRYPT_EMAIL}" \
    --agree-tos --no-eff-email \
    --non-interactive \
    --cert-name "${SERVER_DOMAIN}" \
    -d "${SERVER_DOMAIN}"

  # ---- Step 3b: Swap the real cert into the canonical path ---------------
  # If certbot wrote to <domain>-0001 (because the self-signed was squatting
  # at <domain>), promote it to the canonical name so nginx's config - which
  # references /etc/letsencrypt/live/<domain>/ - picks up the real cert.
  echo "==> Promoting new cert to canonical path..."
  docker compose run --rm --no-deps \
      -e DOMAIN="${SERVER_DOMAIN}" \
      --entrypoint sh certbot -c '
    set -e
    LIVE="/etc/letsencrypt/live/$DOMAIN"
    ARCHIVE="/etc/letsencrypt/archive/$DOMAIN"
    RENEWAL="/etc/letsencrypt/renewal/$DOMAIN.conf"
    LIVE_0001="/etc/letsencrypt/live/${DOMAIN}-0001"
    ARCHIVE_0001="/etc/letsencrypt/archive/${DOMAIN}-0001"
    RENEWAL_0001="/etc/letsencrypt/renewal/${DOMAIN}-0001.conf"

    if [ ! -d "$LIVE_0001" ]; then
      echo "    cert already at canonical path, nothing to swap."
      exit 0
    fi

    # Drop the self-signed bootstrap and move the real cert into its place.
    rm -rf "$LIVE" "$ARCHIVE"
    mv "$LIVE_0001"    "$LIVE"
    mv "$ARCHIVE_0001" "$ARCHIVE"

    # Rewrite the symlinks in live/<domain>/ to point at the renamed archive.
    cd "$LIVE"
    for f in cert.pem chain.pem fullchain.pem privkey.pem; do
      if [ -L "$f" ]; then
        t=$(readlink "$f")
        nt=$(echo "$t" | sed "s|${DOMAIN}-0001|$DOMAIN|g")
        ln -sf "$nt" "$f"
      fi
    done

    # Point the renewal config at the canonical paths too.
    if [ -f "$RENEWAL_0001" ]; then
      sed -i "s|${DOMAIN}-0001|$DOMAIN|g" "$RENEWAL_0001"
      mv "$RENEWAL_0001" "$RENEWAL"
    fi
  '
else
  echo "==> Running certbot renew (no-op unless close to expiry)..."
  docker compose run --rm --no-deps --entrypoint certbot certbot \
    renew --webroot -w /var/www/certbot --quiet
fi

# ---- Step 4: Reload nginx --------------------------------------------------
echo "==> Reloading nginx to pick up new certificates..."
docker compose exec nginx nginx -s reload

# ---- Step 5: Start the renewal sidecar -------------------------------------
echo "==> Bringing up the certbot renewal sidecar..."
docker compose up -d certbot

echo ""
echo "Done. https://${SERVER_DOMAIN}/ should now be reachable."
echo "Certbot will auto-renew every 12h; nginx reloads every 6h."
