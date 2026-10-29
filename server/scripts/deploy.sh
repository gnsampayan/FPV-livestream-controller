#!/usr/bin/env bash
# =============================================================================
# FPV server deploy
# =============================================================================
# Invoked by the "deploy" job of .github/workflows/ci-cd.yml on the self-hosted
# runner that lives on the production server. It can also be run by hand:
#
#   DEPLOY_DIR=/opt/fpv TARGET_SHA=<40-char sha> DRY_RUN=1 \
#       bash server/scripts/deploy.sh
#
# What it does, in order:
#   1. Pre-flight   Refuse to start unless server/.env is complete and Docker,
#                   the clone and the backup folder are usable. Nothing on the
#                   machine has been changed at this point.
#   2. Backup       Save the current commit, a patch of any local edits to
#                   tracked files, and a copy of server/.env under
#                   $BACKUP_ROOT/<timestamp>/.
#   3. Guard        Abort if an untracked production file would be overwritten
#                   by a different file of the same name that the repo tracks.
#   4. Sync         `git reset --hard $TARGET_SHA`. Never `git clean`, so files
#                   that exist only on production (.env, dist.old, certificates,
#                   anything not in the repo) are never touched.
#   5. Deploy       Pull the images CI built, `compose up`, and restart Janus
#                   only if its mounted config changed (a restart interrupts
#                   the live stream).
#   6. Health check The stack must stay healthy for several consecutive polls.
#   7. Restore      On any failure after step 4: previous images, previous
#                   commit and local edits are put back.
#
# Environment:
#   DEPLOY_DIR        (required) path of the production git clone, e.g. /opt/fpv
#   TARGET_SHA        (required) 40-char commit to deploy
#   IMAGE_TAG         image tag to run (default: TARGET_SHA)
#   IMAGE_REGISTRY    image prefix (default: ghcr.io/gnsampayan)
#   BACKUP_ROOT       backups and state folder (default: /opt/fpv-backups)
#   BACKUP_KEEP       backups to retain (default: 10)
#   HEALTH_DOMAIN     domain probed by the health check (default: SERVER_DOMAIN
#                     from server/.env)
#   HEALTH_TIMEOUT_S  give up waiting for health after this long (default: 90)
#   DRY_RUN=1         run steps 1-3, verify the images exist, change nothing
# =============================================================================

set -euo pipefail

# ---- Configuration ----------------------------------------------------------

: "${DEPLOY_DIR:?DEPLOY_DIR must be set to the production clone, e.g. /opt/fpv}"
: "${TARGET_SHA:?TARGET_SHA must be set to the commit to deploy}"

IMAGE_TAG="${IMAGE_TAG:-$TARGET_SHA}"
IMAGE_REGISTRY="${IMAGE_REGISTRY:-ghcr.io/gnsampayan}"
BACKUP_ROOT="${BACKUP_ROOT:-/opt/fpv-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-10}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-90}"
HEALTH_STABLE_POLLS="${HEALTH_STABLE_POLLS:-3}"
HEALTH_POLL_INTERVAL_S="${HEALTH_POLL_INTERVAL_S:-3}"
DRY_RUN="${DRY_RUN:-0}"

readonly COMPOSE_DIR="${DEPLOY_DIR}/server"
readonly ENV_FILE="${COMPOSE_DIR}/.env"
readonly LAST_GOOD_TAG_FILE="${BACKUP_ROOT}/last-good-tag"
readonly LOCK_FILE="${BACKUP_ROOT}/.deploy.lock"

# The compose project name decides the volume names (server_letsencrypt holds
# the TLS certificates). Pin it so a different working directory can never
# create a fresh, empty set of volumes.
export COMPOSE_PROJECT_NAME="server"
export IMAGE_TAG IMAGE_REGISTRY

# Services whose images CI builds, and the matching image repository names.
readonly BUILT_SERVICES=(control-relay audiobridge-bootstrap nginx)
readonly IMAGE_NAMES=(fpv-control-relay fpv-audiobridge-bootstrap fpv-nginx-web)
# Containers that must be running for the deploy to count as healthy.
readonly REQUIRED_CONTAINERS=(fpv-nginx fpv-control-relay fpv-janus fpv-audiobridge-bootstrap)
# Subset present in every historical version of the stack (used after a restore).
readonly LEGACY_CONTAINERS=(fpv-nginx fpv-control-relay fpv-janus)
# Variables server/.env must define with real (non-placeholder) values.
readonly REQUIRED_ENV_KEYS=(
    NAT_1_1_MAPPING
    JANUS_ADMIN_SECRET
    CONTROL_AUTH_TOKEN
    AUDIOBRIDGE_ADMIN_KEY
    PI_TAILSCALE_IP
    SERVER_DOMAIN
)

