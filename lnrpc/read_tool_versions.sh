#!/bin/bash

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKERFILE="${DIR}/Dockerfile"

docker_env() {
  local name="$1"
  sed -n "s/^ENV ${name}=\"\\([^\"]*\\)\"/\\1/p" "${DOCKERFILE}" | head -n1
}

docker_goimports_version() {
  sed -n 's/.*golang.org\/x\/tools\/cmd\/goimports@\([^[:space:]]*\).*/\1/p' "${DOCKERFILE}" | head -n1
}

PROTOC_GEN_GO_GRPC_VERSION=$(docker_env PROTOC_GEN_GO_GRPC_VERSION)
FALAFEL_VERSION=$(docker_env FALAFEL_VERSION)
GOIMPORTS_VERSION=$(docker_goimports_version)

if [[ -z "${PROTOC_GEN_GO_GRPC_VERSION}" || -z "${FALAFEL_VERSION}" || -z "${GOIMPORTS_VERSION}" ]]; then
  echo "Failed to read generator tool versions from ${DOCKERFILE}" >&2
  exit 1
fi

cat <<EOF
export PROTOC_GEN_GO_GRPC_VERSION=${PROTOC_GEN_GO_GRPC_VERSION}
export FALAFEL_VERSION=${FALAFEL_VERSION}
export GOIMPORTS_VERSION=${GOIMPORTS_VERSION}
EOF
