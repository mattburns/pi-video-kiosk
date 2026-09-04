# Pi Video Kiosk

Turn a Raspberry Pi into a zero-maintenance video looper for a TV — conference
rooms, lobbies, trade-show booths, digital signage.

**Flash the image. Put videos on a USB stick. Plug into any TV. That's it.**

- Boots straight into fullscreen video in ~15 seconds — no desktop, no login
  prompt, no boot text
- Videos loop forever; multiple files play as a playlist
- **USB stick = content management.** Videos in the stick's root folder play
  instead of the built-in ones. Swap content with no laptop and no network.
- **Unplug it whenever you want.** The filesystem locks itself read-only on
  first boot, so cutting power can never corrupt the SD card.
- Hardware-accelerated playback up to 4K HEVC on Pi 4 / Pi 5

## Quick start

1. Download `pi-video-kiosk.img.xz` from the
   [latest release](../../releases/latest).
2. Flash it to a microSD card (4GB+) with
   [Raspberry Pi Imager](https://www.raspberrypi.com/software/): choose
   **Use custom** and pick the downloaded file. (Skip the OS customisation
   dialog — apply no settings.)
3. Copy your videos (`.mp4` / `.mkv` / `.mov`) onto a USB stick
   (FAT32 or exFAT), root folder, and plug it into the Pi.
4. Insert the SD card, connect the TV via HDMI, and power on.

The **first boot takes 2–3 minutes** (it resizes the filesystem to fit your
card, then locks it read-only, rebooting a couple of times along the way).
Every boot after that goes straight to video in ~15 seconds. A built-in
welcome video plays if no USB stick is present.

To change videos: swap the USB stick contents and power-cycle the Pi.

## Video format — read this if playback stutters

The Pi's hardware video decoder supports:

| Codec | Max smooth resolution |
|-------|----------------------|
| H.264 / AVC | 1080p |
| H.265 / HEVC | 4K (2160p) |

**4K H.264 files will play in slow motion** — no Raspberry Pi can
hardware-decode them. Check your files before the event:

```bash
./scripts/check-video.sh myvideo.mp4
```

It flags anything problematic and prints the exact `ffmpeg` re-encode command.

## SSH access (optional — you never need it)

The Pi joins ethernet automatically as `kiosk.local`:

```bash
ssh pi@kiosk.local   # password: kiosk
```

⚠️ These are **published default credentials** — fine for a kiosk on a
trusted/offline network, but change the password (see below) if the device
will sit on a network you don't control. For Wi-Fi, configure it while the
filesystem is unlocked using `sudo raspi-config`.

### Making persistent changes (password, Wi-Fi, built-in videos)

The root filesystem is read-only (changes vanish on reboot). To modify it:

```bash
sudo raspi-config nonint disable_overlayfs && sudo reboot
# ...make your changes (e.g. passwd, copy videos to ~/videos/)...
sudo raspi-config nonint enable_overlayfs && sudo reboot
```

## How it works

- Raspberry Pi OS Lite (64-bit) built with [pi-gen](https://github.com/RPi-Distro/pi-gen)
  via a custom stage ([stage-kiosk/](stage-kiosk/))
- A systemd service runs [mpv](https://mpv.io/) directly on KMS/DRM
  (`--vo=gpu --gpu-context=drm --hwdec=auto`) — no X11/Wayland
- Output is pinned to 1080p: 4K *output* drops frames on the Pi's GPU render
  path even when *decode* is hardware-accelerated, and TVs upscale 1080p
  invisibly. (Your 4K HEVC files still decode in hardware and look great.)
- On first boot, after the standard filesystem resize, a one-shot service
  enables `overlayroot` (root filesystem becomes a tmpfs overlay — all writes
  go to RAM) and disables itself
- USB detection happens at boot: if a stick with videos is present it wins,
  otherwise `/home/pi/videos/` plays

## Building the image yourself

GitHub Actions builds it (see
[.github/workflows/build-image.yml](.github/workflows/build-image.yml)) —
fork the repo and run the **Build image** workflow, or locally on any Linux
box with Docker:

```bash
git clone --branch arm64 https://github.com/RPi-Distro/pi-gen
cd pi-gen
ln -s /path/to/pi-video-kiosk/stage-kiosk .
cat > config <<'EOF'
IMG_NAME=pi-video-kiosk
RELEASE=trixie
STAGE_LIST="stage0 stage1 stage2 ./stage-kiosk"
TARGET_HOSTNAME=kiosk
FIRST_USER_NAME=pi
FIRST_USER_PASS=kiosk
DISABLE_FIRST_BOOT_USER_RENAME=1
ENABLE_SSH=1
DEPLOY_COMPRESSION=xz
EOF
./build-docker.sh
```

## Hardware

Tested on Raspberry Pi 5. Should work on Pi 4 (same KMS/DRM + hardware HEVC
path). Pi 3 and Zero 2 W will handle 1080p H.264 but not HEVC 4K.

You'll need: Pi + official PSU, microSD card, micro-HDMI→HDMI cable
(Pi 4/5), and optionally a USB stick for content.

## License

[MIT](LICENSE)
