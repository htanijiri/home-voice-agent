# アカウントと秘密情報の準備

このプロジェクトで使う外部サービスの準備手順です。**ここで作るキーや鍵は秘密情報なので、チャットに貼ったり、リポジトリに入れたりしないでください。** 書き込み先は、gitignore 済みの `server/.env` と `server/data/secrets/` だけです。

| いつまでに | 何を |
|---|---|
| 001（音声会話）の前 | 1. Anthropic、2. Google Cloud（音声認識・音声合成） |
| 005（確認画面）の前 | 3. Google ログインの設定、4. 許可する家族のメールアドレス |
| 006（クラウド運用）の前 | 5. Fly.io |

---

## 1. Anthropic（Claude）
1. https://console.anthropic.com にログインする（アカウントがなければ作る）。
2. **Billing** で支払い方法を登録し、クレジットを購入する（少額で足ります）。
3. **Limits**（利用上限）で、月の上限を設定する（例：10 ドル）。想定外の請求を防ぐためです。
4. **API Keys** で「Create Key」を押し、名前（例：`home-voice-agent`）を付けてキーを作る。
5. 表示されたキーを `server/.env` の `ANTHROPIC_API_KEY=` の後ろに貼り付ける（キーは作成時に一度しか表示されません）。

## 2. Google Cloud（音声認識・音声合成）
1. https://console.cloud.google.com にログインし、上部のプロジェクト選択から「新しいプロジェクト」を作る（例：`home-voice-agent`）。
2. **お支払い（Billing）** で、このプロジェクトに請求先アカウントを紐づける（初めての場合は作成する）。
3. **予算とアラート** で予算を作る（例：月 1,000 円、50%・90%・100% で通知）。
4. **API とサービス → ライブラリ** で、次の2つを検索して「有効にする」を押す。
   - Cloud Speech-to-Text API
   - Cloud Text-to-Speech API
5. **IAM と管理 → サービスアカウント** で「サービスアカウントを作成」を押す。
   - 名前：`voice-server`（任意）
   - ロール：「Cloud Speech クライアント」（Cloud Speech Client）と「Service Usage ユーザー」（Service Usage Consumer）
6. 作ったサービスアカウントを開き、**鍵 → 鍵を追加 → 新しい鍵を作成 → JSON** を選ぶ。JSON ファイルがダウンロードされる。
7. ダウンロードした JSON ファイルを `server/data/secrets/google-sa.json` という名前で置く（フォルダがなければ作る）。
8. `server/.env` の `GOOGLE_CLOUD_PROJECT=` に、プロジェクト ID（プロジェクト名の下に出る英数字）を書く。

## 3. Google ログインの設定（確認画面用、005 の前）
1. Google Cloud の同じプロジェクトで、**API とサービス → OAuth 同意画面** を開く。
   - ユーザーの種類：外部
   - アプリ名：`home-voice-agent`（任意）
   - サポートのメール：自分のアドレス
   - 公開ステータスは「テスト」のままでよい。**テストユーザー** に、ログインを許可する家族の Google アカウントを追加する
2. **認証情報 → 認証情報を作成 → OAuth クライアント ID** を選ぶ。
   - 種類：ウェブ アプリケーション
   - 承認済みのリダイレクト URI：`http://localhost:8080/auth/callback`（006 でクラウドの URL を追加します）
3. 表示されたクライアント ID とシークレットを、`server/.env` の `GOOGLE_OAUTH_CLIENT_ID=` と `GOOGLE_OAUTH_CLIENT_SECRET=` に書く。

## 4. 許可する家族のメールアドレス（005 の前）
- `server/.env` の `WEB_ALLOWED_EMAILS=` に、カンマ区切りで書く（例：`a@example.com,b@example.com`）。

## 5. Fly.io（006 の前）
1. https://fly.io でアカウントを作り、クレジットカードを登録する。
2. Mac のターミナルで次を実行し、開いたブラウザでログインする（flyctl は Claude が入れておきます）。

```bash
fly auth login
```

3. 秘密情報の登録は、006 で Claude が用意するコマンドを実行してもらいます（値は Claude には見えません）。
