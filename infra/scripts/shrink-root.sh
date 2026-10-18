#!/usr/bin/env bash
# Move the server's root disk to a smaller EBS volume (150 GB -> 40-50 GB) without reinstalling.
# The new disk gets the same layout and the same identifiers (disk GUID, partition GUIDs,
# filesystem UUIDs and labels) as the old one, so GRUB (root=PARTUUID=...), /etc/fstab
# (LABEL=cloudimg-rootfs, BOOT, UEFI) and everything else boot from it unchanged.
#
# Runbook section 0b has the AWS console steps. In short:
#   1. AWS: allocate an Elastic IP for the instance (keeps the IP through the stop/start).
#   2. AWS: create a gp3 volume (e.g. 50 GB) in the instance's zone, attach it as /dev/sdf.
#   3. Here:  sudo bash shrink-root.sh copy  /dev/nvme1n1   (app keeps running; repeatable)
#   4. Here:  sudo bash shrink-root.sh final /dev/nvme1n1   (stops Kritvia ~5 min, last sync,
#             gives the new disk the old identifiers, checks it, then: sudo poweroff)
#   5. AWS: snapshot the old volume, detach both, attach the new one as the root device
#      (the "Root device name" on the instance's Storage tab, e.g. /dev/sda1), start.
#   6. Check: sudo bash shrink-root.sh verify
# Going back: stop, detach the new volume, attach the old one as root again, start.
#
# The 6 GB swap file isn't copied: the instance's boot script (user data) recreates it.
# Testing: SRC (default /), SRC_DISK, TGT_P1, TGT_P15, TGT_P16 can point at loop devices.
set -euo pipefail

CMD="${1:-}"
TGT="${2:-}"
SRC="${SRC:-/}"
SRC="${SRC%/}"
NEW="${NEW_MNT:-/mnt/newroot}"
MARK=".kritvia-shrink-root"
KEEP_FREE_GB="${KEEP_FREE_GB:-8}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing $1 (sudo apt-get install -y $2)"; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
need sgdisk gdisk; need rsync rsync; need mkfs.vfat dosfstools; need tune2fs e2fsprogs; need blkid util-linux

src_dev() { findmnt -no SOURCE --target "$1" | sed 's/\[.*//'; }
part() {   # target partition device for number $1
  local v="TGT_P$1"
  if [ -n "${!v:-}" ]; then echo "${!v}"; return; fi
  case "$TGT" in *[0-9]) echo "${TGT}p$1" ;; *) echo "${TGT}$1" ;; esac
}

ROOT_DEV=$(src_dev "${SRC:-/}")
BOOT_DEV=$(src_dev "$SRC/boot")
EFI_DEV=$(src_dev "$SRC/boot/efi")
SRC_DISK="${SRC_DISK:-/dev/$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null | head -1)}"
[ "$BOOT_DEV" != "$ROOT_DEV" ] || die "expected a separate /boot (Ubuntu cloud image layout)"
[ "$EFI_DEV" != "$BOOT_DEV" ] || die "expected a separate /boot/efi"

guid() { sgdisk -i "$2" "$1" 2>/dev/null | awk -F': ' '/Partition unique GUID/ {print $2}'; }
typecode() { sgdisk -i "$2" "$1" 2>/dev/null | awk -F'[: ]+' '/Partition GUID code/ {print $4}'; }
first() { sgdisk -i "$2" "$1" 2>/dev/null | awk '/First sector/ {print $3}'; }
last() { sgdisk -i "$2" "$1" 2>/dev/null | awk '/Last sector/ {print $3}'; }
disk_guid() { sgdisk -p "$1" 2>/dev/null | awk -F': ' '/Disk identifier/ {print $2}'; }

check_target() {
  [ -n "$TGT" ] || die "usage: shrink-root.sh copy|final /dev/nvme1n1   (or verify)"
  [ -b "$TGT" ] || [ -f "$TGT" ] || die "$TGT is not a disk"
  [ "$TGT" != "$SRC_DISK" ] || die "$TGT is the disk the server is running from"
  if lsblk -no MOUNTPOINT "$TGT" 2>/dev/null | grep -qv "^$\|^$NEW"; then
    die "something on $TGT is mounted outside $NEW"
  fi
  local tgt_gb used_gb
  tgt_gb=$(( $(blockdev --getsize64 "$TGT" 2>/dev/null || stat -c %s "$TGT") / 1024 / 1024 / 1024 ))
  used_gb=$(( $(df -B1 --output=used "$SRC/" | tail -1) / 1024 / 1024 / 1024 ))
  local swap_gb=0
  [ -f "$SRC/swapfile" ] && swap_gb=$(( $(stat -c %s "$SRC/swapfile") / 1024 / 1024 / 1024 ))
  echo "new disk ${tgt_gb} GB; in use on / ${used_gb} GB (of which swap file ${swap_gb} GB, recreated at boot)"
  [ $(( used_gb + KEEP_FREE_GB )) -le "$tgt_gb" ] || die "the new disk is too small: keep at least ${KEEP_FREE_GB} GB free"
}

