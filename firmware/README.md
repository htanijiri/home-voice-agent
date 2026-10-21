# firmware：端末（AtomS3R＋Echo Pyramid）のソフト

M5Stack 公式の Xiaozhi（[xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)、MIT）を、固定した版で取得し、このフォルダの設定と小さなパッチを重ねてビルドする。元のソースは `.build/`（gitignore）に取得し、リポジトリには入れない。

| ファイル | 中身 |
|---|---|
| `xiaozhi.lock` | 取得する版（タグとコミット）、ESP-IDF と esp-sr の版、板の種類、自作ビルドの番号 |
| `config.env.example` | 端末ごとの設定（OTA の URL、シリアルポートなど）の例。`config.env` にコピーして使う |
| `patches/` | 元のソースへの変更（wn10 のウェイクワード名の許可、ボタン長押しのマイクオフ） |
| `build.sh` / `flash.sh` | ビルドと書き込み |
| `tools/serial_log.py` | シリアルログを決まった秒数だけ読む |

## 準備
- ESP-IDF v6.1 を `~/esp/esp-idf-v6.1` に入れる（`git clone -b v6.1 --recursive https://github.com/espressif/esp-idf.git` → `./install.sh esp32s3`）。
- `brew install cmake ninja dfu-util ccache`
- `cp config.env.example config.env` して、OTA の URL とシリアルポートを書く。

## ビルドと書き込み
```bash
./build.sh
```

```bash
./flash.sh
```

- 端末は、Echo Pyramid の底面の USB-C に給電し、AtomS3R の USB-C を Mac につなぐ。
- 初回は端末が Wi-Fi 設定モードになる。スマホで端末の Wi-Fi（`Xiaozhi-XXXX`）に接続し、`http://192.168.4.1` で家の Wi-Fi を設定する。
  - 端末は **2.4GHz の Wi-Fi にしかつながらない**（5GHz の名前は一覧に出ない）。
  - スマホが「インターネットに接続されていません」と出しても、設定が終わるまで接続したままにする。
- Wi-Fi 設定モードで画面のボタンを押すと録音、もう一度押すと再生する（マイクとスピーカーの確認）。

## 元に戻す
- **前のビルドに戻す**：`build.sh` は版ごとの書き込み用ファイル一式を `.build/archive/<版>/` に残す。書き込みは領域ごとに行うので、Wi-Fi の設定と承認の情報は残る（全部消したいときは `./flash.sh --erase-all`）。

```bash
./flash.sh .build/archive/<版>
```

- **公式の Xiaozhi に戻す**：M5Burner で「ATOMS3」の Xiaozhi（Voice Pyramid 用）を選んで書き込む。この場合の接続先は xiaozhi.me になる（このプロジェクトでは使わない）。
- **書き込みが失敗して起動しないとき**：AtomS3R のリセットボタンを約2秒押し続けて、緑の LED が点いたら離す（書き込みモード）。そのあと `./flash.sh` で書き直す。
