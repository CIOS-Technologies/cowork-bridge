#!/usr/bin/env bash
# cowork-bridge installer for macOS, Linux and WSL. Safe to run again (it updates and restarts).
#   curl -fsSL https://raw.githubusercontent.com/CIOS-Technologies/cowork-bridge/main/install.sh | bash -s -- [home-folder]
set -euo pipefail
HOME_DIR="${1:-${COWORK_BRIDGE_HOME:-$HOME/cowork-bridge}}"
REPO="${COWORK_BRIDGE_REPO:-https://github.com/CIOS-Technologies/cowork-bridge}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "cowork-bridge → $HOME_DIR"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node.js 20 or newer is needed."
  case "$(uname)" in
    Darwin) echo "Install it with:  brew install node   (or from https://nodejs.org)";;
    *) echo "Install it from https://nodejs.org or with your package manager (for example: sudo apt install nodejs npm)";;
  esac
  exit 1
fi

mkdir -p "$HOME_DIR"
if [ -d "$HOME_DIR/app/.git" ]; then
  say "Updating the app"; git -C "$HOME_DIR/app" pull --ff-only
elif command -v git >/dev/null; then
  say "Downloading the app"; git clone --depth 1 "$REPO" "$HOME_DIR/app"
else
  say "Downloading the app"; mkdir -p "$HOME_DIR/app"
  curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz --strip-components=1 -C "$HOME_DIR/app"
fi
(cd "$HOME_DIR/app" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

if ! command -v claude >/dev/null && [ ! -x "$HOME/.local/bin/claude" ]; then
  say "Installing Claude Code"; curl -fsSL https://claude.ai/install.sh | bash
fi
if [ "$(uname)" != "Darwin" ] && ! command -v tmux >/dev/null; then
  echo "Tip: install tmux (sudo apt install tmux) so the reader runs in the background instead of a terminal window."
fi

cb() { node "$HOME_DIR/app/bin/cowork-bridge.mjs" "$1" --home "$HOME_DIR"; }
say "Checking the setup"
if cb doctor; then
  say "Starting your reader"
  cb stop >/dev/null 2>&1 || true
  cb start
fi
