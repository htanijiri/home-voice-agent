// 016 AC9：家族への連絡。用件がなければ聞き返し、続けての聞き取りの答えを用件として送る。用件は言い換えない
import { leaks, newWorld, repeat } from "./harness.js";

const show = (w: ReturnType<typeof newWorld>) => JSON.stringify(w.sent);
let ok = true;

ok =
  (await repeat("「パパに連絡して」→ 聞き返し → 用件を送る", 5, async () => {
    const w = newWorld();
    const ask = await w.say("パパに連絡して");
    const asked = w.sent.length === 0 && ask.length > 0 && !leaks(ask);
    const answer = await w.say("今日のお迎え、何時？", { followUp: true });
    const m = w.sent[0];
    const pass = asked && w.sent.length === 1 && m!.to === "パパ" && m!.text.includes("お迎え") && m!.text.includes("何時") && !w.ended() && answer.length > 0;
    return { ok: pass, detail: `聞き返し「${ask}」 / 送った ${show(w)} / ${answer}` };
  })) && ok;

ok =
  (await repeat("用件まで一度に言う", 5, async () => {
    const w = newWorld();
    const answer = await w.say("ママに、今日何時に帰るか聞いて");
    const m = w.sent[0];
    const pass = w.sent.length === 1 && m!.to === "ママ" && m!.text.includes("何時に帰る") && answer.length > 0 && !leaks(answer);
    return { ok: pass, detail: `送った ${show(w)} / ${answer}` };
  })) && ok;

ok =
  (await repeat("聞き返しに「それだけ」→「連絡してほしいそうです」", 5, async () => {
    const w = newWorld();
    await w.say("お母さんに連絡して");
    const answer = await w.say("それだけ", { followUp: true });
    const m = w.sent[0];
    const pass = w.sent.length === 1 && m!.to === "お母さん" && m!.text === "連絡してほしいそうです" && answer.length > 0;
    return { ok: pass, detail: `送った ${show(w)} / ${answer}` };
  })) && ok;

ok =
  (await repeat("聞き返しへの答えを、話しかけでない声として無視しない", 5, async () => {
    const w = newWorld();
    await w.say("お父さんに連絡して");
    const answer = await w.say("あのね、明日の遠足のおやつ、買ってきてほしい", { followUp: true });
    const m = w.sent[0];
    const pass = w.sent.length === 1 && m!.to === "お父さん" && m!.text.includes("おやつ") && answer.length > 0;
    return { ok: pass, detail: `送った ${show(w)} / ended=${w.ended()} / ${answer}` };
  })) && ok;

process.exit(ok ? 0 : 1);
