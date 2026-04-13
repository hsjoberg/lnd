#!/bin/sh

# go/clangwrap.sh

set -eu

SDK_PATH=$(xcrun --sdk "$SDK" --show-sdk-path)
CLANG=$(xcrun --sdk "$SDK" --find clang)

case "$GOARCH" in
amd64)
	CARCH="x86_64"
	;;
arm64)
	CARCH="arm64"
	;;
*)
	echo "unsupported GOARCH: $GOARCH" >&2
	exit 1
	;;
esac

MIN_VERSION_FLAG="-mios-version-min=10.0"
if [ "$SDK" = "iphonesimulator" ]; then
	MIN_VERSION_FLAG="-mios-simulator-version-min=10.0"
fi

exec "$CLANG" -arch "$CARCH" -isysroot "$SDK_PATH" \
	"$MIN_VERSION_FLAG" "$@"
