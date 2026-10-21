# 技術ノート：home-voice-agent

実装してわかったこと・ハマったことを、あとで記事や別プロジェクトで使える形で残す。
仕様書が完了したら、得られた知見をここに還元する。

## 1. 技術選定

### 端末：Xiaozhi（xiaozhi-esp32）を採用、ESPHome＋Home Assistant は不採用
| 観点 | Xiaozhi（採用） | ESPHome＋Home Assistant |
|---|---|---|
| 接続の向き | 端末からサーバーへ外向きに接続する（WebSocket、または MQTT＋UDP）。クラウドのサーバーと直接話せる | Home Assistant が LAN 内の端末に接続しに行く（ESPHome Native API）。家の中に Home Assistant が必要 |
| ウェイクワード | ESP-SR の WakeNet。日本語モデル（`wn10_ja_airisu`＝アイリス、`ja_konnichihaesp`）がある | micro_wake_word。標準モデルは英語のみ（okay_nabu など） |
| 連続会話 | 読み上げ後に聞き取りへ戻る自動モードがある | 対応はあるが Home Assistant 側の設定に依存 |
| サーバーからの通知 | `notify` メッセージ（Ogg Opus の URL を再生）。MQTT の常時接続が必要 | Home Assistant のアナウンス機能 |
| この機種への対応 | `main/boards/m5stack/atoms3r-echo-pyramid` が公式にある | M5Stack 公式の YAML がある |
| ライセンス | MIT | — |

- 固定するバージョンは **xiaozhi-esp32 v2.5.2**（2026-10-11 リリース）。
- v2.5.2 の `idf_component.yml` が使う `espressif/esp-sr` は ==2.4.7 で、`wn10_ja_airisu` が入っていない。CHANGELOG によると、このモデルは 2.5.4 で追加された（2.5.4 は取り下げられたため、2.5.5 以降を使う）。2.5.5 では AFE のインターフェースも変わっているため、ビルドが通るかと動作は 000 で確認する。
- 板の種類は `atoms3r-echo-pyramid`。Flash は 8MB、PSRAM は Octal、パーティションは `partitions/v2/8m.csv`。通常の運用時は Pyramid 側の USB-C から給電し、AtomS3R 側の USB-C は書き込みに使う。
- ボタンは AtomS3R の画面ボタン（`boot_button_`）だけ。v2.5.2 では、クリックで会話を開始・終了する（`ToggleChatState`）。長押しは使っていない。

### サーバー：TypeScript / Node.js
- 音声のストリーミング、WebSocket、MQTT ブローカー（aedes）、UDP（`node:dgram`）、Anthropic・Google の公式 SDK が1つの言語でそろう。
- 会話のコア（オーケストレーター、ツール、時刻の解釈）は、通信方式と外部サービスから切り離して単体テストする。

### 音声認識・音声合成：Google Cloud（Speech-to-Text v2 / Text-to-Speech）
- 音声合成は日本語の自然さを重視して Chirp 3 HD 系の音声にする。出力を Ogg Opus にでき、端末の `notify`（Ogg Opus を再生する）とそのまま組み合わせられる。
- 不採用：
  - OpenAI：日本語の読み上げに外国語なまりが出ることがある
  - Azure：アカウントが増える
  - VOICEVOX：自前で音声合成サーバーを動かす費用がかかる

### LLM：Claude Haiku 5.5（`claude-haiku-5-5`）
- 料金は入力 $0.10、出力 $0.50（いずれも 100 万トークンあたり。10 万トークン以下のプロンプトの場合。2026-10 時点）。家庭の利用量なら月数十円の見込み。
- モデル名は設定ファイルで変えられるようにする。料金と SDK の仕様は、実装時に公式情報で確認し直す。

### 置き場所：Fly.io（東京 `nrt`）
- 1台のマシンを常時起動し、SQLite はボリュームに置く。
- MQTT（TCP＋TLS）と UDP を受けられる。UDP を受けるには専用の IPv4 アドレスが必要。
- 不採用：
  - Cloudflare Workers：UDP と生の TCP を受けられず、Xiaozhi の通知に必要な常時接続ができない
  - Cloud Run：UDP がない
  - VPS：OS の管理が必要

## 2. アーキテクチャ
```
端末（Xiaozhi）
  ├─ 起動時：HTTPS POST /xiaozhi/ota/ → 承認済みなら接続先とトークン（未承認なら6桁の番号）
  ├─ MQTT（常時接続）：hello / listen / abort / goodbye / mcp ⇄ stt / tts / llm / notify / mcp
  └─ UDP（会話中）：Opus（16kHz・60ms）を AES-128-CTR で暗号化。下りは 24kHz・60ms
サーバー（server/）
  transports/xiaozhi（OTA・WebSocket・MQTT＋UDP）→ app/hub（端末ごとのセッション）
  → core/voice-session（聞き取り → STT → オーケストレーター → TTS）
  → core/orchestrator（Claude ＋ツール：音量・買い物リスト・リマインダー）
  app/reminder-scheduler（10秒ごと。時刻が来たら notify。音声は /notify/audio/<トークン>.ogg で1回だけ配る）
  web/（確認画面：Google ログイン、API）
  db/（SQLite：devices, turns, usage, kv, shopping_items, reminders, reminder_deliveries, web_sessions）
```
- 会話のコア（`core/`）は通信方式と外部サービスに依存しない。外部サービスは `adapters/` だけが SDK を使う。

