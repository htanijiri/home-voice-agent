// 013 AC5：会話の終わり方。終える言葉で end_conversation を呼び、続けての聞き取りで話しかけでない声には黙る
import { leaks, newWorld, repeat } from "./harness.js";

const names = (w: ReturnType<typeof newWorld>) => w.shopping.active("home").map((i) => i.name);
const ms: number[] = [];

/** 天気の質問のあとの、続けての聞き取りとして渡す */
async function afterQuestion(text: string) {
  const w = newWorld();
  await w.say("日本で一番高い山は？");
  const answer = await w.say(text, { followUp: true });
  return { w, answer };
}

let ok = true;
for (const phrase of ["ありがとう、もういいよ", "ばいばい", "おしまい"]) {
  ok =
    (await repeat(`終える言葉「${phrase}」`, 5, async () => {
      const { w, answer } = await afterQuestion(phrase);
      ms.push(w.firstSentenceMs.at(-1) ?? -1);
      const pass = w.ended() && answer.length > 0 && answer.length <= 30 && !leaks(answer);
      return { ok: pass, detail: `[${w.firstSentenceMs.at(-1)}ms] ended=${w.ended()} / ${answer}` };
    })) && ok;
}

ok =
  (await repeat("頼みごとをしてから終える", 10, async () => {
    const { w, answer } = await afterQuestion("もういいよ、牛乳も入れといて");
    const pass = w.ended() && names(w).includes("牛乳") && !leaks(answer);
    return { ok: pass, detail: `ended=${w.ended()} list=[${names(w)}] / ${answer}` };
  })) && ok;

for (const phrase of ["今日の夕飯なに食べたい？", "それでさ、明日の会議なんだけど"]) {
  ok =
    (await repeat(`話しかけでない声「${phrase}」`, 5, async () => {
      const { w, answer } = await afterQuestion(phrase);
      const pass = w.ended() && answer === "";
      return { ok: pass, detail: `ended=${w.ended()} / 「${answer}」` };
    })) && ok;
}

// 相づちを拾ったとき、黙る代わりに「No reply」「[end_conversation]」や判断の説明を書いて読み上げない（017 のあとの実機）。
// 読み上げる文がなければ、VoiceSession が黙って待機に戻す
for (const phrase of ["うん", "へえ、そうなんだ", "あはは"]) {
  ok =
    (await repeat(`相づち「${phrase}」に何も言わない`, 5, async () => {
      const { w, answer } = await afterQuestion(phrase);
      return { ok: answer === "", detail: `ended=${w.ended()} / 「${answer}」` };
    })) && ok;
}

ok =
  (await repeat("続けての頼みごとには答える", 5, async () => {
    const w = newWorld();
    await w.say("牛乳を買い物リストに入れて");
    const answer = await w.say("卵も入れて", { followUp: true });
    const pass = !w.ended() && names(w).includes("卵") && answer.length > 0;
    return { ok: pass, detail: `ended=${w.ended()} list=[${names(w)}] / ${answer}` };
  })) && ok;

const sorted = [...ms].sort((a, b) => a - b);
console.log(`== 終える言葉の最初の文まで：中央値 ${sorted[Math.floor(sorted.length / 2)]}ms（${sorted.join(", ")}）`);
process.exit(ok ? 0 : 1);
