// Xiaozhi の OTA の口。端末は起動時にここへ問い合わせ、接続先・トークン・時刻・新しいファームウェアを受け取る。
// 未承認の端末には6桁の承認番号を返し、端末はそれを画面に出して /activate で承認を待つ。
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Clock } from "../../core/ports.js";
import type { DevicesRepo } from "../../db/devices-repo.js";
import { log } from "../../log.js";

export interface OtaConfig {
  /** "websocket" か "mqtt" */
  transport: () => "websocket" | "mqtt";
  websocketUrl: () => string;
  mqtt?: () => { endpoint: string; clientIdPrefix: string };
  /** 配る新しいファームウェア（006） */
  firmware?: () => { version: string; url: string } | undefined;
  timezoneOffsetMinutes: number;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export const ACTIVATION_MESSAGE = "確認画面で、この番号を承認してください";

export function registerOta(app: FastifyInstance, devices: DevicesRepo, clock: Clock, cfg: OtaConfig): void {
  const handler = async (req: FastifyRequest) => {
    const deviceId = header(req, "device-id");
    const clientId = header(req, "client-id");
    const now = clock.now();
    const body = (typeof req.body === "object" && req.body) || {};
    const firmwareVersion = (body as { application?: { version?: string } }).application?.version;
    const res: Record<string, unknown> = {
      server_time: { timestamp: now.getTime(), timezone_offset: cfg.timezoneOffsetMinutes },
    };
    if (!deviceId || !clientId) {
      return res;
    }
    let row = devices.ensurePending(deviceId, clientId, now);
    // 端末の中の ID（Client-Id）が変わった＝別の端末か初期化された端末なので、承認し直す
    if (row.status === "approved" && row.client_id !== clientId) {
      log.warn("client id changed; re-approval required", { deviceIdSuffix: deviceId.slice(-5) });
      devices.resetToPending(deviceId, clientId, now);
      row = devices.get(deviceId)!;
    }
    devices.touch(deviceId, now, firmwareVersion);
    if (row.status !== "approved") {
      res.activation = {
        code: row.activation_code,
        message: ACTIVATION_MESSAGE,
        challenge: randomBytes(16).toString("hex"),
        timeout_ms: 30000,
      };
      return res;
    }
    const token = devices.issueToken(deviceId);
    if (cfg.transport() === "mqtt" && cfg.mqtt) {
      const m = cfg.mqtt();
      res.mqtt = {
        endpoint: m.endpoint,
        client_id: `${m.clientIdPrefix}${deviceId.replaceAll(":", "")}`,
        username: deviceId,
        password: token,
        publish_topic: "device-server",
        subscribe_topic: `devices/p2p/${deviceId.replaceAll(":", "")}`,
        keepalive: 240,
      };
    } else {
      res.websocket = { url: cfg.websocketUrl(), token, version: 1 };
    }
    const fw = cfg.firmware?.();
    if (fw) res.firmware = fw;
    return res;
  };

  app.post("/xiaozhi/ota/", handler);
  app.get("/xiaozhi/ota/", handler);

  // 承認待ちの端末が問い合わせる。承認済みなら 200、まだなら 202
  app.post("/xiaozhi/ota/activate", async (req, reply) => {
    const deviceId = header(req, "device-id");
    const clientId = header(req, "client-id");
    const row = deviceId ? devices.get(deviceId) : undefined;
    if (row && row.status === "approved" && row.client_id === clientId) return reply.code(200).send({ ok: true });
    return reply.code(202).send({ pending: true });
  });
}