# ---- State used by the failure handler --------------------------------------

STAGE="init"            # init -> synced -> done
OLD_SHA=""
BACKUP_DIR=""
PREV_TAG=""
OLD_JANUS_HASH=""
NEW_JANUS_HASH=""
DEPLOY_STARTED_EPOCH=0
RESTORING=0             # 1 while the failure handler is running

# ---- Helpers ----------------------------------------------------------------

log()  { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] WARN: %s\n' "$*" >&2; }
die()  { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

g() { git -C "$DEPLOY_DIR" "$@"; }

compose() { (cd "$COMPOSE_DIR" && docker compose "$@"); }

# Reads KEY from server/.env without sourcing it (the file is not trusted to
# be valid shell). Strips CR and one layer of surrounding quotes.
env_value() {
    local key="$1" line
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
    line="${line#*=}"
    line="${line%$'\r'}"
    line="${line#\"}"; line="${line%\"}"
    line="${line#\'}"; line="${line%\'}"
    printf '%s' "$line"
}

is_placeholder() {
    case "$1" in
        ""|changeme|your.domain.com|*YOUR_*|*x.x.x*) return 0 ;;
    esac
    return 1
}

janus_config_hash() {
    cat "${COMPOSE_DIR}"/janus/*.jcfg 2>/dev/null | sha256sum | cut -d' ' -f1
}

summary() {
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
    fi
}

# ---- Step 1: pre-flight -----------------------------------------------------

preflight() {
    log "Pre-flight checks"

    local tool
    for tool in git docker curl flock sha256sum; do
        command -v "$tool" >/dev/null 2>&1 || die "Required tool not found: ${tool}"
    done

    docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (is the runner user in the docker group?)"
    docker compose version >/dev/null 2>&1 || die "The 'docker compose' plugin is not installed"

    [[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die "TARGET_SHA must be a full 40-character commit hash"
    [[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || die "IMAGE_TAG contains invalid characters"

    [ -d "${DEPLOY_DIR}/.git" ] || die "${DEPLOY_DIR} is not a git clone"
    [ -f "${COMPOSE_DIR}/docker-compose.yml" ] || die "${COMPOSE_DIR}/docker-compose.yml not found"
    [ -f "$ENV_FILE" ] || die "${ENV_FILE} not found (copy server/.env.example and fill it in)"

    local key value missing=()
    for key in "${REQUIRED_ENV_KEYS[@]}"; do
        value="$(env_value "$key")"
        if is_placeholder "$value"; then
            missing+=("$key")
        fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
        die "server/.env is missing real values for: ${missing[*]}"
    fi

    mkdir -p "$BACKUP_ROOT" 2>/dev/null || true
    [ -d "$BACKUP_ROOT" ] && [ -w "$BACKUP_ROOT" ] \
        || die "Backup folder ${BACKUP_ROOT} is not writable. One-time fix: sudo mkdir -p ${BACKUP_ROOT} && sudo chown \"\$(id -un)\": ${BACKUP_ROOT}"

    # Only one deploy at a time, even if the workflow concurrency is bypassed.
    exec 9>"$LOCK_FILE"
    flock -n 9 || die "Another deploy is already running"

    log "Pre-flight OK"
}

# ---- Step 2: backup ---------------------------------------------------------

backup_state() {
    OLD_SHA="$(g rev-parse HEAD)"
    BACKUP_DIR="${BACKUP_ROOT}/$(date +%Y%m%d-%H%M%S)-${OLD_SHA:0:7}"
    log "Backing up current state to ${BACKUP_DIR}"

    (
        # The backup may hold secrets (.env, tokens inside edited files).
        umask 077
        mkdir -p "$BACKUP_DIR"
        # Exact patch used by the failure handler to restore local edits.
        g diff --binary > "${BACKUP_DIR}/local-edits.patch"
        # Human-readable view with line-ending-only noise removed.
        g diff --ignore-cr-at-eol > "${BACKUP_DIR}/local-edits.ignoring-eol.patch" || true
        g status --porcelain > "${BACKUP_DIR}/status.txt"
        printf '%s\n' "$OLD_SHA" > "${BACKUP_DIR}/commit.txt"
        cp "$ENV_FILE" "${BACKUP_DIR}/server.env"
    )

    # Retention: keep the newest BACKUP_KEEP backup folders.
    local old
    while IFS= read -r old; do
        [ -n "$old" ] && rm -rf -- "$old"
    done < <(ls -1dt "${BACKUP_ROOT}"/*/ 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" || true)
}

