// Запуск worker.js на обычном сервере (Node.js 18+)
import http from "node:http";
import worker from "./worker.js";

const env = process.env;
const PORT = Number(env.PORT || 3000);
const HOST = env.HOST || "0.0.0.0";

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = !["GET", "HEAD"].includes(req.method);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Ошибка сервера");
  }
}).listen(PORT, HOST, () => console.log(`Сайт запущен: http://${HOST}:${PORT}`));
