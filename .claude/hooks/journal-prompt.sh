#!/bin/bash
# UserPromptSubmit hook：ユーザーの指示を原文のまま journal/raw/YYYY-MM-DD.md に記録する。
# あわせて、Stop hook がジャーナル記入の有無を判定できるよう、指示時点の状態を保存する。
#
# 注意：UserPromptSubmit で exit 2 するとプロンプトが破棄されるため、何が起きても exit 0 で終える。
# stdout に出したテキストは Claude のコンテキストに入るので、何も出力しない。

INPUT="$(cat)"
jq -e . >/dev/null 2>&1 <<<"$INPUT" || exit 0

# セッションの作業フォルダ（SESSION_ROOT）と、リポジトリ本体のフォルダ（MAIN_ROOT）を求める。
# ふだんは両方ともプロジェクトのフォルダ。ワークツリーのセッションでは SESSION_ROOT がワークツリーになる
# （CLAUDE_PROJECT_DIR は本体を指したままで、Claude は本体側に書き込めない）。
# 原文ログ（journal/raw）は本体側の1か所にまとめ、整理済みジャーナルは Claude が書ける SESSION_ROOT 側を見る。
# ※ journal-stop.sh にも同じ処理がある。直すときは両方を揃える。
main_root_of() {
  local common
  common="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  (cd "$1" && cd "$common/.." 2>/dev/null && pwd -P)
}
PROJECT="$(cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null && pwd -P)" || exit 0
CWD="$(jq -r '.cwd // ""' <<<"$INPUT" 2>/dev/null)"
SESSION_ROOT="$PROJECT"
MAIN_ROOT="$PROJECT"
if [ "$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null)" = "$PROJECT" ]; then
  MAIN_ROOT="$(main_root_of "$PROJECT")" || MAIN_ROOT="$PROJECT"
  TOP="$(git -C "${CWD:-$PROJECT}" rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$TOP" ] && [ "$(main_root_of "$TOP")" = "$MAIN_ROOT" ] && SESSION_ROOT="$TOP"
fi

RAW_DIR="$MAIN_ROOT/journal/raw"
STATE_DIR="$RAW_DIR/.state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

SESSION_ID="$(jq -r '.session_id // "unknown"' <<<"$INPUT" 2>/dev/null)"
PROMPT_ID="$(jq -r '.prompt_id // ""' <<<"$INPUT" 2>/dev/null)"
PROMPT="$(jq -r '.prompt // ""' <<<"$INPUT" 2>/dev/null)"

DATE="$(date '+%Y-%m-%d')"
TIME="$(date '+%H:%M:%S')"
STATE="$STATE_DIR/$SESSION_ID.json"

# 前の指示に対して Stop が来ていない（＝中断された）場合は、その旨を残す
if [ -f "$STATE" ]; then
  PREV_DATE="$(jq -r '.date' "$STATE" 2>/dev/null)"
  printf '\n> [!NOTE]\n> 上の指示への応答は記録されていません（ユーザーによる中断の可能性）。\n' \
    >>"$RAW_DIR/$PREV_DATE.md"
fi

RAW="$RAW_DIR/$DATE.md"
[ -f "$RAW" ] || printf '# %s（自動記録：指示と応答の原文）\n' "$DATE" >"$RAW"

# 指示に含まれるバッククォートより長いフェンスで囲み、原文を崩さない
LONGEST="$(grep -o '`\+' <<<"$PROMPT" | awk '{ if (length($0) > m) m = length($0) } END { print m + 0 }')"
FENCE_LEN=$(( LONGEST >= 3 ? LONGEST + 1 : 3 ))
FENCE="$(printf '%*s' "$FENCE_LEN" '' | tr ' ' '`')"

{
  printf '\n---\n\n## %s 指示\n\n' "$TIME"
  if [ "$SESSION_ROOT" = "$MAIN_ROOT" ]; then
    printf '<!-- session: %s / prompt: %s -->\n\n' "$SESSION_ID" "$PROMPT_ID"
  else
    printf '<!-- session: %s / prompt: %s / worktree: %s -->\n\n' "$SESSION_ID" "$PROMPT_ID" "$(basename "$SESSION_ROOT")"
  fi
  printf '%stext\n%s\n%s\n' "$FENCE" "$PROMPT" "$FENCE"
} >>"$RAW"

# 指示時点での、その日の整理済みジャーナルのサイズを記録する（Stop で増えたかを見る）
JOURNAL="$SESSION_ROOT/journal/$DATE.md"
SIZE=0
[ -f "$JOURNAL" ] && SIZE="$(wc -c <"$JOURNAL" | tr -d ' ')"
jq -n --arg date "$DATE" --arg time "$TIME" --arg prompt_id "$PROMPT_ID" --argjson size "$SIZE" \
  '{date: $date, time: $time, prompt_id: $prompt_id, journal_size: $size}' >"$STATE" 2>/dev/null

exit 0
