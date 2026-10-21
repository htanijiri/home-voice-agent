// 発話ごとに LLM へ添える補足。システムプロンプトを固定したまま、変わる情報（日時・買い物リスト）を渡す
import type { ShoppingRepo } from "../db/shopping-repo.js";
import { formatJapaneseDateTime } from "./time.js";

export function makeTurnNote(shopping: ShoppingRepo, householdId: string, tz: string) {
  return (now: Date): string => {
    const items = shopping.active(householdId).map((i) => i.name);
    return [
      `現在の日時：${formatJapaneseDateTime(now, tz)}（日本時間）`,
      `現在の買い物リスト：${items.length ? items.map((n) => `「${n}」`).join("、") : "（空）"}`,
    ].join("\n");
  };
}
