// Xiaozhi の MQTT＋UDP の口。端末は MQTT でつなぎっぱなしにし（通知に使う）、会話の音声は UDP で送る。
// UDP の音声は AES-128-CTR で暗号化される。パケットの先頭 16 バイトがそのまま初期ベクトル（IV）になる：
//   |type 1|flags 1|payload_len 2|ssrc 4|timestamp 4|sequence 4|payload ...|
// 端末は購読（subscribe）をしないので、ブローカーから接続ごとに直接メッセージを届ける。
import { createCipheriv, randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { createServer, type Server } from "node:net";
import { Aedes, type Client } from "aedes";
import type { DeviceHub } from "../../app/hub.js";
import type { DevicesRepo } from "../../db/devices-repo.js";
import { errorFields, log } from "../../log.js";
import type { DeviceLink } from "./link.js";
import { DOWNLINK_RATE, FRAME_MS } from "./opus.js";

export const PUBLISH_TOPIC = "device-server";
const HEADER = 16;

export interface MqttUdpOptions {
  mqttPort: number;
  udpPort: number;
  /** 端末から見た UDP の接続先（hello で端末に伝える） */
  udpPublicHost: string;
  udpPublicPort?: number;
  /** UDP を受ける住所（Fly.io では fly-global-services） */
  udpBindHost?: string;
}

function aesCtr(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const c = createCipheriv("aes-128-ctr", key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

interface AudioSession {
  sessionId: string;
  ssrc: number;
  key: Buffer;
  nonce: Buffer;
  remote?: RemoteInfo;
  localSeq: number;
  remoteSeq: number;
  startedAt: number;
}

class MqttLink implements DeviceLink {
  readonly kind = "mqtt" as const;
  sessionId = "";
  audio?: AudioSession;
  constructor(
    readonly deviceId: string,
    private readonly client: Client,
    private readonly udp: Socket,
    private readonly onClosed: (link: MqttLink) => void,
  ) {}
  get audioOpen() {
    return !!this.audio;
  }
  get topic() {
    return `devices/p2p/${this.deviceId.replaceAll(":", "")}`;
  }
  sendJson(obj: Record<string, unknown>) {
    if (this.client.closed) return;
    this.client.publish(
      { cmd: "publish", topic: this.topic, payload: Buffer.from(JSON.stringify(obj)), qos: 0, retain: false, dup: false },
      (err) => err && log.warn("mqtt publish failed", errorFields(err)),
    );
  }
  sendAudio(opus: Buffer) {
    const a = this.audio;
    if (!a?.remote) return;
    const header = Buffer.from(a.nonce);
    header.writeUInt16BE(opus.length, 2);
    header.writeUInt32BE((Date.now() - a.startedAt) >>> 0, 8);
    header.writeUInt32BE(++a.localSeq >>> 0, 12);
    const packet = Buffer.concat([header, aesCtr(a.key, header, opus)]);
    this.udp.send(packet, a.remote.port, a.remote.address);
  }
  closeAudioChannel() {
    if (!this.audio) return;
    this.sendJson({ type: "goodbye", session_id: this.sessionId });
    this.onClosed(this);
  }
}

export interface MqttUdpServer {
  close(): Promise<void>;
  mqttPort(): number;
  udpPort(): number;
}

export async function startMqttUdp(hub: DeviceHub, devices: DevicesRepo, opts: MqttUdpOptions): Promise<MqttUdpServer> {
  const broker = await Aedes.createBroker({ maxClientsIdLength: 64 });
  const udp = createSocket("udp4");
  const links = new Map<string, MqttLink>(); // client.id → link
  const bySsrc = new Map<number, MqttLink>();

  broker.authenticate = (client, username, password, done) => {
    const deviceId = username ?? "";
    const ok = !!deviceId && !!password && devices.verifyToken(deviceId, password.toString());
    if (!ok) log.warn("mqtt auth failed", { hasUser: !!username });
    (client as Client & { deviceId?: string }).deviceId = ok ? deviceId : undefined;
    done(null, ok);
  };
  // 端末どうしで購読・転送させない
  broker.authorizeSubscribe = (_client, _sub, done) => done(new Error("subscribe not allowed"), null);
  broker.authorizePublish = (client, packet, done) => {
    if (!client || packet.topic !== PUBLISH_TOPIC) return done(new Error("topic not allowed"));
    done(null);
  };

  const closeAudio = (link: MqttLink) => {
    if (!link.audio) return;
    bySsrc.delete(link.audio.ssrc);
    link.audio = undefined;
    hub.onAudioClosed(link.deviceId);
  };

  broker.on("clientReady", (client) => {
    const deviceId = (client as Client & { deviceId?: string }).deviceId;
    if (!deviceId) return;
    const link = new MqttLink(deviceId, client, udp, closeAudio);
    links.set(client.id, link);
    hub.attach(link);
    devices.touch(deviceId, new Date());
    log.info("device connected", { transport: "mqtt", deviceIdSuffix: deviceId.slice(-5) });
  });
  broker.on("clientDisconnect", (client) => {
    const link = links.get(client.id);
    if (!link) return;
    links.delete(client.id);
    if (link.audio) bySsrc.delete(link.audio.ssrc);
    link.audio = undefined;
    hub.detach(link);
    log.info("device disconnected", { transport: "mqtt", deviceIdSuffix: link.deviceId.slice(-5) });
  });

  broker.on("publish", (packet, client) => {
    if (!client || packet.topic !== PUBLISH_TOPIC) return;
    const link = links.get(client.id);
    if (!link) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(packet.payload.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      if (link.audio) closeAudio(link);
      const key = randomBytes(16);
      const nonce = randomBytes(16);
      nonce[0] = 0x01;
      nonce[1] = 0;
      nonce.writeUInt16BE(0, 2);
      let ssrc = nonce.readUInt32BE(4);
      while (bySsrc.has(ssrc)) {
        ssrc = (ssrc + 1) >>> 0;
        nonce.writeUInt32BE(ssrc, 4);
      }
      nonce.fill(0, 8);
      link.sessionId = randomBytes(8).toString("hex");
      link.audio = { sessionId: link.sessionId, ssrc, key, nonce, localSeq: 0, remoteSeq: 0, startedAt: Date.now() };
      bySsrc.set(ssrc, link);
      link.sendJson({
        type: "hello",
        transport: "udp",
        session_id: link.sessionId,
        audio_params: { format: "opus", sample_rate: DOWNLINK_RATE, channels: 1, frame_duration: FRAME_MS },
        udp: {
          server: opts.udpPublicHost,
          port: opts.udpPublicPort ?? udp.address().port,
          key: key.toString("hex"),
          nonce: nonce.toString("hex"),
        },
      });
      hub.onHello(link.deviceId);
      return;
    }
    if (msg.type === "goodbye") {
      closeAudio(link);
      return;
    }
    hub.onJson(link.deviceId, msg);
  });

  let udpSeen = 0;
  udp.on("message", (data, rinfo) => {
    // 調べもの用：最初の数パケットだけ、届いたことをログに出す（中身は出さない）
    if (udpSeen < 3 && log.isDebug()) {
      udpSeen++;
      log.debug("udp packet", { bytes: data.length, type: data[0], knownSsrc: data.length >= 8 && bySsrc.has(data.readUInt32BE(4)) });
    }
    if (data.length < HEADER || data[0] !== 0x01) return;
    const ssrc = data.readUInt32BE(4);
    const link = bySsrc.get(ssrc);
    const a = link?.audio;
    if (!link || !a) return;
    const len = data.readUInt16BE(2);
    if (data.length !== HEADER + len) return;
    const seq = data.readUInt32BE(12);
    if (seq <= a.remoteSeq) return; // 古い・重複したパケット（再送攻撃への対策）
    const header = data.subarray(0, HEADER);
    const opus = aesCtr(a.key, Buffer.from(header), data.subarray(HEADER));
    a.remoteSeq = seq;
    a.remote = rinfo; // 端末の住所（NAT の先）。下りの音声はここへ送る
    hub.onAudio(link.deviceId, opus);
  });
  udp.on("error", (err) => log.error("udp error", errorFields(err)));

  const tcp: Server = createServer(broker.handle);
  await new Promise<void>((r) => tcp.listen(opts.mqttPort, r));
  await new Promise<void>((r) => udp.bind(opts.udpPort, opts.udpBindHost, r));
  log.info("mqtt/udp started", { mqttPort: opts.mqttPort, udpPort: opts.udpPort });

  return {
    mqttPort: () => {
      const a = tcp.address();
      return typeof a === "object" && a ? a.port : opts.mqttPort;
    },
    udpPort: () => udp.address().port,
    async close() {
      for (const l of links.values()) hub.detach(l);
      await new Promise<void>((r) => broker.close(() => r()));
      await new Promise<void>((r) => tcp.close(() => r()));
      udp.close();
    },
  };
}
