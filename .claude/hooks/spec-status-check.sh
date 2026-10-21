#!/bin/bash
# PostToolUse hook（Edit / Write）：docs/specs/ の仕様書と一覧（README.md）が編集されたら、状態の書き方を確認する。
#
# 状態は「ドラフト／合意済み／実装中／完了／見送り」のどれか1語だけ。日付や補足を足すと、
# 状態を機械的に読むプロジェクト管理のツールが「不明」として扱うため、ここで差し戻す。
#   - 仕様書（NNN-*.md）：最初の `- 状態：` の行が `- 状態：<5つの語のどれか>` だけになっているか
#   - 一覧（README.md）：一覧表の「状態」の列が、5つの語のどれかだけになっているか
# 決まった形でなければ、exit 2 で Claude に伝える（stderr が Claude に渡る）。
#
# 状態の語を増やす・変えるときは、docs/specs/README.md の運用ルールと、下の2か所（STATUSES と awk の中）を揃える。
# 正規表現の中で全角文字を [ ] に入れない（ロケールによってはバイト単位で比べられ、誤判定する）。

INPUT="$(cat)"
jq -e . >/dev/null 2>&1 <<<"$INPUT" || exit 0
FILE="$(jq -r '.tool_input.file_path // ""' <<<"$INPUT" 2>/dev/null)"

case "$FILE" in
  */docs/specs/*) ;;
  *) exit 0 ;;
esac
[ -f "$FILE" ] || exit 0

STATUSES='ドラフト|合意済み|実装中|完了|見送り'
ERRORS=()
NAME="$(basename "$FILE")"

if [[ "$NAME" =~ ^[0-9]{3}-.+\.md$ ]]; then
  # 状態を読むツールと同じく、最初に出てくる状態の行を対象にする
  LINE="$(grep -m1 -E '^[[:space:]]*[-*][[:space:]]*状態[[:space:]]*(：|:)' "$FILE")"
  if [ -z "$LINE" ]; then
    ERRORS+=("「- 状態：」の行がありません。")
  elif ! grep -qE "^- 状態：($STATUSES)[[:space:]]*\$" <<<"$LINE"; then
    ERRORS+=("状態の行：$LINE")
  fi
elif [ "$NAME" = "README.md" ]; then
  # 見出し行から「状態」の列を探し、番号（3桁）で始まる行のその列を確かめる
  while IFS= read -r bad; do
    [ -n "$bad" ] && ERRORS+=("一覧の $bad")
  done < <(awk '
    BEGIN { FS = "|" }
    function trim(s) { gsub(/^[ \t]+|[ \t\r]+$/, "", s); return s }
    col == 0 { for (i = 2; i <= NF; i++) if (trim($i) == "状態") col = i; next }
    trim($2) ~ /^[0-9][0-9][0-9]$/ {
      v = trim($col)
      if (v != "ドラフト" && v != "合意済み" && v != "実装中" && v != "完了" && v != "見送り")
        print trim($2) " の状態：" v
    }
  ' "$FILE")
fi

[ ${#ERRORS[@]} -eq 0 ] && exit 0

{
  echo "仕様書の状態の書き方が、決まった形になっていません（$FILE）。"
  for e in "${ERRORS[@]}"; do echo "  - $e"; done
  echo "状態の欄には「ドラフト／合意済み／実装中／完了／見送り」のどれか1語だけを書いてください（仕様書は「- 状態：実装中」の形）。"
  echo "日付・経緯・補足は状態の欄に足さず、TASKS.md の決定事項ログか仕様書の本文に書いてください。"
} >&2
exit 2
