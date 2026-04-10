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
const { loadModels, analyzeFace } = require('./face-analysis');

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
        // Send ID mapping to operators FIRST (before binary, so they can resolve)
        const snapNotify = JSON.stringify({
          type: 'face-snap-id',
          binarySourceByte: source,
          terminal: client.id || source,
          name: client.name,
        });
        for (const op of operators) {
          if (op.ws.readyState === 1) op.ws.send(snapNotify);
        }

        // Then relay binary to operators and other terminals
        for (const op of operators) {
          if (op.ws.readyState === 1) op.ws.send(data);
        }
        for (const other of terminals) {
          if (other === client) continue;
          if (other.ws.readyState === 1) other.ws.send(data);
        }

        // Store face snap for operator replay on reconnect
        const jpegBuf = Buffer.from(bytes.buffer, bytes.byteOffset + 2, bytes.length - 2);
        client.faceSnapJpeg = jpegBuf;

        // Run server-side face analysis (async, non-blocking)
        analyzeFace(jpegBuf).then(analysis => {
          if (!analysis) {
            console.log(`  FACE: T${source} "${client.name}" — analysis returned null`);
            return;
          }
          client.faceAnalysis = analysis;
          const tid = client.id || source;
          const faceCount = analysis.faces.length;
          console.log(`  FACE: T${tid} "${client.name}" — ${faceCount} face(s) detected (${jpegBuf.length} bytes)`);
          if (faceCount > 0) {
            const f = analysis.faces[0];
            console.log(`    ${f.gender} ~${Math.round(f.age)}y ${f.expression.dominant} ${f.skinTone.label} ${f.eyeColor.color}-eyes ${f.faceShape} sym:${f.symmetry}`);
          }
          // Send to operators even if 0 faces (so card updates from AWAITING)
          const msg = JSON.stringify({
            type: 'face-analysis',
            terminal: tid,
            name: client.name,
            analysis,
          });
          for (const op of operators) {
            if (op.ws.readyState === 1) op.ws.send(msg);
          }
        }).catch(e => {
          console.error(`  FACE ERROR: T${source} "${client.name}" — ${e.message}`);
        });
      }
    });

    ws.on('close', () => {
      terminals.delete(client);
      console.log(`  WS: terminal disconnected (${terminals.size} terminals)`);

      // Notify operators of disconnect
      if (client.id) {
        const msg = JSON.stringify({
          type: 'disconnect',
          terminal: client.id,
          name: client.name,
          time: new Date().toISOString(),
        });
        for (const op of operators) {
          if (op.ws.readyState === 1) op.ws.send(msg);
        }
      }
    });
  });

  // Operator connections
  wssOperators.on('connection', (ws) => {
    const client = { ws };
    operators.add(client);
    console.log(`  WS: operator connected (${operators.size} operators)`);

    // Replay current state to newly connected operator
    for (const t of terminals) {
      if (!t.id) continue; // not yet registered

      // Replay dossier
      if (t.dossier) {
        const dossierMsg = JSON.stringify({
          type: 'dossier',
          terminal: t.id,
          name: t.name,
          ip: t.ip, ua: t.ua,
          time: new Date().toISOString(),
          ...t.dossier,
        });
        ws.send(dossierMsg);
      }

      // Replay face snap (ID mapping first, then binary)
      if (t.faceSnapJpeg) {
        ws.send(JSON.stringify({
          type: 'face-snap-id',
          binarySourceByte: t.id & 0xFF,
          terminal: t.id,
          name: t.name,
        }));

        const packet = new Uint8Array(2 + t.faceSnapJpeg.length);
        packet[0] = MSG_FACE_SNAP;
        packet[1] = t.id & 0xFF;
        packet.set(t.faceSnapJpeg, 2);
        ws.send(packet);
      }

      // Replay face analysis
      if (t.faceAnalysis) {
        ws.send(JSON.stringify({
          type: 'face-analysis',
          terminal: t.id,
          name: t.name,
          analysis: t.faceAnalysis,
        }));
      }
    }

    // Handle operator commands
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.command === 'disconnect-all') {
          console.log('  OP: disconnect-all command received');
          for (const t of terminals) {
            t.ws.close(1000, 'Operator disconnect');
          }
        }
      } catch (e) {}
    });

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

// Load face analysis models before accepting connections
loadModels().then(() => {
  console.log('  Face analysis ready.\n');
}).catch(e => {
  console.warn('  Face analysis unavailable:', e.message);
});

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
