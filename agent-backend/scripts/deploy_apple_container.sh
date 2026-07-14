#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Copy a saved Anomalo Apple container image to a remote Mac and run it there.

Usage:
  REMOTE=mac-mini.local scripts/deploy_apple_container.sh artifacts/container-images/anomalo-<tag>-linux-arm64.env
  REMOTE=mac-mini.local IMAGE_REF=anomalo:<tag> scripts/deploy_apple_container.sh artifacts/container-images/anomalo-<tag>-linux-arm64.tar

Environment:
  REMOTE                  SSH target, for example user@mac-mini.local. Alternative: SSH_HOST/SSH_USER
  SSH_HOST                SSH host when REMOTE is not set
  SSH_USER                Optional SSH user when SSH_HOST is used
  SSH_PORT                SSH port. Default: 22
  IMAGE_REF               Required when deploying a .tar directly
  ENV_FILE                Optional local env file copied to the remote host
  REMOTE_ENV_FILE         Remote env-file path. Default: REMOTE_DIR/anomalo.env
  REMOTE_STORAGE_ROOT     Absolute remote root for deploy files and artifacts. When set,
                          defaults REMOTE_DIR to ROOT/anomalo-deploy and REMOTE_DATA_DIR
                          to ROOT/anomalo-data
  REMOTE_DIR              Remote deploy directory. Default: .anomalo/anomalo-deploy
  REMOTE_DATA_DIR         Remote data directory for artifact persistence. Default: .anomalo/anomalo-data
  CONTAINER_NAME          Remote container name. Default: anomalo
  HOST_PORT               Remote host HTTP port. Default: 8000
  APP_PORT                Container HTTP port. Default: 8000
  BUDDY_TRANSPORT         Buddy transport for deployed app. Default: tcp
  BUDDY_TCP_PORT          Buddy TCP port. Default: 8787
  SITE_URL                Public site URL. Default: http://<ssh-host>:HOST_PORT
  MOUNT_ARTIFACTS         Mount persistent agent artifacts and stock runtime data. Default: 1
  START_CONTAINER_SYSTEM  Start Apple container system before deploy. Default: 1
  REMOTE_CONTAINER_CLI    Remote Apple container CLI path. Default: container
  CONTAINER_NETWORK       Dedicated container network. Default: anomalo-external
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

source_path="${1:-${ANOMALO_IMAGE_METADATA:-}}"
[[ -n "$source_path" ]] || {
    usage
    exit 2
}
[[ -f "$source_path" ]] || fail "source file does not exist: $source_path"

if [[ "$source_path" == *.env ]]; then
    # shellcheck disable=SC1090
    source "$source_path"
else
    ANOMALO_IMAGE_ARCHIVE="$source_path"
fi

