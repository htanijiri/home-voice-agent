// 005：確認画面のログイン（偽の Google）と API
import { createServer, type Server } from "node:http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import type { OidcConfig } from "../src/web/auth.js";
import { FakeLlm, FakeStt, FakeTts } from "./fakes.js";
import { startTestApp } from "./helpers.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

const ISSUER = "https://accounts.google.com";
const CLIENT = "test-client-id";

async function fakeGoogle() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  // 次に返す ID トークンの中身（テストごとに変える）
  const next: { claims: Record<string, unknown>; key?: CryptoKey; expired?: boolean } = { claims: {} };
  let lastBody = "";
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      lastBody = body;
      const params = new URLSearchParams(body);
      const now = Math.floor(Date.now() / 1000);
      const jwt = await new SignJWT({ nonce: next.claims.nonce ?? "", ...next.claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer((next.claims.iss as string) ?? ISSUER)
        .setAudience((next.claims.aud as string) ?? CLIENT)
        .setIssuedAt(next.expired ? now - 7200 : now)
        .setExpirationTime(next.expired ? now - 3600 : now + 3600)
        .sign(next.key ?? privateKey);
      void params;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id_token: jwt, access_token: "x" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  const oidc: OidcConfig = {
    clientId: CLIENT,
    clientSecret: "secret",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: `http://127.0.0.1:${port}/token`,
    issuers: [ISSUER, "accounts.google.com"],
    jwks: createLocalJWKSet({ keys: [jwk] }),
    allowedEmails: ["a@example.com", "b@example.com"],
  };
  return { oidc, next, lastBody: () => lastBody };
}

async function setup() {
  const g = await fakeGoogle();
  const t = await startTestApp({ stt: new FakeStt(), tts: new FakeTts(), llm: new FakeLlm([]), oidc: g.oidc } as never);
  cleanup.push(() => t.app.close());
  /** ログインの手続きを最後まで進め、Cookie を返す（失敗なら status を返す） */
  const login = async (claims: Record<string, unknown>, opts: { expired?: boolean; key?: CryptoKey } = {}) => {
    const start = await fetch(`${t.base}/auth/start`, { redirect: "manual" });
    const loc = new URL(start.headers.get("location")!);
    const state = loc.searchParams.get("state")!;
    g.next.claims = { nonce: loc.searchParams.get("nonce"), ...claims };
    g.next.expired = opts.expired;
    g.next.key = opts.key;
    const cb = await fetch(`${t.base}/auth/callback?state=${state}&code=abc`, { redirect: "manual" });
    return { status: cb.status, cookie: cb.headers.get("set-cookie") ?? "", loc };
  };
  const session = async (email = "a@example.com") => {
    const r = await login({ email, email_verified: true });
    const cookie = r.cookie.split(";")[0]!;
    const html = await (await fetch(`${t.base}/`, { headers: { cookie } })).text();
    const csrf = /name="csrf" content="([^"]+)"/.exec(html)![1]!;
    const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
      fetch(`${t.base}/api${path}`, {
        method,
        headers: { cookie, "content-type": "application/json", origin: t.base, "x-csrf-token": csrf, ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { cookie, csrf, call };
  };
  return { ...t, g, login, session };
}

describe("ログイン", () => {
  it("ログインしていないと、画面はログインへ、API は 401", async () => {
    const t = await setup();
    const r = await fetch(`${t.base}/`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/login");
    for (const p of ["/api/shopping", "/api/reminders", "/api/devices", "/api/conversations", "/api/usage"]) {
      expect((await fetch(`${t.base}${p}`)).status).toBe(401);
    }
  });

  it("Google への誘導に PKCE（S256）・state・nonce を付ける", async () => {
    const t = await setup();
    const r = await fetch(`${t.base}/auth/start`, { redirect: "manual" });
    const loc = new URL(r.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBeTruthy();
    expect(loc.searchParams.get("nonce")).toBeTruthy();
    expect(loc.searchParams.get("redirect_uri")).toBe(`${t.base}/auth/callback`);
  });

  it("許可リストにあり、確認済みのメールアドレスならログインでき、Cookie は HttpOnly・SameSite=Lax", async () => {
    const t = await setup();
    const r = await t.login({ email: "A@example.com", email_verified: true });
    expect(r.status).toBe(302);
    expect(r.cookie).toMatch(/HttpOnly/i);
    expect(r.cookie).toMatch(/SameSite=Lax/i);
    expect(t.g.lastBody()).toContain("code_verifier=");
  });

  it.each([
    ["許可リストにない", { email: "x@example.com", email_verified: true }, {}],
    ["メールが未確認", { email: "a@example.com", email_verified: false }, {}],
    ["宛先（aud）が違う", { email: "a@example.com", email_verified: true, aud: "other" }, {}],
    ["発行者（iss）が違う", { email: "a@example.com", email_verified: true, iss: "https://evil.example.com" }, {}],
    ["nonce が違う", { email: "a@example.com", email_verified: true, nonce: "wrong" }, {}],
    ["期限切れ", { email: "a@example.com", email_verified: true }, { expired: true }],
  ])("%s ならログインできない", async (_name, claims, opts) => {
    const t = await setup();
    const r = await t.login(claims, opts as never);
    expect(r.status).toBe(403);
    expect(r.cookie).toBe("");
  });

  it("署名を改ざんしたトークンではログインできない", async () => {
    const t = await setup();
    const other = await generateKeyPair("RS256");
    const r = await t.login({ email: "a@example.com", email_verified: true }, { key: other.privateKey });
    expect(r.status).toBe(403);
  });

  it("同じ state は2回使えない", async () => {
    const t = await setup();
    const start = await fetch(`${t.base}/auth/start`, { redirect: "manual" });
    const loc = new URL(start.headers.get("location")!);
    t.g.next.claims = { nonce: loc.searchParams.get("nonce"), email: "a@example.com", email_verified: true };
    const state = loc.searchParams.get("state");
    expect((await fetch(`${t.base}/auth/callback?state=${state}&code=x`, { redirect: "manual" })).status).toBe(302);
    expect((await fetch(`${t.base}/auth/callback?state=${state}&code=x`, { redirect: "manual" })).status).toBe(403);
  });
});

describe("CSRF 対策", () => {
  it("更新系は Origin と CSRF のトークンがないと 403", async () => {
    const t = await setup();
    const s = await t.session();
    expect((await s.call("POST", "/shopping", { name: "牛乳" }, { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await s.call("POST", "/shopping", { name: "牛乳" }, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect((await s.call("POST", "/shopping", { name: "牛乳" })).status).toBe(200);
  });
});

describe("API", () => {
  it("買い物リスト：音声のツールと同じリポジトリに保存される", async () => {
    const t = await setup();
    const s = await t.session();
    const add = await (await s.call("POST", "/shopping", { name: "牛乳", note: "2本" })).json();
    expect(t.app.shopping.active("home")[0]!.name).toBe("牛乳");
    const dup = await (await s.call("POST", "/shopping", { name: "ぎゅうにゅう" })).json();
    expect(dup.existed).toBe(false); // ひらがなと漢字は別（表記ゆれの判断は音声では AI が行う）
    await s.call("PATCH", `/shopping/${add.item.id}`, { name: "低脂肪牛乳" });
    await s.call("POST", `/shopping/${add.item.id}/bought`);
    const list = await (await s.call("GET", "/shopping")).json();
    expect(list.active.map((i: { name: string }) => i.name)).toEqual(["ぎゅうにゅう"]);
    expect(list.recent[0].name).toBe("低脂肪牛乳");
    await s.call("POST", `/shopping/${add.item.id}/restore`);
    expect(t.app.shopping.active("home")).toHaveLength(2);
    expect((await s.call("DELETE", `/shopping/${add.item.id}`)).status).toBe(200);
    expect((await s.call("POST", "/shopping", { name: "" })).status).toBe(400);
  });

  it("リマインダー：追加・変更・次だけ休む・削除・過去はエラー", async () => {
    const t = await setup();
    const s = await t.session();
    const r = await (await s.call("POST", "/reminders", { title: "ゴミ出し", schedule: { kind: "once", date: "2026-10-21", time: "08:00" } })).json();
    expect(r.next).toBe("10月21日（水）午前8時");
    const past = await s.call("POST", "/reminders", { title: "x", schedule: { kind: "once", date: "2026-10-19", time: "08:00" } });
    expect(past.status).toBe(400);
    const w = await (await s.call("POST", "/reminders", { title: "燃えるゴミ", schedule: { kind: "weekly", weekdays: [1, 4], time: "07:30" } })).json();
    await s.call("POST", `/reminders/${w.id}/skip-next`, { skip: true });
    expect(t.app.reminders.get("home", w.id)!.skip_next).toBe(1);
    await s.call("PATCH", `/reminders/${r.id}`, { schedule: { kind: "once", date: "2026-10-21", time: "07:00" } });
    const list = await (await s.call("GET", "/reminders")).json();
    expect(list.reminders.map((x: { next: string }) => x.next)).toContain("10月21日（水）午前7時");
    await s.call("DELETE", `/reminders/${r.id}`);
    expect(t.app.reminders.active("home")).toHaveLength(1);
  });

  it("端末の承認が画面からできる", async () => {
    const t = await setup();
    const s = await t.session();
    const row = t.app.devices.ensurePending("aa:bb:cc:dd:ee:01", "c", new Date());
    expect((await s.call("POST", "/devices/approve", { code: "12" })).status).toBe(400);
    expect((await s.call("POST", "/devices/approve", { code: row.activation_code })).status).toBe(200);
    expect(t.app.devices.get("aa:bb:cc:dd:ee:01")!.status).toBe("approved");
    const list = await (await s.call("GET", "/devices")).json();
    expect(list.devices[0].id).toBe("…ee:01"); // MAC は末尾だけ
  });

  it("会話の記録の一覧と全削除", async () => {
    const t = await setup();
    const s = await t.session();
    t.app.turns.insert({ deviceId: "d", userText: "こんにちは", assistantText: "こんにちは。", outcome: "ok", timings: {} }, t.clock.now());
    const list = await (await s.call("GET", "/conversations")).json();
    expect(list.turns[0]).toMatchObject({ user: "こんにちは" });
    expect(await (await s.call("DELETE", "/conversations")).json()).toEqual({ deleted: 1 });
    expect(t.app.turns.list()).toHaveLength(0);
  });

  it("利用量と費用の目安", async () => {
    const t = await setup();
    const s = await t.session();
    t.app.usage.add(t.clock.now(), "turns", 3);
    t.app.usage.add(t.clock.now(), "llm_input_tokens", 1_000_000);
    const u = await (await s.call("GET", "/usage")).json();
    expect(u.month).toBe("2026-10");
    expect(u.usage.turns).toBe(3);
    expect(u.cost.llm).toBeCloseTo(0.1);
    expect(u.cost.totalJpy).toBeGreaterThan(0);
  });

  it("許可リストから外れた人のセッションは使えない", async () => {
    const t = await setup();
    const s = await t.session("b@example.com");
    t.g.oidc.allowedEmails.splice(t.g.oidc.allowedEmails.indexOf("b@example.com"), 1);
    expect((await s.call("GET", "/shopping")).status).toBe(401);
  });
});
