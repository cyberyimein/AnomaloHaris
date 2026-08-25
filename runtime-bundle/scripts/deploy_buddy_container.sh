#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Copy a saved Buddy service Apple container image to a remote Mac and run it there.

Usage:
  REMOTE=macmini scripts/deploy_buddy_container.sh artifacts/container-images/buddy-service-<tag>-linux-arm64.env
  REMOTE=macmini IMAGE_REF=buddy-service:<tag> scripts/deploy_buddy_container.sh artifacts/container-images/buddy-service-<tag>-linux-arm64.tar

Environment:
  REMOTE                  SSH target, for example user@mac-mini.local. Alternative: SSH_HOST/SSH_USER
  SSH_HOST                SSH host when REMOTE is not set
  SSH_USER                Optional SSH user when SSH_HOST is used
  SSH_PORT                SSH port. Default: 22
  IMAGE_REF               Required when deploying a .tar directly
  ENV_FILE                Private Buddy env file. Default: runtime-bundle/deploy/buddy-service.container.env
  REMOTE_ENV_FILE         Remote env-file path. Default: REMOTE_DIR/buddy-service.env
  REMOTE_DIR              Remote deploy directory. Default: .anomaloharis/buddy-service-deploy
  CONTAINER_NAME          Remote container name. Default: buddy-service
  HOST_PORT               Host port for the Buddy HTTP API. Default: 8765
  APP_PORT                Container Buddy HTTP port. Default: 8765
  DEVICE_HOST_PORT        Host port for the device TCP listener. Default: 8787
  DEVICE_APP_PORT         Container device TCP port. Default: 8787
  PUBLISH_DEVICE_PORT     Publish the device port. Default: 1
  START_CONTAINER_SYSTEM  Start Apple container system before deploy. Default: 1
  REMOTE_CONTAINER_CLI    Remote Apple container CLI path. Default: container
  CONTAINER_NETWORK       Shared network with AnomaloHaris. Default: anomaloharis-external
EOF
}

fail() {
    echo "error: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

shell_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
agent_backend_root=$(cd "$script_dir/.." && pwd)
repo_root=$(cd "$agent_backend_root/.." && pwd)

source_path="${1:-${BUDDY_IMAGE_METADATA:-}}"
[[ -n "$source_path" ]] || {
    usage
    exit 2
}
[[ -f "$source_path" ]] || fail "source file does not exist: $source_path"

if [[ "$source_path" == *.env ]]; then
    # shellcheck disable=SC1090
    source "$source_path"
else
    BUDDY_IMAGE_ARCHIVE="$source_path"
fi

archive_path="${BUDDY_IMAGE_ARCHIVE:-${ANOMALOHARIS_IMAGE_ARCHIVE:-${ANOMALO_IMAGE_ARCHIVE:-}}}" # naming-compat
image_ref="${IMAGE_REF:-${BUDDY_IMAGE_REF:-${ANOMALOHARIS_IMAGE_REF:-${ANOMALO_IMAGE_REF:-}}}}" # naming-compat
[[ -n "$archive_path" ]] || fail "image archive was not provided"
[[ -f "$archive_path" ]] || fail "image archive does not exist: $archive_path"
[[ -n "$image_ref" ]] || fail "IMAGE_REF is required when the source is not a metadata .env file"

if [[ -n "${REMOTE:-}" ]]; then
    ssh_target="$REMOTE"
elif [[ -n "${SSH_TARGET:-}" ]]; then
    ssh_target="$SSH_TARGET"
elif [[ -n "${SSH_HOST:-}" ]]; then
    ssh_target="${SSH_USER:+$SSH_USER@}$SSH_HOST"
else
    fail "set REMOTE or SSH_HOST"
fi

SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-.anomaloharis/buddy-service-deploy}"
REMOTE_CONTAINER_CLI="${REMOTE_CONTAINER_CLI:-container}"
CONTAINER_NAME="${CONTAINER_NAME:-buddy-service}"
HOST_PORT="${HOST_PORT:-8765}"
APP_PORT="${APP_PORT:-8765}"
DEVICE_HOST_PORT="${DEVICE_HOST_PORT:-8787}"
DEVICE_APP_PORT="${DEVICE_APP_PORT:-8787}"
PUBLISH_DEVICE_PORT="${PUBLISH_DEVICE_PORT:-1}"
START_CONTAINER_SYSTEM="${START_CONTAINER_SYSTEM:-1}"
CONTAINER_NETWORK="${CONTAINER_NETWORK:-anomaloharis-external}"
ENV_FILE="${ENV_FILE:-$repo_root/runtime-bundle/deploy/buddy-service.container.env}"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-$REMOTE_DIR/buddy-service.env}"

