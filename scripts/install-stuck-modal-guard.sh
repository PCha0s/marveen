#!/bin/bash
# install-stuck-modal-guard.sh
#
# Installs the launchd twin of scripts/systemd/stuck-modal-guard.timer (macOS).
# Without this unit scripts/stuck-modal-guard.sh never runs on macOS: the
# installer only ever shipped the systemd timer, so on a Mac nothing closes a
# modal that wedges the main channels session. Measured 2026-10-05 on the Mac
# mini (MODELCONFIRM1005): after a /model the CLI's "Switch model?" dialog held
# the main session for half an hour -- every inbound Telegram message queued
# behind it -- and no launchd job of any guard existed to notice. The dashboard's
# own pane classifier reads such a pane as 'unknown' and does not act on it.
#
# Period parity with the systemd timer:
#   OnUnitActiveSec=60s -> StartInterval 60
#   OnBootSec=150s      -> RunAtLoad true (launchd has no boot-delay knob for
#                          agents; an early first run is safe -- the guard only
#                          acts on a pane that stays stuck for STUCK_MODAL_SECONDS,
#                          i.e. at least two consecutive observations)
#   AccuracySec=10s     -> no launchd equivalent
#
# The guard's own safety rules are unchanged: a working (busy) or idle pane is
# never touched, recovery is Escape first and a respawn only after that fails,
# and the respawn shares channel-watchdog.sh's grace stamp.
#
# Usage:
#   scripts/install-stuck-modal-guard.sh            # install, do not start
#   scripts/install-stuck-modal-guard.sh --load     # install and start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LABEL="com.marveen.stuck-modal-guard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GUARD="$PROJECT_DIR/scripts/stuck-modal-guard.sh"

LOAD=0
[ "${1:-}" = "--load" ] && LOAD=1

if [ ! -f "$GUARD" ]; then
  echo "ERROR: $GUARD not found." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$GUARD</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/store/stuck-modal-guard.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/store/stuck-modal-guard.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>$HOME</string>
    <key>USER</key>
    <string>$(id -un)</string>
    <key>TZ</key>
    <string>Europe/Budapest</string>
  </dict>
</dict>
</plist>
PLIST_EOF

echo "Wrote launchd unit: $PLIST"

if [ "$LOAD" = "1" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Loaded $LABEL (every 60s + at load). It only acts on a main-session pane that stays stuck (no idle footer, no live turn) for STUCK_MODAL_SECONDS: Escape first, respawn only if that fails."
else
  echo "Installed but NOT loaded. To start: launchctl load $PLIST"
fi
