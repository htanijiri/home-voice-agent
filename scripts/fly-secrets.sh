#!/bin/bash
# server/.env とサービスアカウントの鍵を、Fly.io の秘密情報に登録する。値は画面に出さない。
#   cd server && ../scripts/fly-secrets.sh <app>
set -euo pipefail
APP="${1:?app の名前を指定してください}"
cd "$(dirname "$0")/../server"
[ -f .env ] || { echo "server/.env がありません" >&2; exit 1; }
KEY_FILE="data/secrets/google-sa.json"
[ -f "$KEY_FILE" ] || { echo "$KEY_FILE がありません" >&2; exit 1; }
{
  grep -E '^(ANTHROPIC_API_KEY|GOOGLE_CLOUD_PROJECT|GOOGLE_OAUTH_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET|WEB_ALLOWED_EMAILS)=' .env
  # JSON は1行にして渡す
  printf 'GOOGLE_CREDENTIALS_JSON=%s\n' "$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$KEY_FILE")"
} | fly secrets import --app "$APP" --stage
echo "登録しました（次の fly deploy で反映されます）。登録した名前の一覧："
fly secrets list --app "$APP" | awk '{print $1}'
