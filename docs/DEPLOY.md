# home-voice-agent デプロイ手順書

## 0. 全体像と前提
- サーバーは Fly.io の東京リージョン（`nrt`）で、マシン1台を常時動かす。データ（SQLite）はボリューム `hva_data`（`/data`）に置く。
- 端末とは次の4つの口でつながる。

| 口 | 外から見たポート | 中身 |
|---|---|---|
| HTTPS | 443 | OTA の設定、確認画面、通知の音声、ファームウェアの配布、WebSocket |
| MQTT over TLS | 8883 | 端末との常時接続（通知と会話の制御）。TLS は Fly のプロキシで終わり、アプリには平文の TCP（1883）で届く |
| UDP | 8884 | 会話の音声（Xiaozhi の AES-CTR で暗号化） |
| HTTP | 80 | HTTPS へ転送するだけ |

- UDP を受けるには専用の IPv4 アドレスが必要。アプリは `fly-global-services` で UDP を待ち受ける（`UDP_BIND_HOST`）。
- ローカルに必要なもの：`flyctl`（`brew install flyctl`）と、`fly auth login` でログイン済みであること。

## 1. 設定値・シークレット
値はここには書かない。秘密情報は `fly secrets` で登録し、それ以外は `fly.toml` の `[env]` に書く。

| 名前 | 用途 | 登録先 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude の API キー | fly secrets |
| `GOOGLE_CLOUD_PROJECT` | Google Cloud のプロジェクト ID | fly secrets |
| `GOOGLE_CREDENTIALS_JSON` | サービスアカウントの鍵（JSON の中身） | fly secrets |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | 確認画面の Google ログイン | fly secrets |
| `WEB_ALLOWED_EMAILS` | ログインを許可するメールアドレス | fly secrets |
| `PUBLIC_BASE_URL` | `https://<app>.fly.dev` | fly.toml |
| `MQTT_PUBLIC_ENDPOINT` | `<app>.fly.dev:8883` | fly.toml |
| `UDP_PUBLIC_HOST` | 専用の IPv4 アドレス | fly.toml |
| `DEVICE_TRANSPORT` | `mqtt` | fly.toml |

## 2. 初回の準備（1回だけ）
```bash
cd server
fly apps create <app>                       # 例：home-voice-agent-xxxx（全体で重複しない名前）
fly ips allocate-v4 --app <app>             # UDP に必要な専用の IPv4（有料）
fly ips allocate-v6 --app <app>
fly volumes create hva_data --region nrt --size 1 --app <app>
```
- `fly.toml` をコピーして `fly.local.toml`（gitignore 済み）を作り、`app`、`PUBLIC_BASE_URL`、`MQTT_PUBLIC_ENDPOINT`、`UDP_PUBLIC_HOST`（`fly ips list` の IPv4）を書き換える。公開リポジトリに自宅のサーバーの URL を載せないため。
- 秘密情報の登録は、ユーザーが Mac のターミナルで行う（値は画面に出さない）。

```bash
cd server && ../scripts/fly-secrets.sh <app>
```

- Google Cloud の OAuth クライアントの「承認済みのリダイレクト URI」に `https://<app>.fly.dev/auth/callback` を追加する。

## 3. デプロイ
```bash
cd server && npm test && fly deploy -c fly.local.toml
```

## 4. デプロイ後の動作確認
- [ ] `curl https://<app>.fly.dev/healthz` が `{"ok":true,...}` を返す
- [ ] `openssl s_client -connect <app>.fly.dev:8883 </dev/null` で TLS がつながる
- [ ] 偽の端末で、クラウドに向けた会話の往復ができる（`npm run fake-device -- --base https://<app>.fly.dev ...`。承認は `fly ssh console` から `npm run device:approve`）
- [ ] 実機がクラウドにつながり、会話・リマインダーの通知ができる

## 4.5 実際に確かめた結果（2026-10-21）
- デプロイは約1分（イメージ 91MB）。デプロイで MQTT が一度切れるが、端末は約 20 秒でつながり直す
- 外からの確認：HTTPS の `/healthz`、HTTP→HTTPS の転送（301）、8883 の TLS（`*.fly.dev`、検証 OK）、OTA の承認番号
- 偽の端末（MQTT の TLS＋UDP）で、本物の STT・Claude・TTS を通した2往復（文脈あり）
- 実機：Mac のサーバーから 2.5.2.2 を Wi-Fi 経由で配り（約 30 秒、ota_1 に書き込み）、クラウドで承認 → MQTT（TLS）で接続 → リマインダーの通知を再生
  - 端末が通知の音声を HTTPS で取りに行くとき、TLS の接続に約 3.3 秒かかる（そのぶん通知が遅れる）
- マシンの再起動の前後で、データの件数が同じ
- 手動のスナップショット（34MiB）→ 新しいボリュームに復元 → 一時的なマシンで件数が同じことを確認 → 片付け
- ロールバック：前のイメージで `fly deploy --image` → 正常 → 最新に戻した

## 5. 運用メモ
- 端末の承認：確認画面の「その他」→「端末」で、端末の画面に出た6桁の番号を入れる。コマンドなら：

```bash
fly ssh console --app <app> -C "node_modules/.bin/tsx src/cli/device-approve.ts <番号>"
```

- 試しのリマインダー：`fly ssh console --app <app> -C "node_modules/.bin/tsx src/cli/add-reminder.ts 120 テスト"`
- ファームウェアの Wi-Fi 経由の更新：`firmware/build.sh` で作った `xiaozhi.bin` を `/data/firmware/` に置き、`manifest.json`（`{"version":"2.5.2.N","file":"xiaozhi-2.5.2.N.bin"}`）を書く。端末は次の起動時に取りに来る。

```bash
fly ssh sftp shell --app <app>   # put で /data/firmware/ に置く
```

- ログ：`fly logs --app <app>`（会話の本文と音声はログに出さない）。
- 費用：Fly.io の請求は Fly.io の画面で確認する。目安は確認画面の「その他」→「今月の利用量」。

## 6. バックアップと復元
- ボリュームのスナップショットは毎日自動で取られ、5日分残る（`fly.toml` の `snapshot_retention`）。
- 一覧：`fly volumes snapshots list <volume-id> --app <app>`
- 復元：スナップショットから新しいボリュームを作り、マシンに付け替える。

```bash
fly volumes create hva_data --snapshot-id <snapshot-id> --region nrt --size 1 --app <app>
```

中身の確認だけなら、一時的なマシンで読む（確認したら、マシンとボリュームを消す）。

```bash
fly machine run <イメージ> --app <app> --region nrt --volume hva_restore_test:/data --restart no --entrypoint node -- -e '<件数を数えるコード>'
```

本当に切り替えるときは、古いボリュームを外して新しいボリュームでマシンを作り直す（`fly machine update <id> --mount ...`）。

## 7. ロールバック
```bash
fly releases --app <app>                    # 版の一覧
fly deploy --image <前の版のイメージ> --app <app>
```
