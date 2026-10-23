// 端末1台との会話セッション。聞き取り → 認識 → 応答 → 読み上げ → 追加の聞き取り、の状態を管理する。
// 通信方式（WebSocket / MQTT＋UDP）には依存しない。通信の口は DeviceSink と、on* メソッドの呼び出しでつなぐ。
import { errorFields, log } from "../log.js";
import { ConversationError, type Orchestrator, trimHistory } from "./orchestrator.js";
import { ListenStats, type ListenSummary } from "./listen-stats.js";
import type { Clock, SpeechToText, SttStream, TextToSpeech } from "./ports.js";
import type { DeviceControl, ToolContext } from "./tools/registry.js";
import type { ChatMessage } from "./types.js";

export type SessionState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "FOLLOW_UP";

/** 端末へ送る手段。通信方式ごとに実装する */
export interface DeviceSink {
  stt(text: string): void;
  emotion(emotion: string): void;
  ttsStart(): void;
  sentence(text: string): void;
  /** PCM を端末に送る。再生にかかる時間に合わせて送り終えたら resolve する */
  audio(pcm: Int16Array, sampleRate: number, signal: AbortSignal): Promise<void>;
  ttsStop(): void;
  /** 会話を終えて、端末を待機に戻す */
  endConversation(): void;
}

export interface VoiceSessionConfig {
  /** 返事のあと、呼びかけなしで聞き取る秒数。0 なら追加の聞き取りをしない */
  followUpSeconds: number;
  /** 最初の聞き取りで、話し始めを待つ秒数 */
  speechStartTimeoutSeconds: number;
  /** 1回の発話の上限の秒数 */
  maxUtteranceSeconds: number;
  /** 待機に戻ってから、前の話を覚えておく分数 */
  contextKeepMinutes: number;
  maxHistoryTurns: number;
}

export interface TurnTimings {
  listenStartAt?: number;
  speechEndAt?: number;
  sttFinalAt?: number;
  firstSentenceAt?: number;
  firstAudioAt?: number;
  doneAt?: number;
}

export interface TurnRecord {
  deviceId: string;
  userText: string;
  assistantText: string;
  outcome: "ok" | "no_speech" | "error" | "limit" | "aborted";
  errorKind?: string;
  timings: TurnTimings;
  /** 聞き取りの様子（009）。聞き取りを伴わない記録にはない */
  listen?: ListenSummary;
}

export interface SessionHooks {
  /** 1日の上限などで会話を断るときに、読み上げる文を返す */
  checkLimit?(deviceId: string): string | undefined;
  onTurn?(rec: TurnRecord): void;
  ttsUsage?(characters: number): void;
  sttUsage?(seconds: number): void;
  /** 会話の最初に LLM へ伝える補足（未通知のリマインダーなど）。伝えたら consume が呼ばれる */
  pendingNotes?(deviceId: string): { notes: string[]; consume(): void } | undefined;
}

export const MESSAGES = {
  noSpeech: "すみません、聞き取れませんでした。",
  serviceError: "ただいま調子が悪いようです。少ししてからもう一度話しかけてください。",
};

const SAMPLE_RATE_IN = 16000;

export class VoiceSession {
  state: SessionState = "IDLE";
  readonly history: ChatMessage[] = [];
  private lastActiveAt = 0;
  private stt?: SttStream;
  private sttTimer?: NodeJS.Timeout;
  private utteranceTimer?: NodeJS.Timeout;
  private turnAbort?: AbortController;
  private sttSamples = 0;
  private timings: TurnTimings = {};
  private listen?: ListenStats;
  /** 直近の聞き取りの「聞き取れませんでした」の理由 */
  private noSpeechReason?: ListenSummary["noSpeechReason"];
  private closed = false;

  constructor(
    readonly deviceId: string,
    private readonly householdId: string,
    private readonly deps: {
      stt: SpeechToText;
      tts: TextToSpeech;
      orchestrator: Orchestrator;
      clock: Clock;
      config: VoiceSessionConfig;
      hooks?: SessionHooks;
      device?: DeviceControl;
    },
    private sink: DeviceSink,
  ) {}

  /** 通信の口が入れ替わったとき（再接続）に、送り先を差し替える */
  attachSink(sink: DeviceSink): void {
    this.sink = sink;
  }

