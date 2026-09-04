#!/bin/bash -e

install -m 755 files/kiosk-play.sh      "${ROOTFS_DIR}/usr/local/bin/"
install -m 755 files/kiosk-firstboot.sh "${ROOTFS_DIR}/usr/local/bin/"
install -m 644 files/kiosk.service           "${ROOTFS_DIR}/etc/systemd/system/"
install -m 644 files/kiosk-firstboot.service "${ROOTFS_DIR}/etc/systemd/system/"

install -o 1000 -g 1000 -d "${ROOTFS_DIR}/home/${FIRST_USER_NAME}/videos"
install -o 1000 -g 1000 -m 644 files/welcome.mp4 "${ROOTFS_DIR}/home/${FIRST_USER_NAME}/videos/"

on_chroot <<EOF
systemctl enable kiosk.service kiosk-firstboot.service
systemctl disable getty@tty1.service
EOF

# Quiet boot: no console blanking, no boot text, no cursor, no rainbow splash
CMDLINE="${ROOTFS_DIR}/boot/firmware/cmdline.txt"
sed -i '1s/$/ consoleblank=0 quiet loglevel=3 logo.nologo vt.global_cursor_default=0/' "${CMDLINE}"
CONFIG="${ROOTFS_DIR}/boot/firmware/config.txt"
grep -q '^disable_splash=1' "${CONFIG}" || echo 'disable_splash=1' >> "${CONFIG}"
