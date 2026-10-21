#!/bin/bash
# ビルドしたファームウェアを USB で書き込む。
#   ./flash.sh                     .build/out/ を書き込む
#   ./flash.sh .build/archive/<版>  前のビルドに戻す
#   ./flash.sh --erase-all         フラッシュ全体を消してから書き込む（Wi-Fi の設定・承認の情報も消える）
# flash_args に書かれた領域だけを書き込むので、NVS（Wi-Fi の設定・承認の ID・マイクオフの状態）は残る。
# 1つにまとめたバイナリ（merged-binary.bin）を先頭から書くと NVS まで消えるので、使わない。
# idf.py flash は再ビルドが走り、Python の環境の違いで止まることがあるため、esptool で直接書き込む。
set -euo pipefail
cd "$(dirname "$0")"
source ./config.env
ERASE=0
DIR="$PWD/.build/out"
for a in "$@"; do
  case "$a" in
    --erase-all) ERASE=1 ;;
    *) DIR="$(cd "$a" && pwd)" ;;
  esac
done
[ -f "$DIR/flash_args" ] || { echo "$DIR/flash_args がありません（先に ./build.sh）" >&2; exit 1; }
# shellcheck disable=SC1091
source "$IDF_PATH/export.sh" >/dev/null
cd "$DIR"
if [ "$ERASE" = 1 ]; then
  python -m esptool --chip esp32s3 -p "$PORT" erase-flash
fi
python -m esptool --chip esp32s3 -p "$PORT" -b 460800 write-flash @flash_args
