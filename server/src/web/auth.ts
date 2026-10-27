// 確認画面のログイン（Google の OpenID Connect、認可コード＋PKCE）。
// ID トークンの署名・発行者・宛先・期限・nonce を検証し、メールアドレスが確認済みで許可リストにある人だけを通す。
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Db } from "../db/db.js";

export interface OidcConfig {
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  issuers: string[];
  jwks: JWTVerifyGetKey;
  allowedEmails: string[];
}

export function googleOidc(clientId: string, clientSecret: string, allowedEmails: string[]): OidcConfig {
  return {
    clientId,
    clientSecret,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    jwks: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
    allowedEmails,
  };
}

const b64url = (b: Buffer) => b.toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest();

interface PendingLogin {
  verifier: string;
  nonce: string;
  expiresAt: number;
}

export class LoginError extends Error {}

export const SESSION_DAYS = 30;

export class WebAuth {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(
    private readonly db: Db,
    private readonly oidc: OidcConfig,
    private readonly redirectUri: () => string,
  ) {}

  /** ログインの開始。Google の画面の URL を返す */
  begin(): string {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(24));
    this.pending.set(state, { verifier, nonce, expiresAt: now + 10 * 60_000 });
    const u = new URL(this.oidc.authorizationEndpoint);
    u.search = new URLSearchParams({
      client_id: this.oidc.clientId,
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: b64url(sha256(verifier)),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return u.toString();
  }

  /** Google から戻ってきたとき。ログインできたらメールアドレスと名前（連絡の送り主の表示に使う。016）を返す */
  async complete(state: string, code: string, fetchImpl: typeof fetch = fetch): Promise<{ email: string; name?: string }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expiresAt < Date.now()) throw new LoginError("ログインの手続きの期限が切れました。もう一度お試しください");
    const res = await fetchImpl(this.oidc.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri(),
        client_id: this.oidc.clientId,
        client_secret: this.oidc.clientSecret,
        code_verifier: p.verifier,
      }),
    });
    if (!res.ok) throw new LoginError("Google からの応答を確認できませんでした");
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new LoginError("Google からの応答を確認できませんでした");
    const { payload } = await jwtVerify(body.id_token, this.oidc.jwks, {
      issuer: this.oidc.issuers,
      audience: this.oidc.clientId,
    }).catch(() => {
      throw new LoginError("ログインの情報を確認できませんでした");
    });
    if (payload.nonce !== p.nonce) throw new LoginError("ログインの情報を確認できませんでした");
    const email = String(payload.email ?? "").toLowerCase();
    if (payload.email_verified !== true || !email) throw new LoginError("メールアドレスが確認されていないアカウントです");
    if (!this.oidc.allowedEmails.includes(email)) throw new LoginError("このアカウントは登録されていません");
    const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 40) : undefined;
    return { email, name };
  }

  createSession(email: string, now = new Date(), name?: string): { id: string; csrf: string; expires: Date } {
    const id = b64url(randomBytes(32));
    const csrf = b64url(randomBytes(24));
    const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
    this.db
      .prepare("INSERT INTO web_sessions (id_hash, email, csrf, created_at, expires_at, name) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(id).toString("hex"), email, csrf, now.toISOString(), expires.toISOString(), name ?? null);
    return { id, csrf, expires };
  }

  getSession(id: string | undefined, now = new Date()): { email: string; csrf: string; name?: string } | undefined {
    if (!id) return undefined;
    const row = this.db
      .prepare("SELECT email, csrf, expires_at, name FROM web_sessions WHERE id_hash = ?")
      .get(sha256(id).toString("hex")) as { email: string; csrf: string; expires_at: string; name: string | null } | undefined;
    if (!row || row.expires_at < now.toISOString()) return undefined;
    // 許可リストから外された人は入れない
    if (!this.oidc.allowedEmails.includes(row.email)) return undefined;
    return { email: row.email, csrf: row.csrf, name: row.name ?? undefined };
  }

  /** 確認画面に入れる人のメールアドレス */
  get allowedEmails(): string[] {
    return this.oidc.allowedEmails;
  }

  deleteSession(id: string | undefined) {
    if (id) this.db.prepare("DELETE FROM web_sessions WHERE id_hash = ?").run(sha256(id).toString("hex"));
  }

  purge(now = new Date()) {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(now.toISOString());
  }
}
