// 音量のツール。端末の音量は 0〜100 で、-50〜0dB に等間隔で割り当てられる（esp_codec_dev の既定）。
// そのため 50 未満はほとんど聞こえない。声で使う段階（0〜10）は、聞こえる範囲（37〜100）に割り当てる。
//   段階 0 → 0（消音）、1 → 37、5 → 65、10 → 100。1段階は約 3.5dB
import type { Tool } from "./registry.js";

const BASE = 30;
const STEP = 7;

export function levelToVolume(level: number): number {
  if (level <= 0) return 0;
  return Math.min(100, BASE + STEP * Math.round(level));
}

export function volumeToLevel(volume: number): number {
  if (volume <= 0) return 0;
  return Math.max(1, Math.min(10, Math.round((volume - BASE) / STEP)));
}

export function volumeTool(): Tool {
  return {
    reply: true,
    def: {
      name: "set_volume",
      description:
        "スピーカーの音量を変える。level は 0〜10 の段階（10 が最大、0 は消音）。「上げて」「下げて」のときは change に up / down を入れ、level は省略する。",
      inputSchema: {
        type: "object",
        properties: {
          level: { type: "integer", description: "0〜10 の段階" },
          change: { type: "string", enum: ["up", "down"] },
        },
        additionalProperties: false,
      },
    },
    async run(input, ctx) {
      if (!ctx.device) throw new Error("端末につながっていません");
      let level: number;
      if (typeof input.level === "number") {
        if (input.level < 0 || input.level > 10) throw new Error("level は 0〜10");
        level = input.level;
      } else if (input.change === "up" || input.change === "down") {
        const current = volumeToLevel((await ctx.device.getVolume()) ?? 65);
        level = Math.max(0, Math.min(10, current + (input.change === "up" ? 1 : -1)));
      } else {
        throw new Error("level か change のどちらかが必要");
      }
      const volume = levelToVolume(level);
      await ctx.device.setVolume(volume);
      return { ok: true, level, volume };
    },
  };
}
