// MQTT＋UDP で話す偽の端末（テスト用）
import { createCipheriv } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import mqtt, { type MqttClient } from "mqtt";

const aes = (key: Buffer, iv: Buffer, data: Buffer) => {
  const c = createCipheriv("aes-128-ctr", key, iv);
  return Buffer.concat([c.update(data), c.final()]);
};

export class FakeMqttDevice {
  client?: MqttClient;
  udp?: Socket;
  readonly json: Record<string, any>[] = [];
  readonly audio: Buffer[] = [];
  private key?: Buffer;
  private nonce?: Buffer;
  private udpTarget?: { host: string; port: number };
  private seq = 0;
  private remoteSeq = 0;
  sessionId = "";
  volume = 70;
  udpConnected = false;
  /** 届いた UDP の送り元（調べもの用） */
  readonly udpFrom = new Set<string>();
  private waiters: { pred: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }[] = [];

  constructor(private readonly mqttCfg: Record<string, any>) {}

  async connect(): Promise<void> {
    const [host, port] = String(this.mqttCfg.endpoint).split(":");
    this.client = mqtt.connect({
      host,
      port: Number(port),
      // 8883 は TLS（クラウド）。それ以外は TLS なし（ローカル）
      protocol: Number(port) === 8883 ? "mqtts" : "mqtt",
      clientId: this.mqttCfg.client_id,
      username: this.mqttCfg.username,
      password: this.mqttCfg.password,
      keepalive: 60,
      reconnectPeriod: 0,
    });
    this.client.on("message", (_topic, payload) => {
      const msg = JSON.parse(payload.toString()) as Record<string, any>;
      this.json.push(msg);
      if (msg.type === "hello") {
        this.sessionId = msg.session_id;
        this.key = Buffer.from(msg.udp.key, "hex");
        this.nonce = Buffer.from(msg.udp.nonce, "hex");
        this.udpTarget = { host: msg.udp.server, port: msg.udp.port };
        // 実機と同じく、相手を決めた接続にする（決めた相手以外からのパケットは OS が捨てる）
        if (process.env.FAKE_UDP_CONNECT === "1" && this.udp) {
          this.udp.connect(msg.udp.port, msg.udp.server, () => (this.udpConnected = true));
        }
        this.seq = 0;
        this.remoteSeq = 0;
      }
      if (msg.type === "mcp") this.answerMcp(msg.payload);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.client!.once("connect", () => resolve());
      this.client!.once("error", reject);
      this.client!.once("close", () => reject(new Error("closed")));
    });
    this.udp = createSocket("udp4");
    this.udp.on("message", (data, rinfo) => {
      this.udpFrom.add(`${rinfo.address}:${rinfo.port}`);
      const len = data.readUInt16BE(2);
      const seq = data.readUInt32BE(12);
      if (seq <= this.remoteSeq || data.length !== 16 + len) return;
      this.remoteSeq = seq;
      this.audio.push(aes(this.key!, data.subarray(0, 16), data.subarray(16)));
    });
    // ローカルのサーバーなら 127.0.0.1、クラウドなら全部の住所で開く（127.0.0.1 で開くと外へ送れない）
    const local = /^(127\.|localhost)/.test(host ?? "");
    await new Promise<void>((r) => this.udp!.bind(0, local ? "127.0.0.1" : "0.0.0.0", r));
  }

  private answerMcp(p: any) {
    if (!p || typeof p.id !== "number") return;
    let result: unknown = {};
    if (p.method === "tools/list") result = { tools: [{ name: "self.audio_speaker.set_volume" }] };
    if (p.method === "tools/call" && p.params?.name === "self.audio_speaker.set_volume") this.volume = p.params.arguments.volume;
    if (p.method === "tools/call" && p.params?.name === "self.get_device_status") {
      result = { content: [{ type: "text", text: JSON.stringify({ audio_speaker: { volume: this.volume } }) }] };
    }
    this.publish({ session_id: this.sessionId, type: "mcp", payload: { jsonrpc: "2.0", id: p.id, result } });
  }

  publish(obj: Record<string, unknown>) {
    this.client!.publish(this.mqttCfg.publish_topic, JSON.stringify(obj));
  }

  async openAudio(): Promise<void> {
    this.publish({ type: "hello", version: 3, transport: "udp", audio_params: { format: "opus", sample_rate: 16000, channels: 1, frame_duration: 60 } });
    await this.waitFor((m) => m.type === "hello");
  }
  startListening() {
    this.publish({ session_id: this.sessionId, type: "listen", state: "start", mode: "auto" });
  }
  goodbye() {
    this.publish({ session_id: this.sessionId, type: "goodbye" });
  }

  sendAudio(opus: Buffer) {
    const header = Buffer.from(this.nonce!);
    header.writeUInt16BE(opus.length, 2);
    header.writeUInt32BE(0, 8);
    header.writeUInt32BE(++this.seq, 12);
    const pkt = Buffer.concat([header, aes(this.key!, header, opus)]);
    if (this.udpConnected) this.udp!.send(pkt);
    else this.udp!.send(pkt, this.udpTarget!.port, this.udpTarget!.host);
  }
  /** 同じシーケンス番号で送り直す（再送攻撃の確認用） */
  replay(opus: Buffer) {
    const header = Buffer.from(this.nonce!);
    header.writeUInt16BE(opus.length, 2);
    header.writeUInt32BE(this.seq, 12);
    this.udp!.send(Buffer.concat([header, aes(this.key!, header, opus)]), this.udpTarget!.port, this.udpTarget!.host);
  }

  waitFor(pred: (m: Record<string, any>) => boolean, timeoutMs = 10000): Promise<Record<string, any>> {
    const found = this.json.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("waitFor timeout")), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  async close() {
    this.udp?.close();
    await this.client?.endAsync();
  }
}