[[ -f "$ENV_FILE" ]] || fail "ENV_FILE does not exist: $ENV_FILE"

remote_archive="$REMOTE_DIR/$(basename "$archive_path")"
require_command ssh
require_command scp

ssh_args=(-p "$SSH_PORT")
scp_args=(-P "$SSH_PORT")
remote_dir_q=$(shell_quote "$REMOTE_DIR")

echo "Preparing remote directory $ssh_target:$REMOTE_DIR"
ssh "${ssh_args[@]}" "$ssh_target" "mkdir -p $remote_dir_q"

echo "Copying image archive to $ssh_target:$remote_archive"
scp "${scp_args[@]}" "$archive_path" "$ssh_target:$remote_archive"

echo "Copying Buddy env file to $ssh_target:$REMOTE_ENV_FILE"
scp "${scp_args[@]}" "$ENV_FILE" "$ssh_target:$REMOTE_ENV_FILE"

echo "Loading and running $image_ref on $ssh_target"
ssh "${ssh_args[@]}" "$ssh_target" "bash -s" -- \
    "$REMOTE_CONTAINER_CLI" \
    "$remote_archive" \
    "$image_ref" \
    "$CONTAINER_NAME" \
    "$HOST_PORT" \
    "$APP_PORT" \
    "$DEVICE_HOST_PORT" \
    "$DEVICE_APP_PORT" \
    "$PUBLISH_DEVICE_PORT" \
    "$REMOTE_ENV_FILE" \
    "$START_CONTAINER_SYSTEM" \
    "$CONTAINER_NETWORK" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

container_cli="$1"
remote_archive="$2"
image_ref="$3"
container_name="$4"
host_port="$5"
app_port="$6"
device_host_port="$7"
device_app_port="$8"
publish_device_port="$9"
remote_env_file="${10}"
start_container_system="${11}"
container_network="${12}"

if [[ "$start_container_system" == "1" ]]; then
    "$container_cli" system start >/dev/null 2>&1 || true
fi

if [[ -n "$container_network" ]] && ! "$container_cli" network list | awk 'NR > 1 { print $1 }' | grep -Fxq "$container_network"; then
    "$container_cli" network create "$container_network" >/dev/null
fi

load_image() {
    "$container_cli" image load --input "$remote_archive" \
        || "$container_cli" image load -i "$remote_archive" \
        || "$container_cli" image load "$remote_archive"
}

remove_existing_container() {
    "$container_cli" stop "$container_name" >/dev/null 2>&1 || true
    "$container_cli" delete "$container_name" >/dev/null 2>&1 \
        || "$container_cli" rm "$container_name" >/dev/null 2>&1 \
        || true
}

run_args=(run --detach --name "$container_name" --network "$container_network")
run_args+=(--publish "${host_port}:${app_port}")
if [[ "$publish_device_port" == "1" ]]; then
    run_args+=(--publish "${device_host_port}:${device_app_port}")
fi
run_args+=(--env-file "$remote_env_file" "$image_ref")

load_image
remove_existing_container
"$container_cli" "${run_args[@]}"

if command -v curl >/dev/null 2>&1; then
    for attempt in 1 2 3 4 5 6 7 8; do
        if curl -fsS "http://127.0.0.1:${host_port}/healthz" >/dev/null; then
            echo "health check passed: http://127.0.0.1:${host_port}/healthz"
            "$container_cli" list 2>/dev/null || true
            exit 0
        fi
        sleep 1
    done
    echo "container started, but health check did not pass yet" >&2
fi

"$container_cli" logs "$container_name" 2>/dev/null || true
"$container_cli" list 2>/dev/null || true
exit 1
REMOTE_SCRIPT

echo "Deployed $CONTAINER_NAME on $ssh_target"