archive_path="${ANOMALO_IMAGE_ARCHIVE:-}"
image_ref="${IMAGE_REF:-${ANOMALO_IMAGE_REF:-}}"
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
REMOTE_STORAGE_ROOT="${REMOTE_STORAGE_ROOT:-}"
if [[ -n "$REMOTE_STORAGE_ROOT" ]]; then
    [[ "$REMOTE_STORAGE_ROOT" == /* ]] || fail "REMOTE_STORAGE_ROOT must be an absolute remote path"
    default_remote_dir="$REMOTE_STORAGE_ROOT/anomalo-deploy"
    default_remote_data_dir="$REMOTE_STORAGE_ROOT/anomalo-data"
else
    default_remote_dir=".anomalo/anomalo-deploy"
    default_remote_data_dir=".anomalo/anomalo-data"
fi
REMOTE_DIR="${REMOTE_DIR:-$default_remote_dir}"
REMOTE_DATA_DIR="${REMOTE_DATA_DIR:-$default_remote_data_dir}"
REMOTE_CONTAINER_CLI="${REMOTE_CONTAINER_CLI:-container}"
CONTAINER_NAME="${CONTAINER_NAME:-anomalo}"
HOST_PORT="${HOST_PORT:-8000}"
APP_PORT="${APP_PORT:-8000}"
BUDDY_TRANSPORT="${BUDDY_TRANSPORT:-tcp}"
BUDDY_TCP_PORT="${BUDDY_TCP_PORT:-8787}"
MOUNT_ARTIFACTS="${MOUNT_ARTIFACTS:-1}"
START_CONTAINER_SYSTEM="${START_CONTAINER_SYSTEM:-1}"
CONTAINER_NETWORK="${CONTAINER_NETWORK:-anomalo-external}"

site_host="${SSH_HOST:-${ssh_target#*@}}"
site_host="${site_host%%:*}"
SITE_URL="${SITE_URL:-http://${site_host}:${HOST_PORT}}"

remote_archive="$REMOTE_DIR/$(basename "$archive_path")"
REMOTE_ENV_FILE="${REMOTE_ENV_FILE:-$REMOTE_DIR/anomalo.env}"

require_command ssh
require_command scp

ssh_args=(-p "$SSH_PORT")
scp_args=(-P "$SSH_PORT")

remote_dir_q=$(shell_quote "$REMOTE_DIR")
echo "Preparing remote directory $ssh_target:$REMOTE_DIR"
ssh "${ssh_args[@]}" "$ssh_target" "mkdir -p $remote_dir_q"

echo "Copying image archive to $ssh_target:$remote_archive"
scp "${scp_args[@]}" "$archive_path" "$ssh_target:$remote_archive"

if [[ -n "${ENV_FILE:-}" ]]; then
    [[ -f "$ENV_FILE" ]] || fail "ENV_FILE does not exist: $ENV_FILE"
    echo "Copying env file to $ssh_target:$REMOTE_ENV_FILE"
    scp "${scp_args[@]}" "$ENV_FILE" "$ssh_target:$REMOTE_ENV_FILE"
fi

echo "Loading and running $image_ref on $ssh_target"
ssh "${ssh_args[@]}" "$ssh_target" "bash -s" -- \
    "$REMOTE_CONTAINER_CLI" \
    "$remote_archive" \
    "$image_ref" \
    "$CONTAINER_NAME" \
    "$HOST_PORT" \
    "$APP_PORT" \
    "$BUDDY_TRANSPORT" \
    "$BUDDY_TCP_PORT" \
    "$SITE_URL" \
    "$REMOTE_ENV_FILE" \
    "$REMOTE_DATA_DIR" \
    "$MOUNT_ARTIFACTS" \
    "$START_CONTAINER_SYSTEM" \
    "$CONTAINER_NETWORK" <<'REMOTE_SCRIPT'
set -Eeuo pipefail

container_cli="$1"
remote_archive="$2"
image_ref="$3"
container_name="$4"
host_port="$5"
app_port="$6"
buddy_transport="$7"
buddy_tcp_port="$8"
site_url="$9"
remote_env_file="${10}"
remote_data_dir="${11}"
mount_artifacts="${12}"
start_container_system="${13}"
container_network="${14}"

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

build_run_args() {
    local include_mount="$1"
    run_args=(run --detach --name "$container_name")
    if [[ -n "$container_network" ]]; then
        run_args+=(--network "$container_network")
    fi
    run_args+=(--publish "${host_port}:${app_port}")
    if [[ "$buddy_transport" == "tcp" && -n "$buddy_tcp_port" ]]; then
        run_args+=(--publish "${buddy_tcp_port}:${buddy_tcp_port}")
    fi
    if [[ -f "$remote_env_file" ]]; then
        run_args+=(--env-file "$remote_env_file")
    fi
    run_args+=(--env "ANOMALO_SITE_URL=$site_url")
    run_args+=(--env "ANOMALO_BUDDY_TRANSPORT=$buddy_transport")
    if [[ "$buddy_transport" == "tcp" ]]; then
        run_args+=(--env "ANOMALO_BUDDY_TCP_HOST=0.0.0.0")
        run_args+=(--env "ANOMALO_BUDDY_TCP_PORT=$buddy_tcp_port")
    fi
    if [[ "$include_mount" == "1" ]]; then
        mkdir -p "$remote_data_dir/artifacts"
        mkdir -p "$remote_data_dir/stocks/outputs"
        mkdir -p "$remote_data_dir/stocks/data"
        run_args+=(--volume "$remote_data_dir/artifacts:/app/agent-backend/artifacts")
        run_args+=(--volume "$remote_data_dir/stocks/outputs:/app/stock-backend/outputs")
        run_args+=(--volume "$remote_data_dir/stocks/data:/app/stock-backend/data")
    fi
    run_args+=("$image_ref")
}

load_image
remove_existing_container

build_run_args "$mount_artifacts"
if ! "$container_cli" "${run_args[@]}"; then
    if [[ "$mount_artifacts" == "1" ]]; then
        echo "container run with artifacts volume failed; retrying without volume" >&2
        remove_existing_container
        build_run_args "0"
        "$container_cli" "${run_args[@]}"
    else
        exit 1
    fi
fi

if command -v curl >/dev/null 2>&1; then
    for attempt in 1 2 3 4 5; do
        if curl -fsS "http://127.0.0.1:${host_port}/health" >/dev/null; then
            echo "health check passed: http://127.0.0.1:${host_port}/health"
            exit 0
        fi
        sleep 1
    done
    echo "container started, but health check did not pass yet" >&2
fi

"$container_cli" list 2>/dev/null || true
REMOTE_SCRIPT

echo "Deployed $CONTAINER_NAME at $SITE_URL"