## 3. ハマりどころと対処
- **アイリスでビルドできない**
  - 症状：`Invalid wake word 'wn10_ja_airisu'`
  - 原因：xiaozhi の `scripts/build.py` が、モデル名を `^wn9[sl]?_` しか受け付けない
  - 対処：正規表現を wn10 も許すパッチを当てた。esp-sr は 2.4.7 → 2.6.0 に上げ、ビルドは問題なく通った
- **`idf.py flash` が止まる**
  - 症状：「project was configured with .../python3」と出て、再ビルドを始める
  - 対処：esptool で直接書き込む
- **1つにまとめたバイナリを書くと、Wi-Fi の設定と承認が消える（気づいて回避）**
  - 原因：`merged-binary.bin` は 0x0 から始まる連続したイメージで、途中の NVS（0x9000〜、Wi-Fi の設定・Client-Id・マイクオフの状態）を 0xFF で上書きする
  - 対処：`build/flash_args` に書かれた領域（ブートローダー・パーティション表・otadata・アプリ・assets）だけを書き込む（`write-flash @flash_args`）。書き直したあとも Wi-Fi の設定と承認が残ることを、実機で確かめた
- **MQTT の再接続**
  - 内容：サーバーを止めると端末は再接続を試み続け、戻ってから約1分でつながる（`MQTT_RECONNECT_INTERVAL_MS`）。リマインダーは、つながった時点で2時間ルールに従って送られる
