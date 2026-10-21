// Xiaozhi のプロトコルを話す偽の端末（テストと tools/fake-device.ts で使う）
import { WebSocket } from "ws";

export interface OtaResult {
  status: number;
  body: Record<string, any>;
}

export async function callOta(baseUrl: string, deviceId: string, clientId: string): Promise<OtaResult> {
  const res = await fetch(new URL("/xiaozhi/ota/", baseUrl), {
    method: "POST",
    headers: { "Device-Id": deviceId, "Client-Id": clientId, "Content-Type": "application/json" },
    body: JSON.stringify({ application: { version: "2.5.2" } }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export async function callActivate(baseUrl: string, deviceId: string, clientId: string): Promise<number> {
  const res = await fetch(new URL("/xiaozhi/ota/activate", baseUrl), {
    method: "POST",
    headers: { "Device-Id": deviceId, "Client-Id": clientId, "Content-Type": "application/json" },
    body: "{}",
  });
  return res.status;
}

export class FakeXiaozhiDevice {
  ws?: WebSocket;
  readonly json: Record<string, any>[] = [];
  readonly audio: Buffer[] = [];
  sessionId = "";
  private waiters: { pred: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }[] = [];
  closed = false;

  constructor(
    private readonly url: string,
    private readonly deviceId: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Protocol-Version": "1",
        "Device-Id": this.deviceId,
        "Client-Id": "test-client",
      },
    });
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.audio.push(data as Buffer);
        return;
      }
      const msg = JSON.parse(String(data)) as Record<string, any>;
      this.json.push(msg);
      if (msg.type === "mcp") this.answerMcp(msg.payload);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on("close", () => (this.closed = true));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    ws.send(
      JSON.stringify({
        type: "hello",
        version: 1,
        transport: "websocket",
        features: { mcp: true },
        audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 },
      }),
    );
    const hello = await this.waitFor((m) => m.type === "hello");
    this.sessionId = hello.session_id;
  }

  /** 端末の MCP サーバーの代わりに応答する（音量） */
  volume = 70;
  private answerMcp(p: any) {
    if (!p || typeof p.id !== "number") return;
    let result: unknown = {};
    if (p.method === "tools/list") result = { tools: [{ name: "self.audio_speaker.set_volume" }] };
    if (p.method === "tools/call" && p.params?.name === "self.audio_speaker.set_volume") {
      this.volume = p.params.arguments.volume;
      result = { content: [{ type: "text", text: "true" }], isError: false };
    }
    if (p.method === "tools/call" && p.params?.name === "self.get_device_status") {
      result = { content: [{ type: "text", text: JSON.stringify({ audio_speaker: { volume: this.volume } }) }] };
    }
    this.send({ type: "mcp", payload: { jsonrpc: "2.0", id: p.id, result } });
  }

  send(obj: Record<string, unknown>) {
    this.ws!.send(JSON.stringify({ session_id: this.sessionId, ...obj }));
  }
  sendAudio(opus: Buffer) {
    this.ws!.send(opus, { binary: true });
  }
  startListening(mode: "auto" | "manual" = "auto") {
    this.send({ type: "listen", state: "start", mode });
  }

  waitFor(pred: (m: Record<string, any>) => boolean, timeoutMs = 10000): Promise<Record<string, any>> {
    const found = this.json.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  waitClosed(timeoutMs = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return resolve();
      const t = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
      this.ws!.once("close", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  close() {
    this.ws?.close();
  }
}
