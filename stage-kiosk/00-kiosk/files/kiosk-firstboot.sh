#!/bin/bash
# One-shot first-boot task (a systemd oneshot that disables itself):
#
#   1. Partition the card. The stock Pi OS "grow root to fill the card" step is
#      disabled in this image (no ` resize` in cmdline.txt), so we do it here:
#      the root partition grows to ROOT_TARGET and the rest of the card becomes
#      an exFAT data partition labelled VIDEOS that laptops can read and write.
#      On cards too small to leave MIN_VIDEOS for that partition, root simply
#      takes the whole card, exactly like stock Pi OS.
#   2. Lock the root filesystem read-only (overlayroot) so users can safely cut
#      power at any time.
#   3. Reboot.
set -u

CMDLINE=/boot/firmware/cmdline.txt
ROOT_TARGET=$((4 * 1024 * 1024 * 1024))   # bytes, root partition size
MIN_VIDEOS=$((1024 * 1024 * 1024))        # bytes, else root gets everything
SECTOR=512
ALIGN=2048                                 # sectors; keep partitions 1 MiB aligned

log() { echo "kiosk-firstboot: $*"; }
# Partition number of a block device, e.g. /dev/mmcblk0p2 -> 2 (from sysfs, no udev needed).
part_num() { cat "/sys/class/block/$(basename "$1")/partition" 2>/dev/null; }
# Device path of partition N of a disk, e.g. part_by_num /dev/mmcblk0 3 -> /dev/mmcblk0p3
part_by_num() {
  local p
  for p in /sys/block/"$(basename "$1")"/*/partition; do
    [ "$(cat "$p" 2>/dev/null)" = "$2" ] && echo "/dev/$(basename "$(dirname "$p")")" && return 0
  done
  return 1
}

# Stock resize still pending (not expected in this image, but guard anyway).
if grep -q ' resize' "$CMDLINE"; then
  exit 0  # we'll run again next boot
fi

# Already locked? (Shouldn't happen thanks to the unit Condition, but be safe.)
if grep -q 'overlayroot=tmpfs' /proc/cmdline; then
  systemctl disable kiosk-firstboot.service
  exit 0
fi

partition_card() {
  local root_part disk root_num sectors disk_end root_start root_end target_end
  local videos_start videos_part

  root_part=$(readlink -f "${KIOSK_ROOT_PART:-$(findmnt -no SOURCE /)}") || return 0
  disk=/dev/$(lsblk -no PKNAME "$root_part") || return 0
  root_num=$(part_num "$root_part")
  if [ "$root_num" != 2 ]; then
    log "root is partition $root_num, not 2; leaving partition table alone"
    return 0
  fi
  if part_by_num "$disk" 3 >/dev/null; then
    log "partition 3 already exists; nothing to do"
    return 0
  fi

  sectors=$(blockdev --getsz "$disk")
  disk_end=$((sectors - 1))
  # parted -m prints "2:<start>s:<end>s:..." for partition 2.
  read -r root_start root_end < <(parted -sm "$disk" unit s print | awk -F: '$1==2 {gsub("s","",$2); gsub("s","",$3); print $2, $3}')
  [ -n "${root_start:-}" ] && [ -n "${root_end:-}" ] || { log "could not read partition table"; return 0; }

  target_end=$((root_start + ROOT_TARGET / SECTOR))
  target_end=$(((target_end / ALIGN) * ALIGN - 1))
  if (( disk_end - target_end < MIN_VIDEOS / SECTOR )); then
    log "card too small for a VIDEOS partition; root takes the whole card"
    target_end=$disk_end
  fi

  if (( target_end > root_end )); then
    log "growing root partition to sector $target_end"
    # parted wants a "yes" for a mounted partition; this is how the stock Pi OS
    # first-boot script answers it. resize2fs then grows the mounted ext4 online.
    if printf 'unit s\nresizepart %s\nyes\n%ss\n' "$root_num" "$target_end" | parted "$disk" ---pretend-input-tty >/dev/null; then
      resize2fs "$root_part"
    else
      log "root partition resize failed; continuing with current size"
    fi
    # Re-read the real end in case the resize was refused.
    root_end=$(parted -sm "$disk" unit s print | awk -F: '$1==2 {gsub("s","",$3); print $3}')
  fi

  if (( target_end >= disk_end )); then
    return 0
  fi

  videos_start=$(((root_end / ALIGN + 1) * ALIGN))
  if (( disk_end - videos_start < MIN_VIDEOS / SECTOR )); then
    log "not enough space left for a VIDEOS partition"
    return 0
  fi
  log "creating VIDEOS partition from sector $videos_start to the end of the card"
  # "ntfs" only sets MBR type 0x07, which is what Windows expects for exFAT.
  if ! parted -s "$disk" unit s mkpart primary ntfs "$videos_start" 100%; then
    log "could not create VIDEOS partition"
    return 0
  fi
  partprobe "$disk" 2>/dev/null
  udevadm settle
  videos_part=$(part_by_num "$disk" 3)
  if [ ! -b "${videos_part:-}" ]; then
    log "partition 3 did not appear"
    return 0
  fi
  if command -v mkfs.exfat >/dev/null; then
    mkfs.exfat -L VIDEOS "$videos_part" && return 0
    log "exFAT format failed, falling back to FAT32"
  fi
  mkfs.vfat -F 32 -n VIDEOS "$videos_part"
}

partition_card

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
