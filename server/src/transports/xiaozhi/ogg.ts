// Opus のフレームを Ogg Opus のファイルにまとめる（端末の notify は Ogg Opus の URL を再生する）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0;
  for (const b of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc >>> 0;
}

function page(packet: Buffer, granule: bigint, serial: number, seq: number, flags: number): Buffer {
  const lacing: number[] = [];
  let n = packet.length;
  while (n >= 255) {
    lacing.push(255);
    n -= 255;
  }
  lacing.push(n);
  if (lacing.length > 255) throw new Error("packet too large for one page");
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header[4] = 0;
  header[5] = flags;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  lacing.forEach((v, i) => (header[27 + i] = v));
  const out = Buffer.concat([header, packet]);
  out.writeUInt32LE(crc32(out), 22);
  return out;
}

/** frames：同じ長さ（frameMs）の Opus のフレーム。inputRate は元の標本化周波数（OpusHead に書くだけ） */
export function muxOggOpus(frames: Buffer[], opts: { inputRate: number; frameMs: number }): Buffer {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const preSkip = 312;
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1; // version
  head[9] = 1; // channels
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(opts.inputRate, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0; // mapping family
  const vendor = Buffer.from("home-voice-agent");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  const pages = [page(head, 0n, serial, 0, 0x02), page(tags, 0n, serial, 1, 0)];
  const perFrame = BigInt((48000 * opts.frameMs) / 1000); // 粒度位置は 48kHz で数える
  let granule = BigInt(preSkip);
  frames.forEach((f, i) => {
    granule += perFrame;
    pages.push(page(f, granule, serial, i + 2, i === frames.length - 1 ? 0x04 : 0));
  });
  return Buffer.concat(pages);
}

/** Ogg Opus を分解して、音声のフレームを取り出す（テスト用） */
export function demuxOggOpus(buf: Buffer): { head: Buffer; frames: Buffer[]; crcOk: boolean } {
  const packets: Buffer[] = [];
  let p = 0;
  let crcOk = true;
  let pending: Buffer[] = [];
  while (p < buf.length) {
    if (buf.toString("ascii", p, p + 4) !== "OggS") throw new Error("bad page");
    const nseg = buf[p + 26]!;
    const lacing = [...buf.subarray(p + 27, p + 27 + nseg)];
    const bodyLen = lacing.reduce((a, b) => a + b, 0);
    const pageBuf = Buffer.from(buf.subarray(p, p + 27 + nseg + bodyLen));
    const crc = pageBuf.readUInt32LE(22);
    pageBuf.writeUInt32LE(0, 22);
    if (crc32(pageBuf) !== crc) crcOk = false;
    let q = p + 27 + nseg;
    for (const l of lacing) {
      pending.push(buf.subarray(q, q + l));
      q += l;
      if (l < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    p = q;
  }
  return { head: packets[0]!, frames: packets.slice(2), crcOk };
}
