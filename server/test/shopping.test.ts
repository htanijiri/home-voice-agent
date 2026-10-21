import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/core/tools/registry.js";
import { shoppingTools } from "../src/core/tools/shopping.js";
import { openDb } from "../src/db/db.js";
import { normalizeName, ShoppingRepo } from "../src/db/shopping-repo.js";

function setup() {
  const repo = new ShoppingRepo(openDb(":memory:"));
  const tools = new ToolRegistry().register(...shoppingTools(repo));
  let now = new Date("2026-10-20T10:00:00+09:00");
  const ctx = () => ({ deviceId: "d", householdId: "home", now });
  const call = async (name: string, input: unknown) => {
    const r = await tools.run(name, input, ctx());
    return { ...r, value: JSON.parse(r.content) };
  };
  return { repo, call, advance: (ms: number) => (now = new Date(now.getTime() + ms)), now: () => now };
}

describe("正規化", () => {
  it("全角半角・カタカナとひらがな・空白の違いをなくす", () => {
    expect(normalizeName("ギュウニュウ")).toBe(normalizeName("ぎゅうにゅう"));
    expect(normalizeName("ＡＢＣ　ジュース")).toBe(normalizeName("abcじゅーす"));
  });
});

describe("買い物リストのツール", () => {
  it("追加・一覧・買った・削除が保存される", async () => {
    const { repo, call } = setup();
    expect((await call("shopping_add", { items: [{ name: "牛乳", note: "2本" }, { name: "卵" }, { name: "パン" }] })).value).toMatchObject({
      added: ["牛乳", "卵", "パン"],
      total: 3,
    });
    expect(repo.active("home").find((i) => i.name === "牛乳")!.note).toBe("2本");
    expect((await call("shopping_list", {})).value).toMatchObject({ total: 3, truncated: false });
    expect((await call("shopping_mark_bought", { names: ["卵"] })).value).toMatchObject({ bought: ["卵"], remaining: 2 });
    expect((await call("shopping_remove", { names: ["牛乳"] })).value).toMatchObject({ removed: ["牛乳"], remaining: 1 });
    expect(repo.active("home").map((i) => i.name)).toEqual(["パン"]);
  });

  it("同じ品名（正規化して一致）は追加しない", async () => {
    const { repo, call } = setup();
    await call("shopping_add", { items: [{ name: "ぎゅうにゅう" }] });
    const r = await call("shopping_add", { items: [{ name: "ギュウニュウ" }] });
    expect(r.value).toMatchObject({ added: [], already_there: ["ぎゅうにゅう"] });
    expect(repo.active("home")).toHaveLength(1);
  });

  it("似た既存の品目を返す（表記ゆれの判断材料）", async () => {
    const { call } = setup();
    await call("shopping_add", { items: [{ name: "卵" }] });
    const r = await call("shopping_add", { items: [{ name: "卵パック" }] });
    expect(r.value.similar_existing).toEqual(["卵"]);
  });

  it("全部消すのは確認済みのときだけ", async () => {
    const { repo, call } = setup();
    await call("shopping_add", { items: [{ name: "牛乳" }, { name: "卵" }] });
    const ng = await call("shopping_clear", { confirmed: false });
    expect(ng.isError).toBe(true);
    expect(repo.active("home")).toHaveLength(2);
    const ok = await call("shopping_clear", { confirmed: true });
    expect(ok.value).toEqual({ cleared: 2 });
    expect(repo.active("home")).toHaveLength(0);
  });

  it("リストにない品目を買った・削除にすると、エラーと現在のリストを返す", async () => {
    const { call } = setup();
    await call("shopping_add", { items: [{ name: "牛乳" }] });
    const r = await call("shopping_mark_bought", { names: ["バナナ"] });
    expect(r.isError).toBe(true);
    expect(r.value.error).toContain("牛乳");
  });

  it("部分一致が1件なら、その品目として扱う", async () => {
    const { call } = setup();
    await call("shopping_add", { items: [{ name: "低脂肪牛乳" }, { name: "卵" }] });
    expect((await call("shopping_mark_bought", { names: ["牛乳"] })).value).toMatchObject({ bought: ["低脂肪牛乳"] });
  });

  it("11品以上は最初の10品と件数を返す", async () => {
    const { call } = setup();
    await call("shopping_add", { items: Array.from({ length: 12 }, (_, i) => ({ name: `品${i}` })) });
    const r = await call("shopping_list", {});
    expect(r.value.total).toBe(12);
    expect(r.value.items).toHaveLength(10);
    expect(r.value.truncated).toBe(true);
  });

  it("最近買ったものは7日で消え、それまではリストに戻せる", async () => {
    const { repo, call, advance, now } = setup();
    await call("shopping_add", { items: [{ name: "卵" }] });
    await call("shopping_mark_bought", { names: ["卵"] });
    const bought = repo.recentlyBought("home", now());
    expect(bought).toHaveLength(1);
    repo.restore("home", bought[0]!.id, now());
    expect(repo.active("home")).toHaveLength(1);
    await call("shopping_mark_bought", { names: ["卵"] });
    advance(8 * 86_400_000);
    expect(repo.recentlyBought("home", now())).toHaveLength(0);
    expect(repo.purge(now())).toBe(1);
  });
});
