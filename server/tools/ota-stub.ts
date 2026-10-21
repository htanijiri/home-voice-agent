// 000 の実機確認用の仮の OTA サーバー。端末からの問い合わせをログに出し、接続先のない最小の応答を返す。
// 001 で本物の OTA の口（src/transports/xiaozhi/ota.ts）に置き換える。
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // MAC アドレスなどの端末情報はログに出すだけで、保存しない
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        method: req.method,
        url: req.url,
        deviceId: req.headers["device-id"],
        userAgent: req.headers["user-agent"],
        bodyBytes: body.length,
      }),
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ server_time: { timestamp: Date.now(), timezone_offset: 540 } }));
  });
}).listen(port, () => console.log(`ota-stub: http://0.0.0.0:${port}/xiaozhi/ota/`));
