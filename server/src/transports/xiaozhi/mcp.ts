// 端末の MCP サーバー（音量など）を呼ぶ。メッセージの運び方（WebSocket / MQTT）は send で受け取る。
import type { DeviceControl } from "../../core/tools/registry.js";

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

export class McpClient implements DeviceControl {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private initialized?: Promise<unknown>;
  tools: string[] = [];

  constructor(private send: (payload: unknown) => void) {}

  rebind(send: (payload: unknown) => void) {
    this.send = send;
    this.initialized = undefined;
  }

  /** 端末から来た MCP のメッセージ（JSON-RPC の応答） */
  onMessage(payload: { id?: number; result?: unknown; error?: { message?: string } }) {
    if (typeof payload.id !== "number") return;
    const p = this.pending.get(payload.id);
    if (!p) return;
    this.pending.delete(payload.id);
    clearTimeout(p.timer);
    if (payload.error) p.reject(new Error(payload.error.message ?? "mcp error"));
    else p.resolve(payload.result);
  }

  private request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  initialize(): Promise<unknown> {
    this.initialized ??= this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "home-voice-agent", version: "0.1.0" },
    }).then(async (r) => {
      const list = (await this.request("tools/list", {})) as { tools?: { name: string }[] };
      this.tools = (list.tools ?? []).map((t) => t.name);
      return r;
    });
    return this.initialized;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    return this.request("tools/call", { name, arguments: args });
  }

  async setVolume(volume: number): Promise<void> {
    await this.callTool("self.audio_speaker.set_volume", { volume: Math.round(volume) });
  }

  async getVolume(): Promise<number | undefined> {
    const r = (await this.callTool("self.get_device_status", {})) as { content?: { text?: string }[] };
    const text = r.content?.[0]?.text;
    if (!text) return undefined;
    try {
      const status = JSON.parse(text) as { audio_speaker?: { volume?: number } };
      return status.audio_speaker?.volume;
    } catch {
      return undefined;
    }
  }

  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("mcp closed"));
    }
    this.pending.clear();
  }
}
