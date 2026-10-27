// 017 AC3：連絡の用件を聞き返したあとの「ゆっくり聞く」聞き取りで、「えーっと」→ 無言 → 続き、を本物の Google STT で1つの用件として聞き取れるか。
// 「パパに連絡して」までは偽の STT で済ませ、聞き返しのあとの聞き取りだけ Google に流す（実時間）。LLM と読み上げは偽物。
// 比べるために、ふだんの続けての聞き取り（改善前と同じ待ち方）にも同じ音声を流して、どこで切れるかを示す。
// 音声は Google TTS で作ったもの（test/fixtures/etto.wav「えーっと」・omukae.wav「お迎え、何時？」）。実在の人の声は使わない。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoogleStt } from "../../src/adapters/stt-google.js";
import { loadConfig, loadDotEnv, loadSecrets } from "../../src/config.js";
import { Orchestrator } from "../../src/core/orchestrator.js";
import { type SpeechToText, systemClock } from "../../src/core/ports.js";
import { messageTools } from "../../src/core/tools/messages.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";
import { DEFAULT_PATIENT_LISTEN, type TurnRecord, VoiceSession } from "../../src/core/voice-session.js";
import { FakeLlm, FakeStt, FakeTts, RecordingSink, said } from "../../test/fakes.js";

loadDotEnv(resolve(process.cwd(), ".env"));
const config = loadConfig();
const secrets = loadSecrets();
if (!secrets.googleCloudProject) throw new Error("GOOGLE_CLOUD_PROJECT が設定されていません");
const google = new GoogleStt({
  projectId: secrets.googleCloudProject,
  location: config.stt.location,
  model: config.stt.model,
  languageCode: config.stt.languageCode,
});

const PAUSE_MS = Number(process.env.PAUSE_MS ?? 1500);
const LEAD_MS = 2000;
const NOISE_RMS = 20;
const SPEECH_RMS = Number(process.env.SPEECH_RMS ?? 100);

function readWav(name: string): Int16Array {
  const b = readFileSync(resolve("test/fixtures", name));
  let o = 12;
  while (b.toString("ascii", o, o + 4) !== "data") o += 8 + b.readUInt32LE(o + 4);
  if (b.readUInt32LE(24) !== 16000) throw new Error(`${name} は 16kHz ではありません`);
  return new Int16Array(b.buffer.slice(b.byteOffset + o + 8, b.byteOffset + o + 8 + (b.readUInt32LE(o + 4) & ~1)));
}

/** まわりの音 → 「えーっと」→ PAUSE_MS の無言 → 「お迎え、何時？」→ まわりの音 */
function scene(): Int16Array {
  const parts: (Int16Array | number)[] = [LEAD_MS, readWav("etto.wav"), PAUSE_MS, readWav("omukae.wav"), 4000];
  const len = parts.reduce<number>((n, p) => n + (typeof p === "number" ? (16000 * p) / 1000 : p.length), 0);
  const out = new Int16Array(len);
  const noiseAmp = NOISE_RMS * Math.sqrt(3);
  let i = 0;
  for (const p of parts) {
    if (typeof p === "number") {
      i += (16000 * p) / 1000;
      continue;
    }
    const rms = Math.sqrt(p.reduce((s, v) => s + v * v, 0) / p.length);
    for (const v of p) out[i++] = (v * SPEECH_RMS) / rms;
  }
  for (let k = 0; k < out.length; k++) out[k] = Math.round(out[k]! + (Math.random() * 2 - 1) * noiseAmp);
  return out;
}

async function run(patient: boolean): Promise<TurnRecord | undefined> {
  const turns: TurnRecord[] = [];
  // 最初の発話（「パパに連絡して」）だけ偽の STT。そのあとは Google
  const first = new FakeStt([said("パパに連絡して")]);
  let n = 0;
  const stt: SpeechToText = { startStream: (opts) => (n++ === 0 ? first.startStream() : google.startStream(opts)) };
  const llm = new FakeLlm([
    patient
      ? { toolUses: [{ name: "send_family_message", input: { to: "パパ", reply: "なんて伝える？" } }] }
      : { text: "なんて伝える？" },
    { text: "パパに送ったよ。" },
  ]);
  const tools = new ToolRegistry().register(...messageTools({ send: async () => undefined }, 100));
  const orchestrator = new Orchestrator(llm, tools, "sys", () => "", systemClock, {
    firstSentenceTimeoutMs: 15000,
    totalTimeoutMs: 60000,
    maxToolRounds: 2,
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
        followUpSeconds: config.conversation.followUpSeconds,
        speechStartTimeoutSeconds: config.conversation.speechStartTimeoutSeconds,
        maxUtteranceSeconds: config.conversation.maxUtteranceSeconds,
        contextKeepMinutes: 5,
        maxHistoryTurns: 10,
        patient: {
          startSeconds: config.family?.patientStartSeconds ?? DEFAULT_PATIENT_LISTEN.startSeconds,
          endMs: config.family?.patientEndMs ?? DEFAULT_PATIENT_LISTEN.endMs,
          maxUtteranceSeconds: config.family?.patientMaxUtteranceSeconds ?? DEFAULT_PATIENT_LISTEN.maxUtteranceSeconds,
        },
      },
      hooks: { onTurn: (r) => turns.push(r) },
    },
    new RecordingSink(),
  );
  session.onListenStart();
  session.onAudio(new Int16Array(960));
  for (let i = 0; i < 50 && n < 2; i++) await new Promise((r) => setTimeout(r, 20));
  if (n < 2) throw new Error("聞き返しのあとの聞き取りが始まらなかった");
  const pcm = scene();
  const t0 = Date.now();
  for (let i = 0; i < pcm.length && turns.length < 2; i += 960) {
    session.onAudio(pcm.subarray(i, i + 960));
    const due = t0 + (i + 960) / 16 - Date.now();
    if (due > 0) await new Promise((r) => setTimeout(r, due));
  }
  for (let i = 0; i < 100 && turns.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  session.close();
  return turns[1];
}

const t = await run(true);
const ok = t?.outcome === "ok" && t.userText.includes("えっと") && t.userText.includes("迎え");
const before = await run(false);
console.log(`${ok ? "PASS" : "FAIL"} ゆっくり聞く：${t?.outcome}「${t?.userText ?? ""}」`);
console.log(`（比較）ふだんの待ち方：${before?.outcome}「${before?.userText ?? ""}」`);
console.log(`== 「えーっと」→ ${PAUSE_MS}ms の無言 → 用件: ${ok ? 1 : 0}/1`);
process.exit(ok ? 0 : 1);
