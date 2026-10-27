// 016：家族への連絡の保存・日ごとの数・30 日での削除
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { MessagesRepo } from "../src/db/messages-repo.js";

describe("MessagesRepo", () => {
  it("新しい順に並べ、日ごとの数は家庭の時刻で数える", () => {
    const repo = new MessagesRepo(openDb(":memory:"), "Asia/Tokyo");
    repo.addVoice("home", "パパ", "前の日", new Date("2026-10-20T23:59:00+09:00"));
    repo.addVoice("home", undefined, "その日1", new Date("2026-10-21T00:00:00+09:00"));
    repo.addAnnounce("home", "読み上げ", { email: "a@example.com", name: "A" }, "sent", new Date("2026-10-21T08:00:00+09:00"));
    repo.addVoice("other", "ママ", "ほかの家庭", new Date("2026-10-21T09:00:00+09:00"));
    expect(repo.voiceCountOn("home", new Date("2026-10-21T12:00:00+09:00"))).toBe(1);
    expect(repo.list("home").map((m) => m.text)).toEqual(["読み上げ", "その日1", "前の日"]);
    expect(repo.list("home")[1]!.to_label).toBeNull();
  });

  it("結果を更新でき、30 日より古いものを消す", () => {
    const repo = new MessagesRepo(openDb(":memory:"), "Asia/Tokyo");
    const a = repo.addAnnounce("home", "待ち", { email: "a@example.com" }, "queued", new Date("2026-10-21T08:00:00+09:00"));
    repo.setStatus(a.id, "dropped");
    expect(repo.list("home")[0]!.status).toBe("dropped");
    repo.addVoice("home", "パパ", "古い", new Date("2026-09-01T08:00:00+09:00"));
    expect(repo.deleteOlderThan(new Date("2026-09-21T08:00:00+09:00"))).toBe(1);
    expect(repo.list("home").map((m) => m.text)).toEqual(["待ち"]);
  });
});
