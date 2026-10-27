// Web Push の送信（016）。暗号化は RFC 8291（aes128gcm）、送り手の証明は VAPID（RFC 8292）。
// 中身はスマホのブラウザでしか開けない形に暗号化するので、途中のプッシュの仕組み（Google など）には読めない。
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { importJWK, SignJWT } from "jose";

export interface VapidKeys {
  /** 公開鍵（P-256 の非圧縮形式 65 バイト、base64url） */
  publicKey: string;
  /** 秘密鍵（32 バイト、base64url）。ログや画面に出さない */
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  /** ブラウザの公開鍵（base64url） */
  p256dh: string;
  /** ブラウザの認証用の値（base64url） */
  auth: string;
}

export interface PushSender {
  /** 送って、プッシュの仕組みが返した HTTP の状態コードを返す */
  send(target: PushTarget, payload: string): Promise<number>;
}

/** 受け付ける送り先（ブラウザのプッシュの仕組み）。ほかの宛先には送らない */
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    return PUSH_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: ecdh.getPrivateKey().toString("base64url") };
}

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** RFC 8291 の暗号化。テストのために、送り手の鍵と salt を外から渡せる */
export function encryptPayload(
  payload: Buffer,
  target: Pick<PushTarget, "p256dh" | "auth">,
  fixed?: { asPrivateKey: Buffer; salt: Buffer },
): Buffer {
  const uaPublic = Buffer.from(target.p256dh, "base64url");
  const authSecret = Buffer.from(target.auth, "base64url");
  const as = createECDH("prime256v1");
  if (fixed) as.setPrivateKey(fixed.asPrivateKey);
  else as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const salt = fixed?.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 1 レコードだけなので、最後のレコードの区切り（0x02）を付ける
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** VAPID の Authorization ヘッダー */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now: Date): Promise<string> {
  const pub = Buffer.from(keys.publicKey, "base64url");
  const key = await importJWK(
    {
      kty: "EC",
      crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33, 65).toString("base64url"),
      d: keys.privateKey,
    },
    "ES256",
  );
  const jwt = await new SignJWT({ sub: subject })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setAudience(new URL(endpoint).origin)
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 12 * 3600)
    .sign(key);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

export class WebPushSender implements PushSender {
  constructor(
    private readonly keys: VapidKeys,
    /** 送り手の連絡先（VAPID の sub）。サーバーの URL */
    private readonly subject: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** 届けられないときに、プッシュの仕組みが持っておく時間 */
    private readonly ttlSeconds = 86_400,
  ) {}

  async send(target: PushTarget, payload: string): Promise<number> {
    if (!isAllowedEndpoint(target.endpoint)) throw new Error("push endpoint not allowed");
    const body = encryptPayload(Buffer.from(payload, "utf8"), target);
    const res = await this.fetchImpl(target.endpoint, {
      method: "POST",
      headers: {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(this.ttlSeconds),
        Urgency: "high",
        Authorization: await vapidAuthorization(target.endpoint, this.keys, this.subject, new Date()),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  }
}
