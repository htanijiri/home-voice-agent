// 004 AC8：リマインダーの会話。日時が正しく保存され、時刻がなければ聞き返す
import { leaks, newWorld, repeat } from "./harness.js";

const at = (w: ReturnType<typeof newWorld>) => w.reminders.active("home").map((r) => r.next_fire_at);

const a = await repeat("明日の午前8時", 5, async () => {
  const w = newWorld();
  const answer = await w.say("明日の午前8時にゴミ出しを教えて");
  const list = at(w);
  const ok = !leaks(answer) && list.length === 1 && list[0] === new Date("2026-10-21T08:00:00+09:00").toISOString();
  return { ok, detail: `[${w.firstSentenceMs}ms] ${list.join(",")} / ${answer}` };
});

const b = await repeat("時刻なしは聞き返す", 5, async () => {
  const w = newWorld();
  const answer = await w.say("金曜にゴミ出しを教えて");
  const ok = !leaks(answer) && at(w).length === 0 && /時/.test(answer);
  return { ok, detail: `[${w.firstSentenceMs}ms] saved=${at(w).length} / ${answer}` };
});

const c = await repeat("来週の金曜・毎週の繰り返し", 3, async () => {
  const w = newWorld();
  await w.say("来週の金曜の午後3時に歯医者を教えて");
  await w.say("毎週月曜と木曜の朝7時半に燃えるゴミを教えて");
  const rs = w.reminders.active("home");
  const dentist = rs.find((r) => r.title.includes("歯医者"));
  const garbage = rs.find((r) => r.title.includes("ゴミ"));
  const ok =
    dentist?.next_fire_at === new Date("2026-10-30T15:00:00+09:00").toISOString() &&
    garbage?.schedule.kind === "weekly" &&
    JSON.stringify((garbage.schedule as { weekdays: number[] }).weekdays) === "[1,4]" &&
    garbage.schedule.time === "07:30";
  return { ok, detail: JSON.stringify(rs.map((r) => ({ t: r.title, s: r.schedule, n: r.next_fire_at }))) };
});
process.exit(a && b && c ? 0 : 1);
