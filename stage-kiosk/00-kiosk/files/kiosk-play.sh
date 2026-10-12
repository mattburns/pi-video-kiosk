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

# Hardware decoding: on the Pi 5 the HEVC decoder is mpv's "drm" hwdec (the
# Raspberry Pi ffmpeg hwaccel); "auto" has been seen to skip it and fall back
# to software, which plays 4K in slow motion. Try the explicit names first.
# framedrop=decoder+vo keeps playback on time (dropping frames) if a file is
# too heavy, instead of slow motion.
FLAGS="--vo=gpu --gpu-context=drm --hwdec=drm,drm-copy,auto --framedrop=decoder+vo --fs --loop-playlist=inf --no-osc --no-input-default-bindings --really-quiet"

# Tuning without SSH: an mpv.conf next to the videos (USB stick or VIDEOS
# partition) is applied on top of the flags above, e.g. "hwdec=drm-copy".
[ -f "$DIR/mpv.conf" ] && FLAGS="$FLAGS --include=$DIR/mpv.conf"
# Debugging without SSH: an empty file called kiosk-debug next to the videos
# makes mpv write a verbose log to the SD card's boot partition, readable on
# any computer as kiosk-mpv.log. Opt-in because it writes to the boot partition.
if [ -e "$DIR/kiosk-debug" ] || [ -e "$DIR/kiosk-debug.txt" ]; then
  mount -o remount,rw /boot/firmware 2>/dev/null
  FLAGS="$FLAGS --log-file=/boot/firmware/kiosk-mpv.log"
fi

# 4K output overwhelms the Pi's GPU render path even with hardware decode;
# 1080p output is smooth and the TV upscales it invisibly.
mpv $FLAGS --drm-mode=1920x1080 "$DIR"/*
# Fallback for displays with no 1080p mode: let mpv pick automatically.
exec mpv $FLAGS "$DIR"/*