mount_new() {
  mkdir -p "$NEW"
  mountpoint -q "$NEW" || mount "$(part 1)" "$NEW"
  mkdir -p "$NEW/boot"
  mountpoint -q "$NEW/boot" || mount "$(part 16)" "$NEW/boot"
  mkdir -p "$NEW/boot/efi"
  mountpoint -q "$NEW/boot/efi" || mount "$(part 15)" "$NEW/boot/efi"
}

umount_new() {
  for m in "$NEW/boot/efi" "$NEW/boot" "$NEW"; do mountpoint -q "$m" && umount "$m"; done
  return 0
}

sync_all() {   # $1 = extra rsync flags
  say "Copying files (this pass: ${1:-live})"
  # -x stays on the root filesystem; /boot and /boot/efi are copied separately below.
  rsync -aAXHx --numeric-ids --delete --info=progress2 --no-inc-recursive \
    --exclude=/swapfile --exclude="/$MARK" --exclude=/lost+found \
    --exclude='/tmp/*' --exclude='/var/tmp/*' --exclude='/mnt/*' --exclude='/media/*' \
    --exclude=/proc/ --exclude=/sys/ --exclude=/dev/ --exclude=/run/ \
    "$SRC/" "$NEW/"
  mkdir -p "$NEW/proc" "$NEW/sys" "$NEW/dev" "$NEW/run" "$NEW/tmp" "$NEW/mnt" "$NEW/boot"
  chmod 1777 "$NEW/tmp"
  rsync -aAXH --numeric-ids --delete --exclude=/efi/ "$SRC/boot/" "$NEW/boot/"
  rsync -rt --delete "$SRC/boot/efi/" "$NEW/boot/efi/"   # FAT keeps no owners or links
  touch "$NEW/$MARK"
}

copy() {
  check_target
  if [ ! -f "$NEW/$MARK" ] && ! { mount_new 2>/dev/null && [ -f "$NEW/$MARK" ]; }; then
    umount_new
    if sgdisk -p "$TGT" 2>&1 | grep -q '^ *[0-9]'; then
      [ "${FORCE:-}" = 1 ] || die "$TGT already has partitions and wasn't made by this script; FORCE=1 to wipe it"
    fi
    say "Partitioning $TGT like $SRC_DISK (new identifiers for now; the old ones go on in 'final')"
    sgdisk -Z "$TGT" >/dev/null
    sgdisk -n "15:$(first "$SRC_DISK" 15):$(last "$SRC_DISK" 15)" -t "15:$(typecode "$SRC_DISK" 15)" \
           -n "16:$(first "$SRC_DISK" 16):$(last "$SRC_DISK" 16)" -t "16:$(typecode "$SRC_DISK" 16)" \
           -n "1:$(first "$SRC_DISK" 1):0" -t "1:$(typecode "$SRC_DISK" 1)" "$TGT" >/dev/null
    partprobe "$TGT" 2>/dev/null || true
    udevadm settle 2>/dev/null || true
    sleep 1
    if [ "$(blkid -s TYPE -o value "$EFI_DEV")" = vfat ]; then mkfs.vfat -F 32 -n NEWUEFI "$(part 15)" >/dev/null
    else mkfs.ext4 -q -F -L NEWUEFI "$(part 15)"; fi
    mkfs.ext4 -q -F -L NEWBOOT "$(part 16)"
    mkfs.ext4 -q -F -L newroot "$(part 1)"
    mount_new
  fi
  sync_all live
  sync
  df -h "$NEW" | tail -1
  say "Copied. Run 'copy' again any time to catch up; then 'final' when you're ready for ~5 minutes of downtime."
}

