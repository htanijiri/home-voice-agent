// Xiaozhi の WebSocket の口。端末は会話のたびに接続し、会話が終わると切断する。
// 認証：Authorization（Bearer トークン）と Device-Id を確かめる。
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { DeviceHub } from "../../app/hub.js";
import type { DevicesRepo } from "../../db/devices-repo.js";
import { errorFields, log } from "../../log.js";
import type { DeviceLink } from "./link.js";
import { DOWNLINK_RATE, FRAME_MS } from "./opus.js";

export const WS_PATH = "/xiaozhi/v1/";

class WsLink implements DeviceLink {
  readonly kind = "websocket" as const;
  sessionId = randomUUID();
  constructor(
    readonly deviceId: string,
    private readonly ws: WebSocket,
  ) {}
  get audioOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }
  sendJson(obj: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
  sendAudio(opus: Buffer) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(opus, { binary: true });
  }
  closeAudioChannel() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "bye");
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function attachWebSocket(server: Server, hub: DeviceHub, devices: DevicesRepo): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== WS_PATH && url.pathname !== WS_PATH.slice(0, -1)) return; // 他の口に任せる
    const deviceId = headerOf(req, "device-id");
    const auth = headerOf(req, "authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!deviceId || !token || !devices.verifyToken(deviceId, token)) {
      log.warn("websocket auth failed", { hasDeviceId: !!deviceId, hasToken: !!token });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, deviceId));
  });

  function onConnection(ws: WebSocket, deviceId: string) {
    const link = new WsLink(deviceId, ws);
    hub.attach(link);
    log.info("device connected", { transport: "websocket", deviceIdSuffix: deviceId.slice(-5) });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        hub.onAudio(deviceId, data as Buffer);
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        link.sendJson({
          type: "hello",
          transport: "websocket",
          session_id: link.sessionId,
          audio_params: { format: "opus", sample_rate: DOWNLINK_RATE, channels: 1, frame_duration: FRAME_MS },
        });
        hub.onHello(deviceId);
        return;
      }
      hub.onJson(deviceId, msg);
    });
    ws.on("close", () => {
      hub.detach(link);
      log.info("device disconnected", { transport: "websocket", deviceIdSuffix: deviceId.slice(-5) });
    });
    ws.on("error", (err) => log.warn("websocket error", errorFields(err)));
  }

  return wss;
}