  /** 端末が聞き取りを始めた（ウェイクワード・ボタン・追加の聞き取り） */
  onListenStart(): void {
    if (this.closed) return;
    // 読み上げが終わると、端末は自動で聞き取りに戻って listen start を送ってくる。
    // サーバーは既に追加の聞き取りを始めているので、新しい会話として扱わない
    if (this.state === "FOLLOW_UP") return;
    this.abortTurn();
    const now = this.deps.clock.now().getTime();
    if (this.lastActiveAt && now - this.lastActiveAt > this.deps.config.contextKeepMinutes * 60_000) {
      this.history.length = 0;
    }
    this.startListening(this.deps.config.speechStartTimeoutSeconds);
  }

  /** 端末からの音声（16kHz の PCM） */
  onAudio(pcm: Int16Array): void {
    if (this.state !== "LISTENING" && this.state !== "FOLLOW_UP") return;
    if (!this.stt) return;
    this.listen?.audio(pcm);
    this.sttSamples += pcm.length;
    this.stt.write(pcm);
  }

  /** 端末が聞き取りを止めた（手動モードのボタンなど） */
  onListenStop(): void {
    this.stt?.end();
  }

  /** 読み上げの中断（ウェイクワード・ボタン） */
  onAbort(): void {
    this.abortTurn();
    if (this.state === "SPEAKING" || this.state === "THINKING") this.state = "IDLE";
  }

  /** 通信が切れた */
  onDisconnect(): void {
    this.abortTurn();
    this.stopStt();
    this.state = "IDLE";
  }

  close(): void {
    this.closed = true;
    this.onDisconnect();
  }

  private startListening(timeoutSeconds: number): void {
    this.stopStt();
    this.timings = { listenStartAt: Date.now() };
    const listen = new ListenStats();
    this.listen = listen;
    this.noSpeechReason = undefined;
    this.state = this.state === "SPEAKING" ? "FOLLOW_UP" : "LISTENING";
    this.sttSamples = 0;
    const stream = this.deps.stt.startStream();
    this.stt = stream;
    let spoke = false;
    // 話し始めがなければ打ち切る
    this.sttTimer = setTimeout(() => {
      if (!spoke) {
        this.stopStt();
        if (this.state === "FOLLOW_UP") {
          this.finishConversation();
        } else {
          this.noSpeechReason = "timeout";
          void this.speakFixed(MESSAGES.noSpeech, "no_speech");
        }
      }
    }, timeoutSeconds * 1000);
    void (async () => {
      const finals: string[] = [];
      try {
        for await (const ev of stream.events) {
          if (ev.type === "speech_start") listen.speechStart();
          if (ev.type === "speech_start" && !spoke) {
            spoke = true;
            if (this.state === "FOLLOW_UP") this.state = "LISTENING";
            clearTimeout(this.sttTimer);
            this.utteranceTimer = setTimeout(() => stream.end(), this.deps.config.maxUtteranceSeconds * 1000);
          } else if (ev.type === "speech_end") {
            this.timings.speechEndAt = Date.now();
            stream.end();
          } else if (ev.type === "final") {
            listen.final(ev.text);
            if (ev.text.trim()) finals.push(ev.text.trim());
            // 話し始めのイベントが来ない実装でも動くようにする
            if (!spoke) {
              spoke = true;
              clearTimeout(this.sttTimer);
            }
          } else if (ev.type === "error") {
            throw ev.error;
          }
        }
      } catch (err) {
        if (this.stt !== stream) return;
        log.warn("stt failed", { deviceId: this.deviceId, ...errorFields(err) });
        this.stopStt();
        await this.speakFixed(MESSAGES.serviceError, "error", "stt");
        return;
      }
      if (this.stt !== stream) return; // 途中で止められた
      this.deps.hooks?.sttUsage?.(this.sttSamples / SAMPLE_RATE_IN);
      this.stopStt();
      if (!spoke) return; // 話し始めの待ち時間切れは、タイマー側で処理済み
      const text = finals.join("");
      this.timings.sttFinalAt = Date.now();
      if (!text) {
        this.noSpeechReason = "empty";
        await this.speakFixed(MESSAGES.noSpeech, "no_speech");
        return;
      }
      await this.respond(text);
    })();
  }

