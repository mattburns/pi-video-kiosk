#!/bin/bash
# Check whether a video file will play smoothly on the Pi kiosk, and print
# a re-encode command if it won't. Run on your laptop (needs ffprobe).
#   Usage: ./check-video.sh myvideo.mp4 [more.mp4 ...]
set -u

command -v ffprobe >/dev/null || { echo "ffprobe not found — install ffmpeg first"; exit 1; }

status=0
for f in "$@"; do
  codec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "$f")
  height=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$f")
  if [ -z "${codec:-}" ]; then
    echo "SKIP  $f — no video stream found"
    continue
  fi
  case "$codec" in
    hevc)
      echo "OK    $f — HEVC (${height}p) hardware-decodes on Pi 4/5" ;;
    h264)
      if [ "$height" -le 1080 ]; then
        echo "OK    $f — H.264 ${height}p hardware-decodes fine"
      else
        echo "SLOW  $f — ${height}p H.264 has NO hardware decode on any Pi; re-encode:"
        echo "        ffmpeg -i \"$f\" -c:v libx265 -crf 24 -tag:v hvc1 -c:a copy \"${f%.*}-hevc.mp4\""
        echo "        (on a Mac, swap in: -c:v hevc_videotoolbox -b:v 12M)"
        status=1
      fi ;;
    *)
      echo "SLOW  $f — codec '$codec' likely software-decodes; re-encode as above"
      status=1 ;;
  esac
done
exit $status
