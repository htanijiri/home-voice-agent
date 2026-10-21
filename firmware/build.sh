#!/bin/bash
# xiaozhi-esp32 を固定のバージョンで取得し、パッチと設定を重ねてビルドする。
# 元のソースは firmware/.build/ に置き、リポジトリには入れない。
set -euo pipefail
cd "$(dirname "$0")"
FW_DIR="$PWD"
source ./xiaozhi.lock
[ -f config.env ] || { echo "firmware/config.env がありません（config.env.example をコピーして作る）" >&2; exit 1; }
source ./config.env
# 接続先だけを変えてビルドするとき（例：クラウド用）。OTA_URL_OVERRIDE=https://<app>.fly.dev/xiaozhi/ota/ ./build.sh
OTA_URL="${OTA_URL_OVERRIDE:-$OTA_URL}"

SRC="$FW_DIR/.build/xiaozhi-esp32"
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 -b "$XIAOZHI_TAG" "$XIAOZHI_REPO" "$SRC"
fi
cd "$SRC"
actual="$(git rev-parse HEAD)"
[ "$actual" = "$XIAOZHI_COMMIT" ] || { echo "コミットが違います: $actual" >&2; exit 1; }

# 毎回きれいな状態に戻してからパッチを当てる（ビルド成果物とダウンロード済みの部品は残す）
git reset -q --hard
git clean -q -fd -e build -e managed_components -e dependencies.lock -e releases
for p in "$FW_DIR"/patches/*.patch; do
  [ -e "$p" ] || continue
  echo "パッチ: $(basename "$p")"
  git apply "$p"
done

# 版を「公式の版.自作ビルドの番号」にする（Wi-Fi 経由の更新で、新しい版と判断させるため）
FW_VERSION="${XIAOZHI_TAG#v}.${HVA_BUILD}"
sed -i '' -E "s/set\(PROJECT_VER \"[^\"]+\"\)/set(PROJECT_VER \"$FW_VERSION\")/" CMakeLists.txt
grep -q "PROJECT_VER \"$FW_VERSION\"" CMakeLists.txt || { echo "版を書き換えられませんでした" >&2; exit 1; }

# esp-sr の版上げ（アイリスのため）
sed -i '' -E "s/(espressif\/esp-sr: *)==[0-9.]+/\1==$ESP_SR_VERSION/" main/idf_component.yml
grep -q "esp-sr: ==$ESP_SR_VERSION" main/idf_component.yml || { echo "esp-sr の版を書き換えられませんでした" >&2; exit 1; }

# 板の設定に OTA URL を足した設定ファイルを作る
BOARD_DIR="$(dirname "$(find main/boards -path "*/$BOARD/config.json" | head -1)")"
OTA_URL="$OTA_URL" python3 - "$BOARD_DIR" <<'PY'
import json, os, sys
d = sys.argv[1]
cfg = json.load(open(f"{d}/config.json", encoding="utf-8"))
for b in cfg["builds"]:
    b["sdkconfig_append"] = b.get("sdkconfig_append", []) + [
        f'CONFIG_OTA_URL="{os.environ["OTA_URL"]}"',
        # 呼びかけた声（ウェイクワードの部分）をサーバーに送らず、端末で聞き取り開始の音を鳴らす
        "CONFIG_SEND_WAKE_WORD_DATA=n",
    ]
json.dump(cfg, open(f"{d}/config.local.json", "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY

# shellcheck disable=SC1091
source "$IDF_PATH/export.sh" >/dev/null
python3 scripts/build.py "$BOARD" -c config.local.json --name "$(basename "$BOARD")" --language "$LANGUAGE" --wake-word "$WAKE_WORD"

# 書き込みに使うファイル一式（flash_args に書かれた領域ごとのバイナリ）を out/ と archive/<版>/ に置く
OUT="$FW_DIR/.build/out"
rm -rf "$OUT" && mkdir -p "$OUT"
(cd build && cp flash_args "$OUT/" && tail -n +2 flash_args | awk '{print $2}' | while read -r f; do mkdir -p "$OUT/$(dirname "$f")"; cp "$f" "$OUT/$f"; done)
cp build/merged-binary.bin "$OUT/" 2>/dev/null || true
cp sdkconfig "$OUT/sdkconfig"
echo "$FW_VERSION" > "$OUT/version.txt"
mkdir -p "$FW_DIR/.build/archive"
rm -rf "$FW_DIR/.build/archive/$FW_VERSION" && cp -R "$OUT" "$FW_DIR/.build/archive/$FW_VERSION"
echo "ビルド完了: $OUT（版 $FW_VERSION）"
