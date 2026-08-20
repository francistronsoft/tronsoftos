#!/usr/bin/env bash
set -euo pipefail

BASE_ISO="${1:-}"
OUT_ISO="${2:-tronsystem-debian13.iso}"
WORK_DIR="${WORK_DIR:-/tmp/tronsystem-iso-build}"

if [ -z "$BASE_ISO" ] || [ ! -f "$BASE_ISO" ]; then
  echo "Uso: $0 /caminho/debian-13.iso [saida.iso]" >&2
  exit 64
fi

for cmd in xorriso rsync sed sha256sum; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Comando obrigatorio nao encontrado: $cmd" >&2
    exit 65
  }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/mnt" "$WORK_DIR/iso"

mount -o loop "$BASE_ISO" "$WORK_DIR/mnt"
trap 'umount "$WORK_DIR/mnt" >/dev/null 2>&1 || true' EXIT
rsync -a "$WORK_DIR/mnt/" "$WORK_DIR/iso/"
chmod -R u+w "$WORK_DIR/iso"
umount "$WORK_DIR/mnt"
trap - EXIT

install -m 0644 "$SCRIPT_DIR/preseed-tronsystem.cfg" "$WORK_DIR/iso/preseed.cfg"
install -m 0755 "$SCRIPT_DIR/tronsystem-late-command.sh" "$WORK_DIR/iso/tronsystem-late-command.sh"

if [ -d "$WORK_DIR/iso/install.amd" ]; then
  mkdir -p "$WORK_DIR/initrd"
  cd "$WORK_DIR/initrd"
  gzip -dc "$WORK_DIR/iso/install.amd/initrd.gz" | cpio -id --quiet
  install -m 0644 "$WORK_DIR/iso/preseed.cfg" preseed.cfg
  find . | cpio -o -H newc --quiet | gzip -9 > "$WORK_DIR/iso/install.amd/initrd.gz"
fi

find "$WORK_DIR/iso" -type f -name '*.cfg' -o -name 'txt.cfg' -o -name 'grub.cfg' | while read -r cfg; do
  sed -i 's/---/auto=true priority=critical file=\/cdrom\/preseed.cfg ---/g' "$cfg" || true
done

(
  cd "$WORK_DIR/iso"
  find . -type f -print0 | xargs -0 md5sum > md5sum.txt
)

xorriso -as mkisofs \
  -r -V "TRONSYSTEM_D13" \
  -o "$OUT_ISO" \
  -J -joliet-long -cache-inodes \
  -isohybrid-mbr /usr/lib/ISOLINUX/isohdpfx.bin \
  -b isolinux/isolinux.bin -c isolinux/boot.cat \
  -boot-load-size 4 -boot-info-table -no-emul-boot \
  -eltorito-alt-boot -e boot/grub/efi.img -no-emul-boot -isohybrid-gpt-basdat \
  "$WORK_DIR/iso"

sha256sum "$OUT_ISO" > "${OUT_ISO}.sha256"
echo "ISO gerada: $OUT_ISO"
cat "${OUT_ISO}.sha256"