  private async respond(userText: string): Promise<void> {
    const ac = new AbortController();
    this.turnAbort = ac;
    this.state = "THINKING";
    this.sink.stt(userText);

    const limited = this.deps.hooks?.checkLimit?.(this.deviceId);
    if (limited) {
      await this.speakSentences([limited], ac.signal);
      this.record(userText, limited, "limit");
      this.afterSpeaking(ac);
      return;
    }

    this.sink.emotion("thinking");
    trimHistory(this.history, this.deps.config.maxHistoryTurns);
    const ctx: ToolContext = {
      deviceId: this.deviceId,
      householdId: this.householdId,
      now: this.deps.clock.now(),
      device: this.deps.device,
    };
    const pending = this.deps.hooks?.pendingNotes?.(this.deviceId);
    const spoken: string[] = [];
    try {
      const sentences = this.deps.orchestrator.respond({
        history: this.history,
        userText,
        ctx,
        systemNotes: pending?.notes,
        signal: ac.signal,
      });
      await this.speakSentences(sentences, ac.signal, spoken);
      pending?.consume();
      if (ac.signal.aborted) {
        this.record(userText, spoken.join(""), "aborted");
        return;
      }
      this.record(userText, spoken.join(""), "ok");
    } catch (err) {
      if (ac.signal.aborted) return;
      const kind = err instanceof ConversationError ? err.kind : "unknown";
      log.warn("respond failed", { deviceId: this.deviceId, kind, ...errorFields(err) });
      await this.speakSentences([MESSAGES.serviceError], ac.signal).catch(() => undefined);
      this.record(userText, spoken.join(""), "error", kind);
    }
    this.afterSpeaking(ac);
  }

  /** 文を順に音声にして送る。次の文の音声合成は、前の文を送っている間に始める */
  private async speakSentences(
    sentences: Iterable<string> | AsyncIterable<string>,
    signal: AbortSignal,
    spoken: string[] = [],
  ): Promise<void> {
    let started = false;
    let pending: Promise<void> = Promise.resolve();
    const tts = this.deps.tts;
    for await (const s of sentences) {
      if (signal.aborted) break;
      if (!this.timings.firstSentenceAt) this.timings.firstSentenceAt = Date.now();
      const synth = tts.synthesize(s, { signal });
      const prev = pending;
      pending = (async () => {
        const r = await synth;
        this.deps.hooks?.ttsUsage?.(r.characters);
        await prev;
        if (signal.aborted) return;
        if (!started) {
          started = true;
          this.state = "SPEAKING";
          this.sink.ttsStart();
          this.timings.firstAudioAt = Date.now();
        }
        this.sink.sentence(s);
        spoken.push(s);
        await this.sink.audio(r.pcm, r.sampleRate, signal);
      })();
      // 合成の失敗は待ち合わせのところで投げる
      pending.catch(() => undefined);
    }
    await pending;
    if (started && !signal.aborted) this.sink.ttsStop();
    if (!started && !signal.aborted) {
      // 読み上げる文がなかった
      this.state = "SPEAKING";
    }
  }

  private async speakFixed(text: string, outcome: TurnRecord["outcome"], errorKind?: string): Promise<void> {
    const ac = new AbortController();
    this.turnAbort = ac;
    try {
      await this.speakSentences([text], ac.signal);
    } catch (err) {
      log.warn("tts failed", { deviceId: this.deviceId, ...errorFields(err) });
      this.sink.stt(text); // 音声が作れないときは、画面に案内を出す
      this.sink.emotion("sad");
    }
    this.record("", text, outcome, errorKind);
    this.finishConversation();
  }

  private afterSpeaking(ac: AbortController): void {
    if (ac.signal.aborted || this.closed) return;
    this.lastActiveAt = this.deps.clock.now().getTime();
    if (this.deps.config.followUpSeconds > 0) {
      this.state = "SPEAKING";
      this.startListening(this.deps.config.followUpSeconds);
    } else {
      this.finishConversation();
    }
  }

  private finishConversation(): void {
    this.stopStt();
    this.lastActiveAt = this.deps.clock.now().getTime();
    this.state = "IDLE";
    this.sink.endConversation();
  }

  private record(userText: string, assistantText: string, outcome: TurnRecord["outcome"], errorKind?: string) {
    this.timings.doneAt = Date.now();
    const listen = this.listen?.summary(outcome === "no_speech" ? this.noSpeechReason : undefined);
    // 同じ聞き取りを2回記録しない
    this.listen = undefined;
    if (listen) log.info("listen summary", { deviceId: this.deviceId, outcome, ...listen });
    this.deps.hooks?.onTurn?.({
      deviceId: this.deviceId,
      userText,
      assistantText,
      outcome,
      errorKind,
      timings: this.timings,
      ...(listen ? { listen } : {}),
    });
  }

  private abortTurn(): void {
    this.turnAbort?.abort();
    this.turnAbort = undefined;
  }

  private stopStt(): void {
    clearTimeout(this.sttTimer);
    clearTimeout(this.utteranceTimer);
    const s = this.stt;
    this.stt = undefined;
    s?.abort();
  }
}
