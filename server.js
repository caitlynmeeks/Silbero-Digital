/**
 * Minimal HTTPS server for Silbo Terminal
 *
 * Serves the web app over HTTPS (required for getUserMedia mic access).
 * Generates a self-signed certificate on first run.
 *
 * Usage:
 *   node server.js [port]
 *
 * Then open https://localhost:8443 in Chrome.
 * You'll need to click through the self-signed cert warning once.
 *
 * For Chromebook deployment: run this on one machine, have all
 * Chromebooks point to https://<server-ip>:8443
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = parseInt(process.argv[2], 10) || 8443;
const HTTP_PORT = 8080; // Redirect to HTTPS
const CERT_DIR = path.join(__dirname, '.certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'key.pem');

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Generate a self-signed certificate if one doesn't exist.
 */
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
      `-days 365 -nodes -subj "/CN=silbo-terminal"`,
      { stdio: 'pipe' }
    );
    console.log('Certificate generated.');
  } catch (e) {
    console.error('Failed to generate certificate. Is openssl installed?');
    console.error('You can also create certs manually and place them in .certs/');
    process.exit(1);
  }
}

/**
 * Serve static files from the project directory.
 */
function handleRequest(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(__dirname))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not found');
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
      return;
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---- Main ----

ensureCerts();

const options = {
  key: fs.readFileSync(KEY_FILE),
  cert: fs.readFileSync(CERT_FILE),
};

// HTTPS server (main)
const server = https.createServer(options, handleRequest);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  SILBO TERMINAL SERVER`);
  console.log(`  ---------------------`);
  console.log(`  HTTPS: https://localhost:${PORT}`);
  console.log(`  HTTP:  http://localhost:${HTTP_PORT} (redirects to HTTPS)\n`);

  // Show local IP for Chromebook access
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  LAN:   https://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});

// HTTP redirect server
const redirectServer = http.createServer((req, res) => {
  const host = req.headers.host?.split(':')[0] || 'localhost';
  res.writeHead(301, { Location: `https://${host}:${PORT}${req.url}` });
  res.end();
});
redirectServer.listen(HTTP_PORT, '0.0.0.0');
