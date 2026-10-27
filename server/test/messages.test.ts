// 016：家族への連絡の保存・日ごとの数・30 日での削除。017：聞き返しとつなぎの言葉
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { MessagesRepo } from "../src/db/messages-repo.js";
import { isFillerOnly, messageTools } from "../src/core/tools/messages.js";
import { ToolRegistry } from "../src/core/tools/registry.js";

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

describe("send_family_message の聞き返しとつなぎの言葉（017）", () => {
  const setup = () => {
    const sent: string[] = [];
    let patient = 0;
    const tools = new ToolRegistry().register(...messageTools({ send: async (_hh, _to, text) => void sent.push(text) }, 100));
    const ctx = { deviceId: "d", householdId: "home", now: new Date(), listenPatiently: () => void patient++ };
    return { sent, tools, ctx, patient: () => patient };
  };

  it("つなぎの言葉だけかを判定する", () => {
    for (const t of ["えっと", "えっと…", "えーっと、あのね。", "うーん", "あのー", "えっとね", "んー、えっと"]) expect(isFillerOnly(t), t).toBe(true);
    for (const t of ["えっと、お迎え何時？", "あのね、おやつ買ってきて", "うん", "早く帰ってきて", ""]) expect(isFillerOnly(t), t).toBe(false);
  });

  it("text がなければ送らずに、次の聞き取りをゆっくり聞く（reply をそのまま使う）", async () => {
    const s = setup();
    const r = await s.tools.run("send_family_message", { to: "パパ", reply: "なんて伝える？" }, s.ctx);
    expect(r).toMatchObject({ isError: false, expected: true });
    expect(s.sent).toEqual([]);
    expect(s.patient()).toBe(1);
  });

  it("つなぎの言葉だけなら送らずに、思ったとおりでない結果を返して、ゆっくり聞く", async () => {
    const s = setup();
    const r = await s.tools.run("send_family_message", { to: "パパ", text: "えっと…", reply: "パパに送ったよ。" }, s.ctx);
    expect(r.expected).toBe(false);
    expect(r.content).toContain("なんて伝える？");
    expect(s.sent).toEqual([]);
    expect(s.patient()).toBe(1);
  });

  it("用件があれば、つなぎの言葉ごとそのまま送る", async () => {
    const s = setup();
    const r = await s.tools.run("send_family_message", { to: "パパ", text: "えっと、お迎え何時？" }, s.ctx);
    expect(r).toMatchObject({ isError: false, expected: true });
    expect(s.sent).toEqual(["えっと、お迎え何時？"]);
    expect(s.patient()).toBe(0);
  });
});
