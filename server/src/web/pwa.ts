// スマホへの通知のための、Service Worker・マニフェスト・アイコン（016）。ログインなしで出す（秘密の情報は入れない）
import { crc32, deflateSync } from "node:zlib";

/** 通知を受けて表示し、押されたら「連絡」タブを開く */
export const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'アイリス', {
    body: d.body || '',
    icon: '/icon-192.png',
    data: { url: d.url || '/#messages' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/#messages', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
        c.postMessage({ type: 'open', url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
`;

export const MANIFEST = JSON.stringify({
  name: "アイリス",
  short_name: "アイリス",
  start_url: "/",
  display: "standalone",
  background_color: "#f6f5f2",
  theme_color: "#2f6f5e",
  icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
});

/** アイコン：緑の地に白い丸（PNG を直接組み立てる） */
export const ICON_PNG = makeIcon(192);

function makeIcon(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // フィルターなし
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const white = d < size * 0.22 || (d > size * 0.3 && d < size * 0.34);
      const [r, g, b] = white ? [255, 255, 255] : [0x2f, 0x6f, 0x5e];
      raw.set([r, g, b, 255], row + 1 + x * 4);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 ビット、RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
