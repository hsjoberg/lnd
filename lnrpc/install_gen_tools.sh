#!/bin/bash

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${DIR}/.." && pwd)"

cd "${ROOT_DIR}"

eval "$(bash "${DIR}/read_tool_versions.sh")"

PROTOBUF_VERSION=$(go list -f '{{.Version}}' -m google.golang.org/protobuf)
GRPC_GATEWAY_VERSION=$(go list -f '{{.Version}}' -m github.com/grpc-ecosystem/grpc-gateway/v2)

echo "Installing protobuf generation tools"
go install "google.golang.org/protobuf/cmd/protoc-gen-go@${PROTOBUF_VERSION}"
go install "google.golang.org/grpc/cmd/protoc-gen-go-grpc@${PROTOC_GEN_GO_GRPC_VERSION}"
go install "github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@${GRPC_GATEWAY_VERSION}"
go install "github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-openapiv2@${GRPC_GATEWAY_VERSION}"
go install "github.com/hsjoberg/falafel@${FALAFEL_VERSION}"
go install "golang.org/x/tools/cmd/goimports@${GOIMPORTS_VERSION}"

echo "Installed tools into $(go env GOPATH)/bin"