final() {
  check_target
  mount_new
  [ -f "$NEW/$MARK" ] || die "run 'copy' first"
  if [ "$SRC" = "" ] || [ "$SRC" = "/" ]; then
    say "Stopping Kritvia and Docker (downtime starts)"
    if [ -d /opt/kritvia/infra ]; then (cd /opt/kritvia/infra && docker compose --profile tunnel stop) || true; fi
    systemctl stop docker.socket docker containerd 2>/dev/null || true
  fi
  sync_all final
  rm -f "$NEW/$MARK"
  sync
  umount_new

  say "Giving the new disk the old disk's identifiers"
  local root_uuid boot_uuid efi_id root_label boot_label efi_label
  root_uuid=$(blkid -s UUID -o value "$ROOT_DEV"); root_label=$(blkid -s LABEL -o value "$ROOT_DEV")
  boot_uuid=$(blkid -s UUID -o value "$BOOT_DEV"); boot_label=$(blkid -s LABEL -o value "$BOOT_DEV")
  efi_id=$(blkid -s UUID -o value "$EFI_DEV" | tr -d -); efi_label=$(blkid -s LABEL -o value "$EFI_DEV")
  e2fsck -fy "$(part 1)" >/dev/null 2>&1 || true
  e2fsck -fy "$(part 16)" >/dev/null 2>&1 || true
  tune2fs -U "$root_uuid" -L "$root_label" "$(part 1)" >/dev/null
  tune2fs -U "$boot_uuid" -L "$boot_label" "$(part 16)" >/dev/null
  if [ "$(blkid -s TYPE -o value "$EFI_DEV")" = vfat ]; then
    # The ESP is tiny: rebuild it with the old volume id and label, then copy its files back in.
    local tmp; tmp=$(mktemp -d)
    mount --bind "$SRC/boot/efi" "$tmp"
    mkfs.vfat -F 32 -i "$efi_id" -n "$efi_label" "$(part 15)" >/dev/null
    mkdir -p "$tmp.new"; mount "$(part 15)" "$tmp.new"
    rsync -rt "$tmp/" "$tmp.new/"
    umount "$tmp.new" "$tmp"; rmdir "$tmp.new" "$tmp"
  else
    e2fsck -fy "$(part 15)" >/dev/null 2>&1 || true
    tune2fs -U "$(blkid -s UUID -o value "$EFI_DEV")" -L "$efi_label" "$(part 15)" >/dev/null
  fi
  sgdisk -U "$(disk_guid "$SRC_DISK")" \
         -u "1:$(guid "$SRC_DISK" 1)" -u "15:$(guid "$SRC_DISK" 15)" -u "16:$(guid "$SRC_DISK" 16)" "$TGT" >/dev/null
  e2fsck -fn "$(part 1)" >/dev/null 2>&1 && e2fsck -fn "$(part 16)" >/dev/null 2>&1 || die "filesystem check failed on the new disk"

  say "Check"
  local ok=1
  for n in 1 15 16; do
    a=$(guid "$SRC_DISK" "$n"); b=$(guid "$TGT" "$n")
    printf 'partition %-2s  %s  %s\n' "$n" "$a" "$([ "$a" = "$b" ] && echo same || { ok=0; echo DIFFERENT; })"
  done
  for pair in "$ROOT_DEV:$(part 1)" "$BOOT_DEV:$(part 16)" "$EFI_DEV:$(part 15)"; do
    a=$(blkid -s UUID -o value "${pair%%:*}")/$(blkid -s LABEL -o value "${pair%%:*}")
    b=$(blkid -p -s UUID -o value "${pair##*:}" 2>/dev/null || blkid -s UUID -o value "${pair##*:}")/$(blkid -p -s LABEL -o value "${pair##*:}" 2>/dev/null || blkid -s LABEL -o value "${pair##*:}")
    printf 'filesystem   %-40s %s\n' "$a" "$([ "$a" = "$b" ] && echo same || { ok=0; echo "DIFFERENT ($b)"; })"
  done
  [ "$ok" = 1 ] || die "identifiers don't match; don't swap the disks. Start Docker again: sudo systemctl start docker"
  cat <<EOF

Ready. Next (runbook 0b):
  sudo poweroff
  AWS: snapshot the old root volume; detach it and $TGT's volume; attach the new volume as the
       root device name; start the instance; run: sudo bash /opt/kritvia/infra/scripts/shrink-root.sh verify
Don't reboot with both disks attached (they now share identifiers).
EOF
}

verify() {
  say "Disk"
  lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINT | grep -v loop
  df -h / | tail -1
  swapon --show
  say "Kritvia"
  curl -fsS -m 5 -o /dev/null -w "api readyz %{http_code}\n" http://localhost:8000/readyz || echo "api not answering yet (wait a minute)"
  docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | sort || true
}

case "$CMD" in
  copy) copy ;;
  final) final ;;
  verify) verify ;;
  *) die "usage: sudo bash shrink-root.sh copy|final <new disk, e.g. /dev/nvme1n1> | verify" ;;
esac
