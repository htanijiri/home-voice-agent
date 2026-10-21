// 端末の登録と承認
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";

export interface DeviceRow {
  device_id: string;
  client_id: string | null;
  status: "pending" | "approved";
  activation_code: string | null;
  token_hash: string | null;
  created_at: string;
  approved_at: string | null;
  last_seen_at: string | null;
  firmware_version: string | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class DevicesRepo {
  constructor(private readonly db: Db) {}

  get(deviceId: string): DeviceRow | undefined {
    return this.db.prepare("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as DeviceRow | undefined;
  }

  list(): DeviceRow[] {
    return this.db.prepare("SELECT * FROM devices ORDER BY created_at").all() as DeviceRow[];
  }

  /** 未登録の端末を「承認待ち」で登録し、6桁の承認番号を発行する。既にあればそのまま返す */
  ensurePending(deviceId: string, clientId: string | undefined, now: Date): DeviceRow {
    const existing = this.get(deviceId);
    if (existing) return existing;
    for (let i = 0; i < 20; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      try {
        this.db
          .prepare(
            "INSERT INTO devices (device_id, client_id, status, activation_code, created_at) VALUES (?, ?, 'pending', ?, ?)",
          )
          .run(deviceId, clientId ?? null, code, now.toISOString());
        return this.get(deviceId)!;
      } catch (err) {
        if (!String(err).includes("UNIQUE")) throw err;
      }
    }
    throw new Error("could not allocate activation code");
  }

  /** 承認を取り消して承認待ちに戻し、新しい承認番号を発行する */
  resetToPending(deviceId: string, clientId: string, now: Date): void {
    this.db.prepare("DELETE FROM devices WHERE device_id = ?").run(deviceId);
    this.ensurePending(deviceId, clientId, now);
  }

  /** 承認番号で端末を承認する。承認した端末の ID を返す */
  approveByCode(code: string, now: Date): string | undefined {
    const row = this.db
      .prepare("SELECT device_id FROM devices WHERE status = 'pending' AND activation_code = ?")
      .get(code) as { device_id: string } | undefined;
    if (!row) return undefined;
    this.db
      .prepare("UPDATE devices SET status = 'approved', approved_at = ?, activation_code = NULL WHERE device_id = ?")
      .run(now.toISOString(), row.device_id);
    return row.device_id;
  }

  /** 承認済みの端末に新しいトークンを発行する（データベースにはハッシュだけを保存する） */
  issueToken(deviceId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("UPDATE devices SET token_hash = ? WHERE device_id = ? AND status = 'approved'").run(hash(token), deviceId);
    return token;
  }

  verifyToken(deviceId: string, token: string): boolean {
    const row = this.get(deviceId);
    if (!row || row.status !== "approved" || !row.token_hash) return false;
    const a = Buffer.from(row.token_hash, "hex");
    const b = Buffer.from(hash(token), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** トークンから端末を探す（MQTT の認証など、端末 ID が別に来ない場合） */
  findByToken(token: string): DeviceRow | undefined {
    return this.db
      .prepare("SELECT * FROM devices WHERE status = 'approved' AND token_hash = ?")
      .get(hash(token)) as DeviceRow | undefined;
  }

  touch(deviceId: string, now: Date, firmwareVersion?: string): void {
    this.db
      .prepare("UPDATE devices SET last_seen_at = ?, firmware_version = COALESCE(?, firmware_version) WHERE device_id = ?")
      .run(now.toISOString(), firmwareVersion ?? null, deviceId);
  }
}
