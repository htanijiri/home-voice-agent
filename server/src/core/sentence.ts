// LLM のストリーミング出力を、読み上げ用の文に区切る。
const END = /[。！？!?\n]/;

export class SentenceSplitter {
  private buf = "";
  constructor(private readonly minLength = 4) {}

  /** 受け取った断片を足し、区切れた文を返す */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i]!;
      // 英語の文の終わり（「.」のあとに空白か日本語）も区切りにする。漏れた英語の文を、日本語の文と分けるため
      const next = this.buf[i + 1];
      const englishEnd = ch === "." && next !== undefined && (next === " " || next.charCodeAt(0) > 0x7f);
      if (!END.test(ch) && !englishEnd) continue;
      // 「！？」「。」」のような連続した記号と閉じ括弧はまとめて含める
      let j = i + 1;
      while (j < this.buf.length && /[。！？!?」』）)\s]/.test(this.buf[j]!)) j++;
      const sentence = this.buf.slice(start, j).trim();
      if (sentence.length >= this.minLength) {
        out.push(sentence);
        start = j;
      }
      i = j - 1;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** 残りを返す */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }
}

/** 補足やプロンプトにだけ出てくる言葉。返事に出たら、自分の判断の説明が漏れたもの */
const META = /続けての聞き取り|話しかけ(?:では|で)な|待機に戻|ツール(?:の)?呼び出し|システムからの連絡|【補足/;

/**
 * 読み上げてよい文か。thinking をオフにしたモデルは、まれに英語の考えごと（"Ask: the list is empty, ..."）を
 * 返事に書くので、英字が大半を占める文は読み上げない。日本語の文の中の短い英単語（MQTT など）は残す。
 * 続けての聞き取りで黙るとき、ツールを呼ぶ代わりに「[end_conversation]」「No reply」と文章で書くこともある（017 のあとの実機）。
 * 角かっこで囲んだ文、ツールの名前（英小文字の snake_case）を含む文、日本語のない英語の文は読み上げない。
 * 「これは続けての聞き取りで、話しかけではなさそうなので、待機に戻ります」のような、補足やプロンプトの言葉を使った
 * 自分の判断の説明も読み上げない（アイリスが利用者に言う言葉ではないもの）。
 */
export function isSpeakable(sentence: string): boolean {
  const latin = (sentence.match(/[A-Za-z]/g) ?? []).length;
  const japanese = (sentence.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length;
  const words = (sentence.match(/[A-Za-z]{2,}/g) ?? []).length;
  if (/<\/?[a-z_]+>/.test(sentence)) return false;
  if (/^\s*[[［].*[\]］][。.\s]*$/s.test(sentence)) return false;
  if (/\b[a-z]+_[a-z_]+\b/.test(sentence)) return false;
  if (japanese === 0 && words >= 2) return false;
  if (META.test(sentence)) return false;
  return !(words >= 3 && latin > japanese);
}

/** 読み上げない文を取り除いた文章（会話の履歴に残す返事） */
export function cleanSpokenText(text: string): string {
  const sp = new SentenceSplitter(1);
  return [...sp.push(text), ...sp.flush()].filter(isSpeakable).join("");
}
