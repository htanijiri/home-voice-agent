// 買い物リストのツール。表記ゆれ（たまご／卵）の判断は LLM に任せ、ここでは正規化した完全一致だけで重複を防ぐ。
import type { ShoppingItem, ShoppingRepo } from "../../db/shopping-repo.js";
import type { Tool } from "./registry.js";

const view = (i: ShoppingItem) => ({ id: i.id, name: i.name, note: i.note ?? undefined });

/** 品名で探す。完全一致がなければ、部分一致が1件だけのときにそれを返す */
function resolveItem(repo: ShoppingRepo, householdId: string, name: string): ShoppingItem {
  const exact = repo.findActiveByName(householdId, name);
  if (exact) return exact;
  const all = repo.active(householdId);
  const n = name.trim();
  const partial = all.filter((i) => i.name.includes(n) || n.includes(i.name));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`候補が複数あります：${partial.map((i) => i.name).join("、")}。どれか確認してください`);
  }
  throw new Error(`「${name}」はリストにありません。現在のリスト：${all.map((i) => i.name).join("、") || "（空）"}`);
}

export function shoppingTools(repo: ShoppingRepo): Tool[] {
  return [
    {
      def: {
        name: "shopping_add",
        description:
          "買い物リストに品目を追加する。複数をまとめて渡せる。数量や「2本」などは note に入れ、name は品名だけにする。追加する前に、発話に添えられた「現在の買い物リスト」と見比べ、表記が違っても同じもの（卵／たまご／玉子、牛乳／ぎゅうにゅう など）が既にあれば、その品目は渡さずに「もう入っています」と伝える。結果の similar_existing に似た既存の品目が入る。",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, note: { type: "string" } },
                required: ["name"],
                additionalProperties: false,
              },
            },
          },
          required: ["items"],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const items = input.items as { name: string; note?: string }[];
        if (items.length === 0 || items.length > 20) throw new Error("items は 1〜20 件");
        const before = repo.active(ctx.householdId);
        const added: string[] = [];
        const alreadyThere: string[] = [];
        for (const it of items) {
          const r = repo.add(ctx.householdId, it.name, it.note, ctx.now);
          (r.existed ? alreadyThere : added).push(r.item.name);
        }
        const similar = before
          .filter((b) => items.some((i) => b.name.includes(i.name.trim()) || i.name.trim().includes(b.name)))
          .map((b) => b.name)
          .filter((n) => !alreadyThere.includes(n));
        return { added, already_there: alreadyThere, similar_existing: similar, total: repo.active(ctx.householdId).length };
      },
    },
    {
      def: {
        name: "shopping_list",
        description: "買い物リストの品目の一覧を返す。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async run(_input, ctx) {
        const items = repo.active(ctx.householdId);
        // 読み上げは最初の10品まで（多いときは件数も伝える）
        return { total: items.length, items: items.slice(0, 10).map(view), truncated: items.length > 10 };
      },
    },
    {
      def: {
        name: "shopping_mark_bought",
        description: "買った品目をリストから外す（「最近買ったもの」として7日残る）。",
        inputSchema: {
          type: "object",
          properties: { names: { type: "array", items: { type: "string" } } },
          required: ["names"],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const done: string[] = [];
        for (const name of input.names as string[]) {
          const item = resolveItem(repo, ctx.householdId, name);
          repo.setStatus(ctx.householdId, item.id, "bought", ctx.now);
          done.push(item.name);
        }
        return { bought: done, remaining: repo.active(ctx.householdId).length };
      },
    },
    {
      def: {
        name: "shopping_remove",
        description: "間違えて入れた品目などを、リストから削除する。",
        inputSchema: {
          type: "object",
          properties: { names: { type: "array", items: { type: "string" } } },
          required: ["names"],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const removed: string[] = [];
        for (const name of input.names as string[]) {
          const item = resolveItem(repo, ctx.householdId, name);
          repo.setStatus(ctx.householdId, item.id, "deleted", ctx.now);
          removed.push(item.name);
        }
        return { removed, remaining: repo.active(ctx.householdId).length };
      },
    },
    {
      def: {
        name: "shopping_clear",
        description:
          "買い物リストを全部消す。必ず先にユーザーに「全部消してよいか」を確認し、はっきり同意を得たときだけ confirmed: true で呼ぶ。",
        inputSchema: {
          type: "object",
          properties: { confirmed: { type: "boolean" } },
          required: ["confirmed"],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        if (input.confirmed !== true) {
          throw new Error("ユーザーの確認が必要です。全部消してよいか尋ねてください");
        }
        return { cleared: repo.clearActive(ctx.householdId, ctx.now) };
      },
    },
  ];
}
