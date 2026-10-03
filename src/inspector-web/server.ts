import http from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname, normalize } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { InspectorHub } from './hub.js';
import type { ClientMessage, ServerMessage } from './ws-protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT = Number(
  process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 7333,
);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const hub = new InspectorHub();

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/screenshot') {
    try {
      const png = await hub.screenshot();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(png);
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  // Static files — confined to PUBLIC_DIR.
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });

// Fan out every hub broadcast to all connected browsers.
hub.on('broadcast', (message: ServerMessage) => {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(hub.helloState()));

  ws.on('message', (raw) => {
    let cmd: ClientMessage;
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (cmd.type) {
      case 'discover': void hub.discover(); break;
      case 'connect': void hub.connect(cmd.url); break;
      case 'disconnect': void hub.disconnect(); break;
      case 'setSelectMode': void hub.setSelectMode(cmd.enabled); break;
      case 'verifyLocator': void hub.verifyLocator(cmd.by, cmd.value); break;
      case 'highlightIndex': void hub.highlightIndex(cmd.by, cmd.value, cmd.index); break;
      case 'verifyCompound': void hub.verifyCompound(cmd.altIndex, cmd.params); break;
      case 'loadFullTree': void hub.loadFullTree(); break;
      case 'evaluatePath': void hub.evaluatePath(cmd.query, cmd.highlight); break;
      case 'highlightValueId': void hub.highlightValueId(cmd.valueId); break;
      case 'listWebViews': void hub.listWebViews(); break;
      case 'loadWebViewTree': void hub.loadWebViewTree(cmd.contextId); break;
      case 'highlightWebViewNode': void hub.highlightWebViewNode(cmd.domId); break;
      case 'verifyWebSelector': void hub.verifyWebSelector(cmd.by, cmd.value); break;
      case 'startWebInspect': void hub.startWebInspect(); break;
      case 'stopWebInspect': hub.stopWebInspect(); break;
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  Flutter Tap Inspector UI: http://localhost:${PORT}\n`);
});

const shutdown = async (): Promise<void> => {
  await hub.disconnect();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
