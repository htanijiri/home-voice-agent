// 008：買い物リスト・リマインダーの変更の通知
import { describe, expect, it } from "vitest";
import { ChangeFeed, type ChangeTopic } from "../src/app/change-feed.js";
import { openDb } from "../src/db/db.js";
import { RemindersRepo } from "../src/db/reminders-repo.js";
import { ShoppingRepo } from "../src/db/shopping-repo.js";

function setup() {
  const feed = new ChangeFeed();
  const db = openDb(":memory:");
  const shopping = new ShoppingRepo(db, (hh) => feed.notify(hh, "shopping"));
  const reminders = new RemindersRepo(db, "Asia/Tokyo", (hh) => feed.notify(hh, "reminders"));
  const got: [string, ChangeTopic][] = [];
  feed.subscribe((hh, topic) => got.push([hh, topic]));
  return { feed, shopping, reminders, got };
}

const now = new Date("2026-10-21T03:00:00Z");

describe("変更の通知", () => {
  it("買い物リストを変える操作のたびに通知し、読むだけでは通知しない", () => {
    const { shopping, got } = setup();
    const { item } = shopping.add("home", "牛乳", undefined, now);
    shopping.update("home", item.id, { note: "2本" }, now);
    shopping.setStatus("home", item.id, "bought", now);
    shopping.restore("home", item.id, now);
    shopping.setStatus("home", item.id, "deleted", now);
    shopping.add("home", "卵", undefined, now);
    shopping.clearActive("home", now);
    expect(got).toEqual(Array(7).fill(["home", "shopping"]));

    got.length = 0;
    shopping.active("home");
    shopping.recentlyBought("home", now);
    shopping.add("home", "パン", undefined, now);
    shopping.add("home", "ぱん", undefined, now); // 既にあるので追加しない
    shopping.clearActive("other", now); // 消すものがない
    shopping.purge(now);
    expect(got).toEqual([["home", "shopping"]]);
  });

  it("リマインダーの登録・変更・休み・削除と、お知らせで次の予定へ進んだときに通知する", () => {
    const { reminders, got } = setup();
    const at = new Date("2026-10-21T23:00:00Z");
    const r = reminders.create("home", "ゴミ出し", { kind: "weekly", weekdays: [4], time: "08:00" }, at, now);
    reminders.update("home", r.id, { title: "燃えるゴミ" }, now);
    reminders.setSkipNext("home", r.id, true, now);
    reminders.setSkipNext("home", r.id, false, now);
    const due = reminders.due(new Date("2026-10-22T00:00:00Z"));
    expect(due).toHaveLength(1);
    const d = reminders.takeDue(due[0]!);
    reminders.markSent([d!.id], now);
    reminders.active("home");
    reminders.delete("home", r.id, now);
    expect(got).toEqual(Array(6).fill(["home", "reminders"]));
  });

  it("購読を外すと届かない。1つの購読の失敗がほかに影響しない", () => {
    const feed = new ChangeFeed();
    const got: string[] = [];
    feed.subscribe(() => {
      throw new Error("boom");
    });
    const off = feed.subscribe((hh) => got.push(hh));
    feed.notify("home", "shopping");
    off();
    feed.notify("home", "shopping");
    expect(got).toEqual(["home"]);
    expect(feed.size).toBe(1);
  });
});
