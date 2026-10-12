# Pi Video Kiosk

Turn a Raspberry Pi into a zero-maintenance video looper for a TV — conference
rooms, lobbies, trade-show booths, digital signage.

**Flash the image. Put videos on a USB stick. Plug into any TV. That's it.**

🌐 **Website & browser-based video converter:
[mattburns.github.io/pi-video-kiosk](https://mattburns.github.io/pi-video-kiosk/)**

- Boots straight into fullscreen video in ~15 seconds — no desktop, no login
  prompt, no boot text
- Videos loop forever; multiple files play as a playlist
- **USB stick = content management.** Videos in the stick's root folder play
  instead of the built-in ones. Swap content with no laptop and no network.
- **Or no stick at all.** The SD card gets a `VIDEOS` partition that Windows
  and macOS can see; drop videos there and the Pi plays them. A USB stick, if
  present, still wins.
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
3. Insert the SD card, connect the TV via HDMI, and power on.
4. Add your videos (`.mp4` / `.mkv` / `.mov`), either way:
   - **USB stick** (FAT32 or exFAT): put them in the stick's root folder and
     plug it into the Pi.
   - **On the SD card itself:** after the first boot, put the card back in
     your computer. A `VIDEOS` drive appears; copy the videos into it.

The **first boot takes 2–3 minutes**: it grows the root filesystem, creates
the `VIDEOS` partition from the rest of the card, locks the system read-only
and reboots once. Every boot after that goes straight to video in ~15
seconds. A built-in welcome video plays until you add your own.

To change videos: swap the USB stick contents (or the files on the `VIDEOS`
drive) and power-cycle the Pi. If both are present, the USB stick wins and the
SD card's videos are ignored.

## Video format — read this if playback stutters

The Pi's hardware video decoder supports:

| Codec | Max smooth resolution |
|-------|----------------------|
| H.264 / AVC | 1080p |
| H.265 / HEVC | 4K (2160p) |

**4K H.264 files will play in slow motion** — no Raspberry Pi can
hardware-decode them. Check your files before the event:

- **In the browser:** drop them on the
  [video converter](https://mattburns.github.io/pi-video-kiosk/convert.html).
  It flags problem files and re-encodes them to 4K HEVC using your machine's
  hardware encoder (WebCodecs, via [Mediabunny](https://mediabunny.dev/)).
  Nothing is uploaded. HEVC encoding needs Chrome/Edge on macOS or Windows,
  or Safari on a Mac; other browsers fall back to 1080p H.264.
- **On the command line:**

  ```bash
  ./scripts/check-video.sh myvideo.mp4
  ```

  It flags anything problematic and prints the exact `ffmpeg` re-encode command.

## Troubleshooting playback (no SSH needed)

Put these next to your videos (USB stick root or the `VIDEOS` partition) and
power-cycle:

- **`kiosk-debug`** (an empty file): mpv writes a verbose log to the SD card's
  boot partition as `kiosk-mpv.log`, which any computer can read. Look for
  `Using hardware decoding` (good) or a software-decoder fallback (slow).
- **`mpv.conf`**: extra mpv options applied on top of the kiosk's defaults,
  one per line, e.g. `hwdec=drm-copy` or `hwdec=auto`. Handy for trying
  decoder settings without reflashing.

If a 4K 60 fps HEVC file stutters, re-encode it with the converter's
**30 fps** cap (halves the decode load) or the 1080p HEVC preset.

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
- The stock Pi OS "grow root to fill the card" step is switched off. Instead a
  one-shot first-boot service grows the root partition to 4 GiB, formats the
  rest of the card as an exFAT partition labelled `VIDEOS` (so there's no 4 GB
  file-size limit), then enables `overlayroot` (root filesystem becomes a
  tmpfs overlay — all writes go to RAM) and disables itself. Cards under
  ~5 GB get no `VIDEOS` partition; root takes everything, as before.
- Content detection happens at boot, in priority order: a USB stick with
  videos in its root folder, then the `VIDEOS` partition, then the built-in
  `/home/pi/videos/`. Both removable sources are mounted read-only, so
  pulling the stick or cutting power can't corrupt them.

## Building the image yourself

GitHub Actions builds it (see
[.github/workflows/build-image.yml](.github/workflows/build-image.yml)).
Every push to `main` that touches `stage-kiosk/` rebuilds the image and
updates the rolling **Latest build** release (tag `latest`); pushing a `v*`
tag publishes a versioned release. Fork the repo and run the **Build image**
workflow, or build locally on any Linux box with Docker:

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

## Website

The site in [docs/](docs/) is plain static HTML/JS, deployed to GitHub Pages by
[.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml) on
every push to `main` that touches `docs/`. The workflow enables Pages itself on
first run; if that fails, set **Settings → Pages → Source** to *GitHub Actions*
and re-run it. To work on it locally, serve the folder with any static server
(e.g. `python3 -m http.server -d docs`). The converter must be served over
HTTP, not opened as a `file://` URL, because it's an ES module.

## Hardware

Tested on Raspberry Pi 5. Should work on Pi 4 (same KMS/DRM + hardware HEVC
path). Pi 3 and Zero 2 W will handle 1080p H.264 but not HEVC 4K.

You'll need: Pi + official PSU, microSD card (8 GB+ if you want to keep
videos on the card; 4 GB works for USB-stick-only use), micro-HDMI→HDMI cable
(Pi 4/5), and optionally a USB stick for content.

## License

[MIT](LICENSE)