- **クラウドに向けた偽の端末の UDP が届かない（テスト用の道具の問題）**
  - 症状：MQTT（TLS）はつながるのに「聞き取れませんでした」。クラウドのサーバーには UDP のパケットが1つも届いていなかった（\`/proc/net/udp\` で待ち受けは確認済み）
  - 原因：偽の端末が UDP を 127.0.0.1 で開いていたため、外へ送れなかった
  - 対処：送り先がローカルでなければ 0.0.0.0 で開く
- **Fly.io の UDP**：専用の IPv4 が必要。アプリは \`fly-global-services\` の住所で待ち受ける（\`UDP_BIND_HOST\`）。この2つで、端末の UDP の音声が届いた
- **端末の HTTPS の取得は遅い**：notify の音声を HTTPS で取りに行くとき、ESP32-S3 の TLS の接続に約 3.3 秒かかった
- **端末の音量の数字は dB に等間隔（音が出ない、と思ったら小さすぎた）**
  - 症状：クラウドに移したあと、返事の文字は出るのに声が聞こえない。端末の中で鳴らす「ポン」も、リマインダーも聞こえない
  - 原因：esp_codec_dev の既定の音量の割り当ては「0〜100 → -50〜0dB」の直線。「声が大きい」と言われた 70（-15dB）から 45（-27.5dB）に下げた結果、12.5dB 小さくなり、ほとんど聞こえなくなっていた。夜間の 40（-30dB）も同じ。キーなしモードで聞こえていたのは 70 のときだけだった
  - 調べ方：NVS の output_volume を読み出して 45 を確認し、esp_codec_dev の \`_get_default_vol_curve\` で割り当てを確かめた
  - 対処：声の段階を 37〜100 に割り当て直し、昼 65・夜間 50 にした。サーバーから音量を指定するコマンドを足した
- **補足とユーザーの発話が、つながって読まれる**
  - 症状：「日本で一番高い山は?」に、「買い物リストに『洗剤日本で一番高い山は?』が入っています」と答えた（そんな品目はない）
  - 原因：補足（「現在の買い物リスト：食パン、洗剤」）とユーザーの発話を、別々の text のかたまりで渡していた。モデルには区切りなくつながって見えた
  - 対処：1つの文にまとめ、【補足】【ユーザーの発話】の見出しで分け、品名は「」で囲む。プロンプトに「関係のない返事で買い物リストの話をしない」を足した（評価 5/5）
- **ウェイクワードを Mac の読み上げで試す**
  - 内容：macOS の `say -v Kyoko "アイリス"` で反応した。ただし Mac の音量が 21% で離れていると反応せず、46% で近づけると1回目で反応した。人の声と距離は 007 で測る
- **バイナリに「BEGIN PRIVATE KEY」の文字列がある**
  - 原因：mbedTLS が PEM の見出しを判定するための定数で、鍵そのものではない
  - 対処：秘密情報の検査では、見出しではなく鍵の本体を探す
- **端末は MQTT のトピックを購読しない**
  - 内容：xiaozhi の MqttProtocol は Subscribe を呼ばない（公式のサーバーはブローカー側で届ける）
  - 対処：aedes の `client.publish` で、接続ごとに直接届ける
- **UDP の最後の音声が捨てられる（テストで発覚）**
  - 原因：MQTT（TCP）の「tts stop」が、UDP の最後の音声より先に着いた。端末は読み上げ中の状態でしか音声を受け取らない
  - 対処：送り終えてから最低 100ms 空けて stop を送る
- **サーバーの停止が終わらない**
  - 原因：会話の途中で止めると、端末との WebSocket の接続が残り、`http.close()` が待ち続ける
  - 対処：停止時に `wss.clients` を terminate し、`closeAllConnections()` を呼ぶ
- **確認画面の「買った」「削除」が 400 になる**
  - 原因：Fastify は `Content-Type: application/json` で本文が空のものを拒否する
  - 対処：空の本文を `{}` として受け付ける
- **フォームの非表示の欄が出たまま**
  - 原因：`.field { display:flex }` が `hidden` 属性に勝つ
  - 対処：`[hidden] { display:none !important }`
- **Claude Haiku 5.5 の thinking（2回方針を変えた）**
  - 1回目：thinking のブロックは、それより前の履歴・システム・ツールが変わると無効になる（2026-08-31 以降に作ったアカウントでは 400）。履歴を切り詰める設計なので、thinking をオフにした
  - 問題：評価で、返事に「The list already contains 卵, …」「Ask: the list is empty, …」「明日ではなく金曜日なので…」のような考えごとが混ざった（読み上げられてしまう）。プロンプトで禁じても、英字の文を読み上げ前に取り除いても、日本語の考えごとは防げなかった
  - 2回目：thinking をオン（adaptive、effort は low）にした。thinking のブロックはいまの返事の中（ツールの往復）でだけ元のまま返し、履歴に保存するときに外す。古い thinking のブロックを送らないので、履歴の切り詰めでもエラーにならない
  - 結果：評価はすべて合格し、返事も短くなった。最初の文が出るまで、ツールなしで 0.7〜0.9 秒、ツールありで 1.4〜3.3 秒
- **表記ゆれ（卵／たまご）の重複**
  - 症状：「卵」があるのに「たまご」を追加してから、「どちらか消しましょうか」と聞いた（0/5）
  - 原因：追加する前に、Claude がリストの中身を知らない
  - 対処：発話ごとの補足に「現在の買い物リスト」を添えた（10/10）。ツールの往復が増えないので遅くならない
- **Google STT v2 の場所とモデル**：ja-JP の chirp_3 は global にはなく、asia-northeast1 は権限エラー（一般提供が終わった旨）。us の chirp_3 は話し終わりの合図が来て、0.5 秒で結果が出た。global の short は合図が来ず遅い
- **会話を終えた直後の listen start**
  - 症状：無言で終わると、待機中の端末に「聞き取れませんでした」を繰り返した
  - 原因：tts stop のあと、端末が自動で聞き取りに戻って listen start を送る。そのあとサーバーの goodbye が届くが、サーバーは listen start を新しい会話として受けていた
  - 対処：音声のやり取りが閉じているとき（audioOpen でない）の listen と音声は無視する
- **返事の先頭の1〜2文字が聞こえない**（「買い物リストに…」が「ぃものリストに…」になる。画面の文字は正しい）
  - 原因（xiaozhi v2.5.2 の `application.cc`）：端末は tts start を受けると、メインループで「話し中」に切り替え、その状態の変化の処理で `ResetDecoder()` を呼んで再生待ちの音声を捨てる。また「話し中」でないときに届いた音声は受け取らない。サーバーは tts start の直後に最初の数フレーム（`sendPaced` の先送り分）をまとめて送っていたので、それが切り替えの前後で捨てられていた。MQTT（TCP）と UDP は別の経路なので、音声のほうが先に着くこともある
  - 対処：tts start から最初の音声を送るまで 200ms 待ち、先頭に 60ms の無音を足す（`config.toml` の `[tts] startDelayMs` / `leadingSilenceMs`）。最初の文だけで、2つめ以降の文には足さない。読み上げの開始は約 0.26 秒遅くなる
- **確認画面の自動更新（SSE）の落とし穴**
  - Fastify で `reply.hijack()` して SSE を書くとき、片付けを `req.raw.on("close")` で行うと、つないだ直後に購読が外れる。Node.js の `IncomingMessage` の close は本文を読み終えた時点で来るため。`res.on("close")` を使う
  - `EventSource` は、ネットワークの切断ならつながり直すが、200 以外の応答（デプロイ中の 502/503 など）では閉じたままになる。`readyState === CLOSED` を見て作り直す
  - Fly のプロキシのアイドル切断を避けるため、25 秒ごとにコメント行（`: ping`）を送る

## 4. 「効かなかったこと」リスト
<!-- 試したがうまくいかなかったこと。同じ失敗を繰り返さないために書く -->

## 5. 今後の課題
