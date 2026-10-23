// リマインダーのツール。日時は構造化した値で受け取り、サーバーが日本時間で解釈する（resolve.ts）。
import type { Reminder, RemindersRepo } from "../../db/reminders-repo.js";
import { AskUser, resolveWhen, type WhenInput } from "../reminders/resolve.js";
import { isRecurring } from "../reminders/schedule.js";
import { spokenDateTime, spokenSchedule } from "../reminders/speech.js";
import type { Tool } from "./registry.js";

const WHEN_SCHEMA = {
  type: "object",
  description:
    "いつ知らせるか。相対的な日付（明日・来週の金曜など）は自分で計算せず、date の relative / in_days / weekday+week で渡す。時刻は 24 時間制の HH:MM。ユーザーが「8時」のように午前・午後を言わなかったら ampm_unspecified を true にする（朝・夜・午前・午後と言ったら false にして 24 時間制に直す）。",
  properties: {
    type: {
      type: "string",
      enum: ["once", "in_duration", "daily", "weekdays", "weekly", "monthly_day", "monthly_nth"],
      description: "once＝一回だけ、in_duration＝◯分後、daily＝毎日、weekdays＝平日、weekly＝毎週◯曜日、monthly_day＝毎月◯日、monthly_nth＝毎月第◯◯曜日",
    },
    date: {
      type: "object",
      description: "once のときの日付。どれか1つの書き方で。省略すると「今日、時刻が過ぎていれば明日」",
      properties: {
        relative: { type: "string", enum: ["today", "tomorrow", "day_after_tomorrow"] },
        in_days: { type: "integer", description: "◯日後" },
        weekday: { type: "integer", description: "0=日曜 … 6=土曜" },
        week: { type: "string", enum: ["upcoming", "this", "next"], description: "weekday と一緒に。upcoming＝次に来るその曜日、this＝今週、next＝来週" },
        month: { type: "integer" },
        day: { type: "integer" },
        year: { type: "integer" },
      },
      additionalProperties: false,
    },
    time: { type: "string", description: "24 時間制の HH:MM" },
    ampm_unspecified: { type: "boolean" },
    minutes: { type: "integer", description: "in_duration のとき、何分後か（3時間後なら 180）" },
    weekdays: { type: "array", items: { type: "integer" }, description: "weekly のときの曜日（0=日曜 … 6=土曜）" },
    day: { type: "integer", description: "monthly_day のときの日（1〜31。ない月は最終日）" },
    nths: { type: "array", items: { type: "integer" }, description: "monthly_nth のとき、第何週か（1〜5、-1＝最終）" },
    weekday: { type: "integer", description: "monthly_nth のときの曜日（0=日曜 … 6=土曜）" },
  },
  required: ["type"],
  additionalProperties: false,
};

const TARGET_PROPS = {
  id: { type: "integer", description: "reminder_list で得た id" },
  title: { type: "string", description: "id が分からないときの、リマインダーの内容" },
};

export function reminderTools(repo: RemindersRepo, tz: string): Tool[] {
  const view = (r: Reminder) => ({
    id: r.id,
    title: r.title,
    when: spokenSchedule(r.schedule, tz, r.next_fire_at ? new Date(r.next_fire_at) : undefined),
    next: r.next_fire_at ? spokenDateTime(new Date(r.next_fire_at), tz) : undefined,
    recurring: isRecurring(r.schedule),
    skip_next: !!r.skip_next,
  });

  const find = (householdId: string, input: Record<string, unknown>): Reminder => {
    const all = repo.active(householdId);
    if (typeof input.id === "number") {
      const r = all.find((x) => x.id === input.id);
      if (r) return r;
      throw new Error("その id のリマインダーはありません");
    }
    const title = String(input.title ?? "").trim();
    if (!title) throw new Error("id か title が必要です");
    const hits = all.filter((r) => r.title.includes(title) || title.includes(r.title));
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new Error(`候補が複数あります：${hits.map((h) => `${h.title}（${view(h).when}）`).join("、")}。どれか確認してください`);
    throw new Error(`「${title}」のリマインダーはありません`);
  };

  const resolve = (when: unknown, now: Date) => {
    try {
      return resolveWhen(when as WhenInput, now, tz);
    } catch (err) {
      if (err instanceof AskUser) throw new Error(`ask_user: ${err.message}`);
      throw err;
    }
  };

  return [
    {
      def: {
        name: "reminder_create",
        description:
          "リマインダーを登録する。結果の when を使って、登録した日時をユーザーに言い直して確かめる。エラーが ask_user で始まるときは、その内容をユーザーに聞き返す（推測で登録しない）。",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string", description: "時刻になったら、そのまま読み上げる言葉。ユーザーの言い方をなるべくそのまま使う（例：「6時に『お風呂を沸かして』って教えて」→ お風呂を沸かして。「8時にゴミ出しを教えて」→ ゴミ出し）" }, when: WHEN_SCHEMA },
          required: ["title", "when"],
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const title = String(input.title).trim();
        if (!title || title.length > 60) throw new Error("title は 1〜60 文字");
        const { schedule, next } = resolve(input.when, ctx.now);
        const r = repo.create(ctx.householdId, title, schedule, next, ctx.now);
        return { created: view(r) };
      },
    },
    {
      def: {
        name: "reminder_list",
        description: "これから先のリマインダーを、近い順に最大5件返す。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      async run(_input, ctx) {
        const all = repo.active(ctx.householdId);
        return { total: all.length, reminders: all.slice(0, 5).map(view) };
      },
    },
    {
      def: {
        name: "reminder_update",
        description: "リマインダーの内容か日時を変える。日時を変えるときは when を全部指定し直す。",
        inputSchema: {
          type: "object",
          properties: { ...TARGET_PROPS, new_title: { type: "string" }, when: WHEN_SCHEMA },
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const r = find(ctx.householdId, input);
        const resolved = input.when ? resolve(input.when, ctx.now) : undefined;
        const u = repo.update(
          ctx.householdId,
          r.id,
          { title: input.new_title as string | undefined, schedule: resolved?.schedule, next: resolved?.next },
          ctx.now,
        );
        return { updated: view(u) };
      },
    },
    {
      def: {
        name: "reminder_delete",
        description:
          "リマインダーを消す。繰り返しのリマインダーは、ユーザーに「次の1回だけ休むか、全部消すか」を確認してから mode を指定する（skip_next＝次の1回だけ休む、all＝全部消す）。",
        inputSchema: {
          type: "object",
          properties: { ...TARGET_PROPS, mode: { type: "string", enum: ["all", "skip_next"] } },
          additionalProperties: false,
        },
      },
      async run(input, ctx) {
        const r = find(ctx.householdId, input);
        const recurring = isRecurring(r.schedule);
        if (recurring && !input.mode) {
          throw new Error("ask_user: 繰り返しのリマインダーです。次の1回だけ休むか、全部消すかを確認してください");
        }
        if (recurring && input.mode === "skip_next") {
          repo.setSkipNext(ctx.householdId, r.id, true, ctx.now);
          return { skipped_next: view(r) };
        }
        repo.delete(ctx.householdId, r.id, ctx.now);
        return { deleted: { id: r.id, title: r.title } };
      },
    },
  ];
}
