// 確認画面（Web）の口：ログイン、画面、API。音声のツールと同じリポジトリを通して保存する。
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../app/server.js";
import type { AppConfig } from "../config.js";
import type { Clock } from "../core/ports.js";
import { nextOccurrence, type Schedule, validateSchedule } from "../core/reminders/schedule.js";
import { spokenDateTime, spokenSchedule } from "../core/reminders/speech.js";
import { localDateString } from "../core/time.js";
import { UserError } from "../core/errors.js";
import { errorFields, log } from "../log.js";
import { estimateMonthlyCost } from "../report/cost.js";
import { LoginError, SESSION_DAYS, type WebAuth } from "./auth.js";
import { renderLoginPage, renderAppPage } from "./page.js";

const COOKIE = "hva_session";
/** 変更の通知（SSE）のハートビートの間隔。Fly のプロキシのアイドル切断より短くする */
export const EVENTS_HEARTBEAT_MS = 25_000;

declare module "fastify" {
  interface FastifyRequest {
    user?: { email: string; csrf: string };
  }
}

class BadRequest extends UserError {}

export async function registerWeb(
  http: FastifyInstance,
  app: Pick<App, "shopping" | "reminders" | "devices" | "turns" | "usage" | "changes">,
  auth: WebAuth,
  config: AppConfig,
  clock: Clock,
): Promise<void> {
  await http.register(cookie);
  // 本文のない POST / DELETE（「買った」「削除」など）も受け付ける
  http.removeContentTypeParser("application/json");
  http.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(new BadRequest("JSON が正しくありません"), undefined);
    }
  });
  const secure = () => config.server.publicBaseUrl.startsWith("https://");
  const origin = () => new URL(config.server.publicBaseUrl).origin;
  const hh = config.household.id;
  const tz = config.household.timezone;

  const sessionOf = (req: FastifyRequest) => auth.getSession(req.cookies[COOKIE], clock.now());

  // 画面と API はログインが必要。更新系の API は、Origin と CSRF のトークンも確かめる
  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const s = sessionOf(req);
    if (!s) return reply.code(401).send({ error: "login required" });
    if (req.method !== "GET" && req.method !== "HEAD") {
      const o = req.headers.origin;
      if (!o || o !== origin()) return reply.code(403).send({ error: "bad origin" });
      if (req.headers["x-csrf-token"] !== s.csrf) return reply.code(403).send({ error: "bad csrf token" });
    }
    req.user = s;
  };

  http.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserError) return reply.code(400).send({ error: err.message });
    if ((err as { statusCode?: number }).statusCode === 400) return reply.code(400).send({ error: "bad request" });
    log.error("web error", errorFields(err));
    return reply.code(500).send({ error: "internal error" });
  });

  // ---- ログイン ----
  http.get("/login", async (_req, reply) => reply.type("text/html; charset=utf-8").send(renderLoginPage()));
  http.get("/auth/start", async (_req, reply) => reply.redirect(auth.begin()));
  http.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/auth/callback", async (req, reply) => {
    const { state, code } = req.query;
    try {
      if (!state || !code) throw new LoginError("ログインできませんでした");
      const email = await auth.complete(state, code);
      const s = auth.createSession(email, clock.now());
      reply.setCookie(COOKIE, s.id, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: secure(),
        maxAge: SESSION_DAYS * 86_400,
      });
      log.info("web login");
      return reply.redirect("/");
    } catch (err) {
      const msg = err instanceof LoginError ? err.message : "ログインできませんでした";
      if (!(err instanceof LoginError)) log.warn("login failed", errorFields(err));
      return reply.code(403).type("text/html; charset=utf-8").send(renderLoginPage(msg));
    }
  });
  http.post("/auth/logout", { preHandler: requireUser }, async (req, reply) => {
    auth.deleteSession(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  // ---- 画面 ----
  http.get("/", async (req, reply) => {
    const s = sessionOf(req);
    if (!s) return reply.redirect("/login");
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store").send(renderAppPage(s.email, s.csrf));
  });

  // ---- API ----
  const api = async (scope: FastifyInstance) => {
    scope.addHook("preHandler", requireUser);
    const idOf = (req: FastifyRequest) => {
      const id = Number((req.params as { id?: string }).id);
      if (!Number.isInteger(id)) throw new BadRequest("id が正しくありません");
      return id;
    };

    scope.get("/me", async (req) => ({ email: req.user!.email }));

    // 変更の通知（Server-Sent Events）。画面はこれを受けて一覧を読み直す
    scope.get("/events", (_req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      const unsubscribe = app.changes.subscribe((householdId, topic) => {
        if (householdId === hh) res.write(`event: ${topic}\ndata: {}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(": ping\n\n"), EVENTS_HEARTBEAT_MS);
      // req の close は本文を読み終えた時点で来るので、res の close（接続が切れた）で片付ける
      res.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });

    // 買い物リスト
    scope.get("/shopping", async () => ({
      active: app.shopping.active(hh),
      recent: app.shopping.recentlyBought(hh, clock.now()),
    }));
    scope.post<{ Body: { name?: string; note?: string } }>("/shopping", async (req) => {
      const r = app.shopping.add(hh, String(req.body?.name ?? ""), req.body?.note, clock.now());
      return { item: r.item, existed: r.existed };
    });
    scope.patch<{ Body: { name?: string; note?: string | null } }>("/shopping/:id", async (req) =>
      app.shopping.update(hh, idOf(req), { name: req.body?.name, note: req.body?.note }, clock.now()),
    );
    scope.post("/shopping/:id/bought", async (req) => app.shopping.setStatus(hh, idOf(req), "bought", clock.now()));
    scope.post("/shopping/:id/restore", async (req) => app.shopping.restore(hh, idOf(req), clock.now()));
    scope.delete("/shopping/:id", async (req) => app.shopping.setStatus(hh, idOf(req), "deleted", clock.now()));

    // リマインダー（画面では日付・時刻・繰り返しを直接指定する）
    const view = (r: ReturnType<typeof app.reminders.active>[number]) => ({
      id: r.id,
      title: r.title,
      schedule: r.schedule,
      when: spokenSchedule(r.schedule, tz, r.next_fire_at ? new Date(r.next_fire_at) : undefined),
      next: r.next_fire_at ? spokenDateTime(new Date(r.next_fire_at), tz) : null,
      skipNext: !!r.skip_next,
    });
    const parseSchedule = (s: unknown): { schedule: Schedule; next: Date } => {
      const schedule = s as Schedule;
      try {
        validateSchedule(schedule);
      } catch (err) {
        throw new BadRequest(`日時の指定が正しくありません（${(err as Error).message}）`);
      }
      const next = nextOccurrence(schedule, clock.now(), tz);
      if (!next) throw new BadRequest("その日時はもう過ぎています");
      return { schedule, next };
    };
    scope.get("/reminders", async () => {
      const since = new Date(clock.now().getTime() - 7 * 86_400_000).toISOString();
      const missed = app.reminders
        .deliveries(["missed", "told"])
        .filter((d) => d.scheduled_at >= since)
        .map((d) => ({ title: d.title, at: spokenDateTime(new Date(d.scheduled_at), tz) }));
      return { reminders: app.reminders.active(hh).map(view), missed };
    });
    scope.post<{ Body: { title?: string; schedule?: unknown } }>("/reminders", async (req) => {
      const title = String(req.body?.title ?? "").trim();
      if (!title) throw new BadRequest("内容が空です");
      const { schedule, next } = parseSchedule(req.body?.schedule);
      return view(app.reminders.create(hh, title, schedule, next, clock.now()));
    });
    scope.patch<{ Body: { title?: string; schedule?: unknown } }>("/reminders/:id", async (req) => {
      const parsed = req.body?.schedule ? parseSchedule(req.body.schedule) : undefined;
      return view(
        app.reminders.update(hh, idOf(req), { title: req.body?.title, schedule: parsed?.schedule, next: parsed?.next }, clock.now()),
      );
    });
    scope.post<{ Body: { skip?: boolean } }>("/reminders/:id/skip-next", async (req) => {
      app.reminders.setSkipNext(hh, idOf(req), req.body?.skip !== false, clock.now());
      return { ok: true };
    });
    scope.delete("/reminders/:id", async (req) => {
      app.reminders.delete(hh, idOf(req), clock.now());
      return { ok: true };
    });

    // 端末
    scope.get("/devices", async () => ({
      devices: app.devices.list().map((d) => ({
        // MAC アドレスは末尾だけを見せる
        id: `…${d.device_id.slice(-5)}`,
        status: d.status,
        activationCode: d.activation_code,
        lastSeenAt: d.last_seen_at,
        firmwareVersion: d.firmware_version,
      })),
    }));
    scope.post<{ Body: { code?: string } }>("/devices/approve", async (req) => {
      const code = String(req.body?.code ?? "").trim();
      if (!/^\d{6}$/.test(code)) throw new BadRequest("6桁の番号を入れてください");
      const id = app.devices.approveByCode(code, clock.now());
      if (!id) throw new BadRequest("その番号の承認待ちの端末はありません");
      return { ok: true };
    });

    // 会話の記録
    scope.get("/conversations", async () => ({
      turns: app.turns
        .list({ since: new Date(clock.now().getTime() - config.retention.conversationDays * 86_400_000), limit: 500 })
        .map((t) => ({ at: t.created_at, user: t.user_text, assistant: t.assistant_text, outcome: t.outcome })),
    }));
    scope.delete("/conversations", async () => ({ deleted: app.turns.deleteAll() }));

    // 利用量と費用の目安
    scope.get<{ Querystring: { month?: string } }>("/usage", async (req) => {
      const month = req.query.month ?? localDateString(clock.now(), tz).slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequest("month は YYYY-MM");
      const usage = app.usage.sumByPrefix(month);
      return { month, usage, cost: estimateMonthlyCost(usage, config.pricing) };
    });
  };
  await http.register(api, { prefix: "/api" });
}