# ---- Step 3: overwrite guard ------------------------------------------------

fetch_target() {
    log "Fetching origin/main"
    g fetch --quiet origin main
    g cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null \
        || die "Commit ${TARGET_SHA} is not available from origin/main"
}

# Aborts if an untracked production file shares a path with a file the target
# commit tracks AND has different content (ignoring CR line endings). Such a
# file would be silently overwritten by the reset. Identical files are fine.
guard_untracked_collisions() {
    log "Checking for untracked files that the repo would overwrite"
    local path collisions=()
    while IFS= read -r -d '' path; do
        g cat-file -e "${TARGET_SHA}:${path}" 2>/dev/null || continue
        if ! cmp -s \
            <(tr -d '\r' < "${DEPLOY_DIR}/${path}") \
            <(g show "${TARGET_SHA}:${path}" | tr -d '\r'); then
            collisions+=("$path")
        fi
    done < <(g ls-files --others --exclude-standard -z)

    if [ "${#collisions[@]}" -gt 0 ]; then
        printf '[deploy] ERROR: untracked production file(s) would be overwritten:\n' >&2
        printf '[deploy]   %s\n' "${collisions[@]}" >&2
        die "Move or commit these files, then re-run. Nothing was changed."
    fi
}

# ---- Health check -----------------------------------------------------------

health_domain() {
    printf '%s' "${HEALTH_DOMAIN:-$(env_value SERVER_DOMAIN)}"
}

health_probe() {
    local container domain
    local containers=("${REQUIRED_CONTAINERS[@]}")
    if [ "$RESTORING" = "1" ]; then
        # An older stack may predate some services (e.g. audiobridge-bootstrap
        # and the UDP control port), so only check what every version has.
        containers=("${LEGACY_CONTAINERS[@]}")
    fi

    for container in "${containers[@]}"; do
        [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)" = "true" ] \
            || return 1
    done
    # The Pi control link is UDP; the relay must have published it.
    if [ "$RESTORING" != "1" ]; then
        [ -n "$(docker port fpv-control-relay 3002/udp 2>/dev/null)" ] || return 1
    fi

    # Hit the local nginx with the real hostname (SNI + certificate are
    # verified) without depending on hairpin NAT for the public address.
    domain="$(health_domain)"
    curl -fsS -m 5 -o /dev/null \
        --resolve "${domain}:443:127.0.0.1" "https://${domain}/health"
}

wait_healthy() {
    local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) ok=0
    log "Waiting up to ${HEALTH_TIMEOUT_S}s for the stack to stay healthy (${HEALTH_STABLE_POLLS} consecutive polls)"
    while [ "$SECONDS" -lt "$deadline" ]; do
        if health_probe; then
            ok=$((ok + 1))
            if [ "$ok" -ge "$HEALTH_STABLE_POLLS" ]; then
                return 0
            fi
        else
            ok=0
        fi
        sleep "$HEALTH_POLL_INTERVAL_S"
    done
    return 1
}

# ---- Janus restart ----------------------------------------------------------

# Janus config is bind-mounted, so editing it does not recreate the container.
# Restart it only when the config changed AND `compose up` did not already
# (re)start it during this deploy.
restart_janus_if_config_changed() {
    [ "$OLD_JANUS_HASH" != "$NEW_JANUS_HASH" ] || return 0

    local started started_epoch
    started="$(docker inspect -f '{{.State.StartedAt}}' fpv-janus 2>/dev/null || true)"
    started_epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
    if [ "$started_epoch" -lt "$DEPLOY_STARTED_EPOCH" ]; then
        log "Janus config changed; restarting janus"
        compose restart janus
    else
        log "Janus config changed; janus was already recreated by compose up"
    fi
}

# ---- Failure handler --------------------------------------------------------

