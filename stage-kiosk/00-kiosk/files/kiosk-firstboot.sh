#!/bin/bash
# One-shot first-boot task: after the standard Pi OS filesystem resize has
# completed, lock the root filesystem read-only (overlayroot) so users can
# safely cut power at any time. Runs once, disables itself, reboots.
set -u

CMDLINE=/boot/firmware/cmdline.txt

# The stock resize firstboot (init=...) runs as PID 1 and reboots before
# systemd starts, so by the time we run it is normally done. Guard anyway.
if grep -q 'init=' "$CMDLINE"; then
  exit 0  # resize still pending; we'll run again next boot
fi

# Already locked? (Shouldn't happen thanks to the unit Condition, but be safe.)
if grep -q 'overlayroot=tmpfs' /proc/cmdline; then
  systemctl disable kiosk-firstboot.service
  exit 0
fi

cp "$CMDLINE" "${CMDLINE}.pre-overlay"

# overlayroot package is preinstalled in the image, so this needs no network.
raspi-config nonint enable_overlayfs

# Paranoia: a bad sed or interrupted write here would brick the boot.
if ! grep -q 'overlayroot=tmpfs' "$CMDLINE" 2>/dev/null || [ ! -s "$CMDLINE" ]; then
  sed 's/^/overlayroot=tmpfs /' "${CMDLINE}.pre-overlay" > "$CMDLINE"
fi

systemctl disable kiosk-firstboot.service
sync
reboot
