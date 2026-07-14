#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Build Anomalo with Apple container and save the image as an OCI tar archive.

Usage:
  agent-backend/scripts/build_apple_container_image.sh

Environment:
  CONTAINER_CLI            Apple container CLI path. Default: container
  IMAGE_NAME               Local image name. Default: anomalo
  IMAGE_TAG                Image tag. Default: current git short SHA or timestamp
  IMAGE_REF                Full image reference. Default: IMAGE_NAME:IMAGE_TAG
  PLATFORM                 Target platform. Default: linux/arm64
  OUTPUT_DIR               Archive output directory. Default: agent-backend/artifacts/container-images
  ARCHIVE_PATH             Exact output archive path. Overrides OUTPUT_DIR naming
  DOCKERFILE               Dockerfile path. Default: agent-backend/docker/anomalo/Dockerfile
  INSTALL_EXTRAS           Python extras installed in image. Default: buddy
  START_CONTAINER_SYSTEM   Start Apple container system before build. Default: 1
EOF
}

fail() {
    echo "error: $*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

sanitize() {
    printf '%s' "$1" | tr '/:@' '---' | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-//; s/-$//'
}

write_env_value() {
    local key="$1"
    local value="$2"
    printf '%s="' "$key"
    printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g'
    printf '"\n'
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
agent_backend_root=$(cd "$script_dir/.." && pwd)
repo_root=$(cd "$agent_backend_root/.." && pwd)

CONTAINER_CLI="${CONTAINER_CLI:-container}"
IMAGE_NAME="${IMAGE_NAME:-anomalo}"
PLATFORM="${PLATFORM:-linux/arm64}"
OUTPUT_DIR="${OUTPUT_DIR:-$agent_backend_root/artifacts/container-images}"
DOCKERFILE="${DOCKERFILE:-$agent_backend_root/docker/anomalo/Dockerfile}"
INSTALL_EXTRAS="${INSTALL_EXTRAS:-buddy,stocks}"
START_CONTAINER_SYSTEM="${START_CONTAINER_SYSTEM:-1}"

if [[ -z "${IMAGE_TAG:-}" ]]; then
    if git -C "$repo_root" rev-parse --short HEAD >/dev/null 2>&1; then
        IMAGE_TAG=$(git -C "$repo_root" rev-parse --short HEAD)
    else
        IMAGE_TAG=$(date +%Y%m%d%H%M%S)
    fi
fi

IMAGE_REF="${IMAGE_REF:-${IMAGE_NAME}:${IMAGE_TAG}}"

safe_image_name=$(sanitize "$IMAGE_NAME")
safe_image_tag=$(sanitize "$IMAGE_TAG")
safe_platform=$(sanitize "$PLATFORM")
platform_suffix=""
if [[ -n "$safe_platform" ]]; then
    platform_suffix="-$safe_platform"
fi

mkdir -p "$OUTPUT_DIR"
ARCHIVE_PATH="${ARCHIVE_PATH:-$OUTPUT_DIR/${safe_image_name}-${safe_image_tag}${platform_suffix}.tar}"
METADATA_PATH="${METADATA_PATH:-${ARCHIVE_PATH%.tar}.env}"

require_command "$CONTAINER_CLI"

if [[ "$START_CONTAINER_SYSTEM" == "1" ]]; then
    "$CONTAINER_CLI" system start >/dev/null 2>&1 || true
fi

build_args=(build --tag "$IMAGE_REF" --file "$DOCKERFILE")
if [[ -n "$PLATFORM" ]]; then
    build_args+=(--platform "$PLATFORM")
fi
if [[ -n "$INSTALL_EXTRAS" ]]; then
    build_args+=(--build-arg "ANOMALO_INSTALL_EXTRAS=$INSTALL_EXTRAS")
fi
build_args+=("$repo_root")

echo "Building $IMAGE_REF"
"$CONTAINER_CLI" "${build_args[@]}"

save_args=(image save --output "$ARCHIVE_PATH")
if [[ -n "$PLATFORM" ]]; then
    save_args+=(--platform "$PLATFORM")
fi
save_args+=("$IMAGE_REF")

echo "Saving $IMAGE_REF to $ARCHIVE_PATH"
"$CONTAINER_CLI" "${save_args[@]}"

{
    write_env_value ANOMALO_IMAGE_REF "$IMAGE_REF"
    write_env_value ANOMALO_IMAGE_ARCHIVE "$ARCHIVE_PATH"
    write_env_value ANOMALO_IMAGE_PLATFORM "$PLATFORM"
    write_env_value ANOMALO_IMAGE_DOCKERFILE "$DOCKERFILE"
    write_env_value ANOMALO_IMAGE_CREATED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$METADATA_PATH"

echo "Wrote metadata to $METADATA_PATH"
echo "$METADATA_PATH"
