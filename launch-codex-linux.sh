#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME_DIR="$ROOT_DIR/.codex-linux/runtime/node_modules/electron/dist"
ELECTRON_BIN="$RUNTIME_DIR/electron"
METADATA_PATH="$ROOT_DIR/.codex-linux/metadata.json"
PATCH_VERSION=2
XDG_ROOT="$ROOT_DIR/.codex-linux/xdg"
SESSION_TYPE=${XDG_SESSION_TYPE:-}
DISPLAY_SOCKET=${DISPLAY:-}
WAYLAND_SOCKET=${WAYLAND_DISPLAY:-}

if ! command -v codex >/dev/null 2>&1; then
  echo "codex is not on PATH. Install it first, then rerun this launcher." >&2
  exit 127
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "rg is not on PATH. Install ripgrep first, then rerun this launcher." >&2
  exit 127
fi

if [ ! -x "$ELECTRON_BIN" ] || [ ! -f "$RUNTIME_DIR/resources/app.asar" ] || [ ! -f "$METADATA_PATH" ] || ! grep -q "\"linuxPatchVersion\": $PATCH_VERSION" "$METADATA_PATH"; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required to install the Linux runtime for Codex." >&2
    exit 127
  fi
  bun run install-codex-linux
fi

export ELECTRON_FORCE_IS_PACKAGED=${ELECTRON_FORCE_IS_PACKAGED:-1}
export XDG_CONFIG_HOME=${XDG_CONFIG_HOME:-$XDG_ROOT/config}
export XDG_DATA_HOME=${XDG_DATA_HOME:-$XDG_ROOT/data}
export XDG_STATE_HOME=${XDG_STATE_HOME:-$XDG_ROOT/state}
export XDG_CACHE_HOME=${XDG_CACHE_HOME:-$XDG_ROOT/cache}
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

if [ "${CODEX_LINUX_SOFTWARE_GL:-0}" = "1" ]; then
  export LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-1}
  set -- --use-angle=swiftshader --use-gl=angle --enable-unsafe-swiftshader "$@"
fi

if [ -z "${CODEX_LINUX_OZONE_PLATFORM:-}" ] && [ "$SESSION_TYPE" = "wayland" ] && [ -n "$DISPLAY_SOCKET" ]; then
  set -- --ozone-platform=x11 "$@"
elif [ -n "${CODEX_LINUX_OZONE_PLATFORM:-}" ]; then
  set -- --ozone-platform="$CODEX_LINUX_OZONE_PLATFORM" "$@"
fi

if [ -n "$WAYLAND_SOCKET" ] && [ "${CODEX_LINUX_WAYLAND_HINT:-0}" = "1" ]; then
  export ELECTRON_OZONE_PLATFORM_HINT=auto
fi

if command -v pkill >/dev/null 2>&1; then
  pkill -f "$ELECTRON_BIN" >/dev/null 2>&1 || true
fi

exec "$ELECTRON_BIN" "$@"