restore_previous_state() {
    set +e
    RESTORING=1
    warn "Deploy failed after the repository was updated. Restoring the previous state."

    g reset --hard --quiet "$OLD_SHA" \
        || warn "Could not reset the repository to ${OLD_SHA}"

    if [ -s "${BACKUP_DIR}/local-edits.patch" ]; then
        g apply --binary --whitespace=nowarn "${BACKUP_DIR}/local-edits.patch" \
            && log "Re-applied the saved local edits" \
            || warn "Could not re-apply local edits; the patch is kept at ${BACKUP_DIR}/local-edits.patch"
    fi

    log "Restarting the previous containers (image tag: ${PREV_TAG:-latest})"
    IMAGE_TAG="${PREV_TAG:-latest}" compose up -d --remove-orphans \
        || warn "compose up failed during restore"

    if [ "$OLD_JANUS_HASH" != "$NEW_JANUS_HASH" ]; then
        log "Janus config reverted; restarting janus"
        compose restart janus || warn "janus restart failed during restore"
    fi

    if wait_healthy; then
        log "Previous state restored and healthy"
    else
        warn "Previous state restored but the health check does not pass; investigate manually"
    fi
    summary "### Deploy FAILED - previous state restored (backup: \`${BACKUP_DIR}\`)"
}

on_exit() {
    local rc=$?
    trap - EXIT
    if [ "$rc" -ne 0 ] && [ "$STAGE" = "synced" ]; then
        restore_previous_state
    fi
    exit "$rc"
}

# ---- Image cleanup ----------------------------------------------------------

prune_images() {
    docker image prune -f >/dev/null 2>&1 || true

    local name ref tag
    for name in "${IMAGE_NAMES[@]}"; do
        while IFS= read -r ref; do
            [ -n "$ref" ] || continue
            tag="${ref##*:}"
            case "$tag" in
                "$IMAGE_TAG"|"$PREV_TAG"|latest|'<none>') ;;
                *) docker rmi "$ref" >/dev/null 2>&1 || true ;;
            esac
        done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' "${IMAGE_REGISTRY}/${name}" 2>/dev/null || true)
    done
}

# ---- Main -------------------------------------------------------------------

main() {
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap on_exit EXIT

    preflight
    fetch_target

    PREV_TAG="$(cat "$LAST_GOOD_TAG_FILE" 2>/dev/null || true)"
    backup_state
    guard_untracked_collisions

    local name ref
    if [ "$DRY_RUN" = "1" ]; then
        log "DRY RUN: verifying that the CI-built images exist in the registry"
        for name in "${IMAGE_NAMES[@]}"; do
            ref="${IMAGE_REGISTRY}/${name}:${IMAGE_TAG}"
            docker manifest inspect "$ref" >/dev/null 2>&1 \
                || die "Image not found (or not readable): ${ref}"
            log "  found ${ref}"
        done
        log "DRY RUN: files that would change (ignoring line endings only):"
        g diff --stat --ignore-cr-at-eol "$TARGET_SHA" || true
        rm -rf -- "$BACKUP_DIR"
        log "DRY RUN complete. Nothing was changed."
        summary "### Deploy dry run OK for \`${TARGET_SHA:0:7}\`"
        return 0
    fi

    DEPLOY_STARTED_EPOCH="$(date +%s)"
    OLD_JANUS_HASH="$(janus_config_hash)"

    log "Syncing ${DEPLOY_DIR}: ${OLD_SHA:0:7} -> ${TARGET_SHA:0:7} (untracked and ignored files are left alone)"
    STAGE="synced"
    g reset --hard --quiet "$TARGET_SHA"
    NEW_JANUS_HASH="$(janus_config_hash)"

    compose config --quiet || die "docker-compose.yml is invalid after the sync"

    log "Pulling images (tag ${IMAGE_TAG}) from ${IMAGE_REGISTRY}"
    compose pull "${BUILT_SERVICES[@]}"

    log "Starting the stack"
    compose up -d --no-build --remove-orphans

    restart_janus_if_config_changed

    wait_healthy || die "Health check failed"

    printf '%s\n' "$IMAGE_TAG" > "$LAST_GOOD_TAG_FILE"
    STAGE="done"
    prune_images

    log "Deploy complete: ${TARGET_SHA:0:7} is live"
    summary "### Deploy OK - \`${TARGET_SHA:0:7}\` is live (backup: \`${BACKUP_DIR}\`)"
}

main "$@"
