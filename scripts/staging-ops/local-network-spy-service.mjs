#!/usr/bin/env node
import { createServer } from "node:http";
let requests = 0;
const server = createServer((req, res) => {
  if (req.url === "/count") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ requests })); return; }
  requests += 1; res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"network spy"}');
});
server.listen(Number(process.env.PORT ?? 7777), "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => server.close());
