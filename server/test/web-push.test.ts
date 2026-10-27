// 016：Web Push の暗号化（RFC 8291）・VAPID（RFC 8292）・購読の扱い
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptPayload,
  generateVapidKeys,
  isAllowedEndpoint,
  type PushSender,
  type PushTarget,
  vapidAuthorization,
  WebPushSender,
} from "../src/adapters/web-push.js";
import { loadOrCreateVapidKeys, PushService } from "../src/app/push.js";
import { openDb } from "../src/db/db.js";
import { KvRepo } from "../src/db/kv-repo.js";
import { PushRepo } from "../src/db/push-repo.js";

const b = (s: string) => Buffer.from(s, "base64url");
const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** ブラウザ側の復号（テスト用） */
function decrypt(message: Buffer, uaPrivate: Buffer, authSecret: Buffer): string {
  const salt = message.subarray(0, 16);
  const idlen = message[20]!;
  const asPublic = message.subarray(21, 21 + idlen);
  const ct = message.subarray(21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const ecdh = ua.computeSecret(asPublic);
  const prkKey = hmac(authSecret, ecdh);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

describe("RFC 8291 の暗号化", () => {
  it("付録 A の例と同じ結果になる", () => {
    const out = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      { asPrivateKey: b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: b("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    expect(out.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("ブラウザの鍵で日本語を復号できる", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const out = encryptPayload(Buffer.from('{"body":"今日のお迎え、何時？"}'), {
      p256dh: ua.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    });
    expect(decrypt(out, ua.getPrivateKey(), auth)).toBe('{"body":"今日のお迎え、何時？"}');
  });
});

describe("VAPID", () => {
  it("送り先の origin 宛ての、公開鍵で検証できる ES256 の JWT を作る", async () => {
    const keys = generateVapidKeys();
    const h = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", keys, "https://example.test", new Date("2026-10-27T00:00:00Z"));
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(m[2]).toBe(keys.publicKey);
    const [hd, pl, sig] = m[1]!.split(".");
    const payload = JSON.parse(b(pl!).toString());
    expect(payload).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://example.test" });
    const pub = b(keys.publicKey);
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: "ieee-p1363" }, b(sig!))).toBe(true);
  });
});

describe("送り先の制限", () => {
  it("ブラウザのプッシュの仕組み以外には送らない", () => {
    expect(isAllowedEndpoint("https://fcm.googleapis.com/fcm/send/x")).toBe(true);
    expect(isAllowedEndpoint("https://web.push.apple.com/x")).toBe(true);
    expect(isAllowedEndpoint("http://fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedEndpoint("https://evil.example/fcm.googleapis.com")).toBe(false);
    expect(isAllowedEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isAllowedEndpoint("https://169.254.169.254/")).toBe(false);
  });

  it("WebPushSender は許可されていない送り先に通信しない", async () => {
    let called = false;
    const sender = new WebPushSender(generateVapidKeys(), "https://example.test", (async () => {
      called = true;
      return new Response(null, { status: 201 });
    }) as typeof fetch);
    await expect(sender.send({ endpoint: "https://evil.example/", p256dh: "x", auth: "y" }, "{}")).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("WebPushSender は暗号化したものを、必要なヘッダーを付けて送る", async () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = Buffer.alloc(16, 3);
    let got: { url: string; init: RequestInit } | undefined;
    const sender = new WebPushSender(generateVapidKeys(), "https://example.test", (async (url: string, init: RequestInit) => {
      got = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch);
    const status = await sender.send(
      { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
      "こんにちは",
    );
    expect(status).toBe(201);
    const headers = got!.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("86400");
    expect(headers.Authorization).toMatch(/^vapid t=/);
    expect(decrypt(Buffer.from(got!.init.body as Uint8Array), ua.getPrivateKey(), auth)).toBe("こんにちは");
  });
});

describe("PushService", () => {
  const target = (n: number): PushTarget => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, p256dh: "p", auth: "a" });

  it("鍵は1回だけ作り、次からは保存したものを使う", () => {
    const kv = new KvRepo(openDb(":memory:"));
    const k1 = loadOrCreateVapidKeys(kv);
    const k2 = loadOrCreateVapidKeys(kv);
    expect(k2).toEqual(k1);
    expect(b(k1.publicKey)).toHaveLength(65);
  });

  it("購読しているすべてに送り、404・410 の購読は消す", async () => {
    const repo = new PushRepo(openDb(":memory:"));
    const statuses: Record<string, number> = { "1": 201, "2": 410, "3": 404, "4": 500 };
    const sent: string[] = [];
    const sender: PushSender = {
      async send(t, payload) {
        sent.push(payload);
        return statuses[t.endpoint.split("/").pop()!]!;
      },
    };
    const push = new PushService(repo, sender, "pk");
    for (const n of [1, 2, 3, 4]) push.subscribe(target(n), "a@example.com", new Date());
    const r = await push.notifyAll({ title: "t", body: "b", url: "/#messages" });
    expect(r).toEqual({ sent: 1, removed: 2, failed: 1 });
    expect(repo.all().map((x) => x.endpoint).sort()).toEqual([target(1).endpoint, target(4).endpoint]);
    expect(JSON.parse(sent[0]!)).toEqual({ title: "t", body: "b", url: "/#messages" });
  });

  it("許可されていない送り先は購読できない", () => {
    const push = new PushService(new PushRepo(openDb(":memory:")), { send: async () => 201 }, "pk");
    expect(() => push.subscribe({ endpoint: "https://evil.example/", p256dh: "p", auth: "a" }, "a@example.com", new Date())).toThrow();
  });
});
