#!/bin/bash
# Play all videos on loop. If a USB stick with video files in its root
# folder is plugged in, play those instead of the built-in /home/pi/videos.
DIR=/home/pi/videos
mkdir -p /mnt/usb
for dev in /dev/sda1 /dev/sdb1 /dev/sda /dev/sdb; do
  [ -b "$dev" ] || continue
  if mount -o ro "$dev" /mnt/usb 2>/dev/null; then
    if compgen -G '/mnt/usb/*.mp4' >/dev/null || compgen -G '/mnt/usb/*.mkv' >/dev/null || compgen -G '/mnt/usb/*.mov' >/dev/null; then
      DIR=/mnt/usb
      break
    fi
    umount /mnt/usb 2>/dev/null
  fi
done
FLAGS="--vo=gpu --gpu-context=drm --hwdec=auto --fs --loop-playlist=inf --no-osc --no-input-default-bindings --really-quiet"
# 4K output overwhelms the Pi's GPU render path even with hardware decode;
# 1080p output is smooth and the TV upscales it invisibly.
mpv $FLAGS --drm-mode=1920x1080 "$DIR"/*
# Fallback for displays with no 1080p mode: let mpv pick automatically.
exec mpv $FLAGS "$DIR"/*
