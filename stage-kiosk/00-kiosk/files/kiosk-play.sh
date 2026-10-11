#!/bin/bash
# Play all videos on loop. Content sources, in priority order:
#   1. a USB stick with video files in its root folder
#   2. the VIDEOS partition on the SD card (created on first boot)
#   3. the built-in /home/pi/videos
shopt -s nocaseglob
has_videos() {
  compgen -G "$1/*.mp4" >/dev/null || compgen -G "$1/*.mkv" >/dev/null || compgen -G "$1/*.mov" >/dev/null
}

DIR=/home/pi/videos

mkdir -p /mnt/usb
for dev in /dev/sda1 /dev/sdb1 /dev/sda /dev/sdb; do
  [ -b "$dev" ] || continue
  if mount -o ro "$dev" /mnt/usb 2>/dev/null; then
    if has_videos /mnt/usb; then
      DIR=/mnt/usb
      break
    fi
    umount /mnt/usb 2>/dev/null
  fi
done

if [ "$DIR" = /home/pi/videos ]; then
  # Partition 3 of whatever disk we booted from is the VIDEOS partition.
  boot_disk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /boot/firmware)" 2>/dev/null)
  videos_part=
  for p in /sys/block/"${boot_disk:-none}"/*/partition; do
    [ "$(cat "$p" 2>/dev/null)" = 3 ] && videos_part="/dev/$(basename "$(dirname "$p")")"
  done
  if [ -b "${videos_part:-}" ]; then
    mkdir -p /mnt/sdcard
    if mount -o ro "$videos_part" /mnt/sdcard 2>/dev/null; then
      if has_videos /mnt/sdcard; then
        DIR=/mnt/sdcard
      else
        umount /mnt/sdcard 2>/dev/null
      fi
    fi
  fi
fi

FLAGS="--vo=gpu --gpu-context=drm --hwdec=auto --fs --loop-playlist=inf --no-osc --no-input-default-bindings --really-quiet"
# 4K output overwhelms the Pi's GPU render path even with hardware decode;
# 1080p output is smooth and the TV upscales it invisibly.
mpv $FLAGS --drm-mode=1920x1080 "$DIR"/*
# Fallback for displays with no 1080p mode: let mpv pick automatically.
exec mpv $FLAGS "$DIR"/*
