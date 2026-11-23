#!/usr/bin/env bash
# cowork-bridge installer for macOS, Linux and WSL. Safe to run again: it updates and restarts.
#
#   curl -fsSL https://raw.githubusercontent.com/CIOS-Technologies/cowork-bridge/main/install.sh | bash -s -- ~/cowork-bridge
#
# Before running: <home>/config.json and <home>/.env must exist (the cowork-bridge skill writes them).
# Steps: check Node.js 20+ -> app into <home>/app -> Claude Code (if missing) -> one-time Claude sign-in
#        for the reader (browser) -> checks -> start in the background -> autostart at login (macOS only).
# Set COWORK_BRIDGE_NO_AUTOSTART=1 to skip autostart.
set -euo pipefail
HOME_DIR="${1:-${COWORK_BRIDGE_HOME:-$HOME/cowork-bridge}}"
REPO="${COWORK_BRIDGE_REPO:-https://github.com/CIOS-Technologies/cowork-bridge}"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# The result also goes to <home>/logs/install-result.txt, so the AI helping with setup can read it from the
# shared folder instead of asking the person to copy the terminal output.
result() { mkdir -p "$HOME_DIR/logs" 2>/dev/null && printf '%s\nat %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME_DIR/logs/install-result.txt" 2>/dev/null || true; }
fail() { trap - ERR; result "STOPPED: $*"; printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*"; exit 1; }
trap 'fail "unexpected error on line $LINENO (see the lines above)"' ERR

say "cowork-bridge → $HOME_DIR"
[ -f "$HOME_DIR/config.json" ] || fail "$HOME_DIR/config.json is missing. Run the cowork-bridge skill's setup in Cowork first."
result RUNNING
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  case "$(uname)" in
    Darwin) fail "Node.js 20 or newer is needed. Install it with:  brew install node   (or from https://nodejs.org), then run this again.";;
    *) fail "Node.js 20 or newer is needed. Install it from https://nodejs.org or your package manager, then run this again.";;
  esac
fi
if [ "$(uname)" = "Linux" ] && ! command -v tmux >/dev/null; then
  fail "tmux is needed on Linux/WSL to run the reader in the background. Install it (for example: sudo apt install -y tmux), then run this again."
fi

mkdir -p "$HOME_DIR"
if [ -d "$HOME_DIR/app/.git" ]; then
  say "Updating the app"; git -C "$HOME_DIR/app" pull --ff-only
# `git --version`, not `command -v git`: on a fresh Mac, git is a stub that only offers to install the developer tools.
elif git --version >/dev/null 2>&1; then
  say "Downloading the app"; git clone --depth 1 "$REPO" "$HOME_DIR/app"
else
  say "Downloading the app"; mkdir -p "$HOME_DIR/app"
  curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz --strip-components=1 -C "$HOME_DIR/app"
fi
# Linux has no ready-made build of the optional terminal library (it uses tmux instead), so skip it there.
if [ "$(uname)" = "Linux" ]; then OPT="--omit=optional"; else OPT=""; fi
(cd "$HOME_DIR/app" && npm ci --omit=dev $OPT --no-audit --no-fund --loglevel=error) || fail "npm could not install the app's packages."

if ! command -v claude >/dev/null && [ ! -x "$HOME/.local/bin/claude" ]; then
  say "Installing Claude Code"; curl -fsSL https://claude.ai/install.sh | bash
fi

cb() { node "$HOME_DIR/app/bin/cowork-bridge.mjs" "$@" --home "$HOME_DIR"; }
say "Signing the reader in to Claude (one time; skipped if already signed in)"
# When run as `curl … | bash`, standard input is the script itself; give the sign-in the keyboard instead,
# so a code shown in the browser can be pasted here.
if (exec </dev/tty) 2>/dev/null; then LOGIN_IN=/dev/tty; else LOGIN_IN=/dev/null; fi
cb login <"$LOGIN_IN" || fail "the reader is not signed in to Claude. Run the command again and finish the sign-in in the browser."
say "Checking the setup"
cb doctor || fail "fix the items marked with a cross (✗) above, then run the command again."
say "Starting your reader in the background"
cb stop >/dev/null 2>&1 || true
rc=0; cb start || rc=$?
if [ "$rc" = 2 ]; then
  # The sign-in looked valid but Claude Code asked for it again (expired): sign in again, then retry once.
  say "The reader's Claude sign-in has expired: signing in again"
  cb login --again <"$LOGIN_IN" || fail "the reader's Claude sign-in has expired. Run this command again in a terminal window and finish the sign-in in the browser."
  rc=0; cb start || rc=$?
fi
if [ "$rc" = 2 ]; then fail "the reader's Claude sign-in has expired. Run this command again in a terminal window and finish the sign-in in the browser."; fi
[ "$rc" = 0 ] || fail "the reader did not start. See $HOME_DIR/logs/ (reader-screen.txt, supervisor.log) or run: tmux attach -t cowork-bridge"
if [ "$(uname)" = "Darwin" ] && [ -z "${COWORK_BRIDGE_NO_AUTOSTART:-}" ]; then say "Turning on autostart at login"; cb autostart on; fi
say "Status"; cb status || true
result DONE
say "DONE. Your reader runs in the background; no window needs to stay open."
if [ "$(uname)" = "Linux" ]; then echo "After a restart, start it again with: node $HOME_DIR/app/bin/cowork-bridge.mjs start --home $HOME_DIR"; fi
