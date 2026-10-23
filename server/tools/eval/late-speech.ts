// 011 AC7：「アイリス」のあと、少し間を置いて話し始めた声を、本物の Google STT で聞き取れるか。
// 離れた場所の声（009 の記録：まわりの音 RMS 約 20、声 約 100）に近い大きさにし、声の始まりを聞き取りの開始から 5.5 秒後（ファイルの頭の無音を含む）にずらして、
// VoiceSession に実時間で流す。LLM と読み上げは偽物を使う（聞き取りだけを見る）。
// 改善前の判定は「6 秒のうちに Google の話し始めの合図が来たか」で示す（来なければ、改善前は声を捨てて「聞き取れませんでした」だった）。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoogleStt } from "../../src/adapters/stt-google.js";
import { loadConfig, loadDotEnv, loadSecrets } from "../../src/config.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { systemClock } from "../../src/core/ports.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { type TurnRecord, VoiceSession } from "../../src/core/voice-session.js";
import { FakeLlm, FakeTts, RecordingSink } from "../../test/fakes.js";

loadDotEnv(resolve(process.cwd(), ".env"));
const config = loadConfig();
const secrets = loadSecrets();
if (!secrets.googleCloudProject) throw new Error("GOOGLE_CLOUD_PROJECT が設定されていません");
const stt = new GoogleStt({
  projectId: secrets.googleCloudProject,
  location: config.stt.location,
  model: config.stt.model,
  languageCode: config.stt.languageCode,
});

const CASES = [
  ["fuji.wav", "日本で一番高い山"],
  ["milk-add.wav", "牛乳"],
  ["why.wav", "有名"],
] as const;
const DELAY_MS = Number(process.env.DELAY_MS ?? 5500);
const NOISE_RMS = 20;
const SPEECH_RMS = 100;

function readWav(name: string): Int16Array {
  const b = readFileSync(resolve("test/fixtures", name));
  let o = 12;
  while (b.toString("ascii", o, o + 4) !== "data") o += 8 + b.readUInt32LE(o + 4);
  if (b.readUInt32LE(24) !== 16000) throw new Error(`${name} は 16kHz ではありません`);
  return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + (b.readUInt32LE(o + 4) & ~1)));
}

/** 声の大きさをそろえ、前後にまわりの音（白色雑音）を付ける */
function scene(speech: Int16Array): Int16Array {
  const rms = Math.sqrt(speech.reduce((s, v) => s + v * v, 0) / speech.length);
  const g = SPEECH_RMS / rms;
  const lead = (16000 * DELAY_MS) / 1000;
  const out = new Int16Array(lead + speech.length + 16000 * 3);
  const noiseAmp = NOISE_RMS * Math.sqrt(3);
  for (let i = 0; i < out.length; i++) {
    const s = i >= lead && i < lead + speech.length ? speech[i - lead]! * g : 0;
    out[i] = Math.round(s + (Math.random() * 2 - 1) * noiseAmp);
  }
  return out;
}

async function run(file: string): Promise<TurnRecord | undefined> {
  const turns: TurnRecord[] = [];
  const orchestrator = new Orchestrator(new FakeLlm([{ text: "はい。" }]), new ToolRegistry(), "sys", () => "", systemClock, {
    firstSentenceTimeoutMs: 15000,
    totalTimeoutMs: 60000,
    maxToolRounds: 1,
  });
  const session = new VoiceSession(
    "eval",
    "home",
    {
      stt,
      tts: new FakeTts(),
      orchestrator,
      clock: systemClock,
      config: {
        followUpSeconds: 0,
        speechStartTimeoutSeconds: config.conversation.speechStartTimeoutSeconds,
        maxUtteranceSeconds: config.conversation.maxUtteranceSeconds,
        contextKeepMinutes: 5,
        maxHistoryTurns: 10,
      },
      hooks: { onTurn: (r) => turns.push(r) },
    },
    new RecordingSink(),
  );
  const pcm = scene(readWav(file));
  session.onListenStart();
  const t0 = Date.now();
  for (let i = 0; i < pcm.length && turns.length === 0; i += 960) {
    session.onAudio(pcm.subarray(i, i + 960));
    const due = t0 + (i + 960) / 16 - Date.now();
    if (due > 0) await new Promise((r) => setTimeout(r, due));
  }
  for (let i = 0; i < 100 && turns.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
  session.close();
  return turns[0];
}

let pass = 0;
for (const [file, expect] of CASES) {
  const t = await run(file);
  const l = t?.listen;
  const googleInTime = l?.msToSpeechStart != null && l.msToSpeechStart <= config.conversation.speechStartTimeoutSeconds * 1000;
  const ok = t?.outcome === "ok" && t.userText.includes(expect);
  if (ok) pass++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${file}: 改善後=${t?.outcome}「${t?.userText ?? ""}」 / 改善前=${googleInTime ? "聞き取れた" : "聞き取れませんでした"}` +
      `（Google の合図 ${l?.msToSpeechStart ?? "なし"}ms、サーバーの判定 ${l?.msToLocalSpeechStart ?? "なし"}ms、声 ${l?.speechRms} / 雑音 ${l?.noiseRms}）`,
  );
}
console.log(`== 少し間を置いて話す（${DELAY_MS}ms 後）: ${pass}/${CASES.length}`);
process.exit(pass === CASES.length ? 0 : 1);
