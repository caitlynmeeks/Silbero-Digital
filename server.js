/**
 * Silbero Digital Server
 *
 * HTTPS static file server + WebSocket relay.
 *
 * Terminals send modem audio + camera frames. The server relays
 * audio to all other terminals AND all operators, and camera
 * frames to operators only.
 *
 * Binary message format (first byte = type):
 *   0x01: Audio   [type, terminalId, ...float32 audio]
 *   0x02: Camera  [type, terminalId, ...jpeg bytes]
 *   0x03: FaceSnap [type, terminalId, ...jpeg bytes]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.argv[2], 10) || 8443;
const HTTP_PORT = 8080;
const CERT_DIR = path.join(__dirname, '.certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

const MSG_AUDIO = 0x01;
const MSG_CAMERA = 0x02;
const MSG_FACE_SNAP = 0x03;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ---- Certs ----

function ensureCerts() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    console.log('Using existing self-signed certificate.');
    return;
  }
  console.log('Generating self-signed certificate...');
  fs.mkdirSync(CERT_DIR, { recursive: true });
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_FILE}" -out "${CERT_FILE}" ` +
      `-days 365 -nodes -subj "/CN=silbero-digital"`,
      { stdio: 'pipe' }
    );
    console.log('Certificate generated.');
  } catch (e) {
    console.error('openssl failed. Generate certs manually in .certs/');
    process.exit(1);
  }
}

// ---- Static file server ----

function handleRequest(req, res) {
  // Strip query string before resolving file path
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(__dirname, urlPath === '/' ? 'index.html' : urlPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(__dirname))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
}

// ---- WebSocket relay ----

const terminals = new Set();  // Terminal clients
const operators = new Set();  // Operator station clients

function setupWebSocket(server) {
  // Terminal WebSocket endpoint
  const wssTerminals = new WebSocketServer({ noServer: true });
  // Operator WebSocket endpoint
  const wssOperators = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;

    if (pathname === '/operator-ws') {
      wssOperators.handleUpgrade(request, socket, head, (ws) => {
        wssOperators.emit('connection', ws, request);
      });
    } else {
      wssTerminals.handleUpgrade(request, socket, head, (ws) => {
        wssTerminals.emit('connection', ws, request);
      });
    }
  });

  // Terminal connections
  wssTerminals.on('connection', (ws, req) => {
    // Grab IP for device info
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'] || '';
    const client = { ws, id: null, name: null, ip, ua };
    terminals.add(client);
    console.log(`  WS: terminal connected from ${ip} (${terminals.size} terminals)`);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // Text: registration with name
        try {
          const msg = JSON.parse(data.toString());
          if (msg.terminal) {
            client.id = msg.terminal;
            client.name = msg.name || msg.terminal;
            client.avatar = msg.avatar || null;
            client.dossier = {
              name: client.name,
              consentData: msg.consentData,
              fingerprint: msg.fingerprint || {},
              behavior: msg.behavior || {},
            };
            console.log(`  WS: registered "${client.name}" (T${client.id}) from ${ip}`);

            // Broadcast name + avatar to other terminals
            const nameMsg = JSON.stringify({ type: 'name', terminal: client.id, name: client.name, avatar: client.avatar });
            for (const other of terminals) {
              if (other !== client && other.ws.readyState === 1) {
                other.ws.send(nameMsg);
              }
            }
            // Send all existing names + avatars to new client
            for (const other of terminals) {
              if (other !== client && other.id && other.ws.readyState === 1) {
                ws.send(JSON.stringify({ type: 'name', terminal: other.id, name: other.name, avatar: other.avatar }));
              }
            }
            // Send FULL dossier to operators (fingerprint, behavior, everything)
            const dossierMsg = JSON.stringify({
              type: 'dossier',
              terminal: client.id,
              name: client.name,
              ip, ua,
              time: new Date().toISOString(),
              ...client.dossier,
            });
            for (const op of operators) {
              if (op.ws.readyState === 1) op.ws.send(dossierMsg);
            }
          }
          // Handle chat messages
          if (msg.type === 'message') {
            const relay = JSON.stringify(msg);
            console.log(`  relay: "${msg.text?.slice(0, 40)}" from ${msg.name}`);
            // Relay to all OTHER terminals
            for (const other of terminals) {
              if (other === client) continue;
              if (other.ws.readyState === 1) other.ws.send(relay);
            }
            // Also send to all operators
            for (const op of operators) {
              if (op.ws.readyState === 1) op.ws.send(relay);
            }
          }
        } catch (e) {}
        return;
      }

      // Binary: check message type
      const bytes = new Uint8Array(data);
      const msgType = bytes[0];
      const source = bytes[1];

      if (msgType === MSG_AUDIO) {
        // Legacy audio relay (kept for compatibility)
        for (const other of terminals) {
          if (other === client) continue;
          if (other.ws.readyState === 1) other.ws.send(data);
        }
        // Send to all operators
        for (const op of operators) {
          if (op.ws.readyState === 1) op.ws.send(data);
        }
      } else if (msgType === MSG_CAMERA) {
        // Camera preview frames go to operators only
        for (const op of operators) {
          if (op.ws.readyState === 1) op.ws.send(data);
        }
      } else if (msgType === MSG_FACE_SNAP) {
        // Selfie portraits go to operators AND other terminals (for avatars)
        for (const op of operators) {
          if (op.ws.readyState === 1) op.ws.send(data);
        }
        for (const other of terminals) {
          if (other === client) continue;
          if (other.ws.readyState === 1) other.ws.send(data);
        }
      }
    });

    ws.on('close', () => {
      terminals.delete(client);
      console.log(`  WS: terminal disconnected (${terminals.size} terminals)`);
    });
  });

  // Operator connections
  wssOperators.on('connection', (ws) => {
    const client = { ws };
    operators.add(client);
    console.log(`  WS: operator connected (${operators.size} operators)`);

    ws.on('close', () => {
      operators.delete(client);
      console.log(`  WS: operator disconnected (${operators.size} operators)`);
    });
  });
}

// ---- Main ----

// Check for Tailscale certs (generated by `tailscale cert <hostname>`)
const TAILSCALE_CERT = path.join(__dirname, '.certs', 'tailscale.crt');
const TAILSCALE_KEY = path.join(__dirname, '.certs', 'tailscale.key');
const hasTailscaleCerts = fs.existsSync(TAILSCALE_CERT) && fs.existsSync(TAILSCALE_KEY);

ensureCerts();

const options = {
  key: fs.readFileSync(hasTailscaleCerts ? TAILSCALE_KEY : KEY_FILE),
  cert: fs.readFileSync(hasTailscaleCerts ? TAILSCALE_CERT : CERT_FILE),
};

// HTTPS server (primary)
const server = https.createServer(options, handleRequest);
setupWebSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  SILBERO DIGITAL SERVER`);
  console.log(`  ----------------------`);
  console.log(`  HTTPS:     https://localhost:${PORT}`);
  console.log(`  Operator:  https://localhost:${PORT}/operator.html`);
  console.log(`  HTTP:      http://localhost:${HTTP_PORT}\n`);

  if (hasTailscaleCerts) {
    console.log(`  Using Tailscale certs from .certs/tailscale.*`);
  }

  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  LAN:       https://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});

// HTTP server — serves content directly (for Tailscale Funnel or plain HTTP)
// Tailscale Funnel terminates HTTPS at the proxy, so the backend gets plain HTTP.
// Also useful for local dev. getUserMedia needs HTTPS or localhost, but
// Tailscale Funnel provides HTTPS to the client.
const httpServer = http.createServer(handleRequest);
setupWebSocket(httpServer);

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`  HTTP+WS:   http://localhost:${HTTP_PORT} (for Tailscale Funnel)`);
  console.log('');
});
