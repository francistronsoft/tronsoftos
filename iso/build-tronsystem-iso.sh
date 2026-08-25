#!/usr/bin/env bash
set -euo pipefail

BASE_ISO="${1:-}"
OUT_ISO="${2:-tronsystem-debian13.iso}"
OUT_DIR="$(cd "$(dirname "$OUT_ISO")" && pwd)"
WORK_DIR="${WORK_DIR:-$OUT_DIR/.tronsystem-iso-build}"
DOCKER_BUNDLE="${TRONSYSTEM_DOCKER_BUNDLE:-}"
INCLUDE_DOCKER_BUNDLE="${TRONSYSTEM_INCLUDE_DOCKER_BUNDLE:-true}"

if [ -z "$BASE_ISO" ] || [ ! -f "$BASE_ISO" ]; then
  echo "Uso: $0 /caminho/debian-13.iso [saida.iso]" >&2
  exit 64
fi

for cmd in xorriso rsync sed sha256sum tar; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Comando obrigatorio nao encontrado: $cmd" >&2
    exit 65
  }
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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
if [ "$INCLUDE_DOCKER_BUNDLE" = "false" ] || [ "$INCLUDE_DOCKER_BUNDLE" = "0" ]; then
  echo "Aviso: bundle Docker desabilitado; ISO fara pull/build das imagens na instalacao." >&2
elif [ -n "$DOCKER_BUNDLE" ] && [ -f "$DOCKER_BUNDLE" ]; then
  install -m 0644 "$DOCKER_BUNDLE" "$WORK_DIR/iso/tronsystem-docker-images.tar"
elif [ -f "$SCRIPT_DIR/tronsystem-docker-images.tar" ]; then
  install -m 0644 "$SCRIPT_DIR/tronsystem-docker-images.tar" "$WORK_DIR/iso/tronsystem-docker-images.tar"
else
  echo "Aviso: bundle Docker nao informado; ISO fara pull/build das imagens na instalacao." >&2
fi
tar \
  --exclude-vcs \
  --exclude='./frontend/node_modules' \
  --exclude='./frontend/dist' \
  --exclude='./apps/tronfire/backend/node_modules' \
  --exclude='./apps/tronfire/worker/node_modules' \
  --exclude='./apps/tronfire/backend/prisma/dev.db' \
  --exclude='./apps/tronfire/frontend/node_modules' \
  --exclude='./apps/tronfire/frontend/dist' \
  --exclude='./agent-windows/installer-win-x64' \
  --exclude='./agent-windows/installer-output' \
  --exclude='./iso/tronsystem-docker-images.tar' \
  --exclude='./iso/tronsystem-source.tar.gz' \
  --exclude='./state' \
  --exclude='./logs' \
  -czf "$WORK_DIR/iso/tronsystem-source.tar.gz" \
  -C "$REPO_ROOT" .

if [ -d "$WORK_DIR/iso/install.amd" ]; then
  find "$WORK_DIR/iso/install.amd" -name initrd.gz -type f | while read -r initrd; do
    initrd_work="$WORK_DIR/initrd-$(printf '%s' "$initrd" | sha256sum | awk '{print $1}')"
    rm -rf "$initrd_work"
    mkdir -p "$initrd_work"
    (
      cd "$initrd_work"
      gzip -dc "$initrd" | cpio -id --quiet
      install -m 0644 "$WORK_DIR/iso/preseed.cfg" preseed.cfg
      find . | cpio -o -H newc --quiet | gzip -9 > "$initrd"
    )
  done
fi

find "$WORK_DIR/iso" -type f -name '*.cfg' -o -name 'txt.cfg' -o -name 'grub.cfg' | while read -r cfg; do
  sed -i 's/---/auto=true priority=critical file=\/preseed.cfg ---/g' "$cfg" || true
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
