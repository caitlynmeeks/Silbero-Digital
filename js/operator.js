/**
 * Silbero Digital — Operator Station
 *
 * The surveillance dashboard. Shows live camera feeds from all terminals,
 * plays all modem audio through speakers, decodes messages in swim lanes
 * with the sender's face beside each one.
 *
 * The operator (performer in black) watches silently, occasionally
 * clicking a feed to examine it full-screen. A receipt printer
 * continuously outputs face + waveform + decoded text, feeding
 * directly into a shredder.
 */

import {
  decodeMessage, getFreqs, SAMPLE_RATE, BAUD_RATE
} from './modem.js';
import { ThermalPrinter } from './thermal-printer.js';

const MSG_AUDIO = 0x01;
const MSG_CAMERA = 0x02;
const MSG_FACE_SNAP = 0x03;

// ---- State ----
let audioCtx = null;
let ws = null;
let printer = null;
let messageCount = 0;

// Latest face snapshot per terminal (for pairing with decoded messages)
const latestFaces = {};      // terminalId -> ImageBitmap
const latestFaceBlobs = {};  // terminalId -> Blob (for printing)

// Camera feed canvases
const feedCanvases = {};
const feedContexts = {};
let examineTerminal = null;

// ---- DOM refs ----
const elLanes = document.getElementById('operator-lanes');
const elExamine = document.getElementById('examine-view');
const elExamineCanvas = document.getElementById('examine-canvas');
const elExamineLabel = document.getElementById('examine-label');
const elExamineClose = document.getElementById('examine-close');
const elWsStatus = document.getElementById('op-ws-status');
const elStats = document.getElementById('op-stats');
const elBtnPrinter = document.getElementById('btn-op-printer');
const elPrinterStatus = document.getElementById('op-printer-status');

// ---- Init ----

function init() {
  // Camera feeds are now dynamic — created when terminals connect
  // Clear the static placeholder grid
  const grid = document.getElementById('camera-grid');
  grid.innerHTML = '';

  // Close examine view
  elExamineClose.addEventListener('click', hideExamine);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideExamine();
  });

  // Printer
  elBtnPrinter.addEventListener('click', connectPrinter);

  // Audio context
  initAudio();

  // WebSocket
  connectWebSocket();
}

async function initAudio() {
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  // Operator station needs a click to start audio (Chrome policy)
  document.addEventListener('click', () => {
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }, { once: true });
}

// ---- WebSocket ----

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/operator-ws`;

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    elWsStatus.textContent = 'WS:OK';
    ws.send(JSON.stringify({ terminal: 'operator' }));
  };

  ws.onclose = () => {
    elWsStatus.textContent = 'WS:--';
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {};

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      // Text: client info from server
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'dossier') {
          handleDossier(msg);
        } else if (msg.type === 'client-info') {
          handleClientInfo(msg);
        }
      } catch (e) {}
      return;
    }

    if (!(event.data instanceof ArrayBuffer)) return;

    const bytes = new Uint8Array(event.data);
    const msgType = bytes[0];
    const sourceId = bytes[1];
    const payload = bytes.subarray(2);

    switch (msgType) {
      case MSG_AUDIO:
        handleAudio(sourceId, payload);
        break;
      case MSG_CAMERA:
        handleCameraFrame(sourceId, payload);
        break;
      case MSG_FACE_SNAP:
        handleFaceSnap(sourceId, payload);
        break;
    }
  };
}

// ---- Client Info ----

const clientInfo = {}; // terminalId -> full dossier

function handleClientInfo(msg) {
  clientInfo[msg.terminal] = { ...clientInfo[msg.terminal], ...msg };
  updateFeedLabel(msg.terminal);
}

function handleDossier(msg) {
  clientInfo[msg.terminal] = msg;
  console.log(`DOSSIER T${msg.terminal} "${msg.name}":`, msg);
  updateFeedLabel(msg.terminal);

  // Create a dossier entry in the operator lanes
  const lane = document.createElement('div');
  lane.className = 'op-lane';
  lane.style.borderColor = '#333';

  const fp = msg.fingerprint || {};
  const bh = msg.behavior || {};

  lane.innerHTML = `
    <div class="op-lane-face" id="dossier-face-${msg.terminal}" style="background:#080808;display:flex;align-items:center;justify-content:center;color:#222;font-size:9px;">AWAIT</div>
    <div class="op-lane-body">
      <div class="op-lane-header">
        <span class="op-lane-id" style="color:#aaa;">${msg.name || 'TF' + msg.terminal}</span>
        <span class="op-lane-time">${msg.time ? new Date(msg.time).toTimeString().slice(0, 8) : '--'}</span>
        <span style="color:#444;font-size:10px;">CONNECTED</span>
      </div>
      <div style="color:#555;font-size:10px;line-height:1.6;margin-top:4px;word-break:break-all;">
        ${fp.ip ? `<div><span style="color:#666;">IP:</span> ${fp.ip} (${fp.city || '?'}, ${fp.country || '?'}) ${fp.isp || ''}</div>` : `<div><span style="color:#666;">IP:</span> ${msg.ip || '?'}</div>`}
        ${fp.gpuRenderer ? `<div><span style="color:#666;">GPU:</span> ${fp.gpuRenderer}</div>` : ''}
        ${fp.userAgent ? `<div><span style="color:#666;">UA:</span> ${fp.userAgent.slice(0, 100)}</div>` : `<div><span style="color:#666;">UA:</span> ${msg.ua ? msg.ua.slice(0, 100) : '?'}</div>`}
        ${fp.screenWidth ? `<div><span style="color:#666;">Screen:</span> ${fp.screenWidth}x${fp.screenHeight} @${fp.pixelRatio}x ${fp.colorDepth}bit</div>` : ''}
        ${fp.hardwareConcurrency ? `<div><span style="color:#666;">CPU:</span> ${fp.hardwareConcurrency} cores ${fp.deviceMemory ? '/ ' + fp.deviceMemory + 'GB RAM' : ''}</div>` : ''}
        ${fp.language ? `<div><span style="color:#666;">Lang:</span> ${fp.languages ? fp.languages.join(', ') : fp.language} / TZ: ${fp.timezoneIANA || '?'}</div>` : ''}
        ${fp.connectionType ? `<div><span style="color:#666;">Net:</span> ${fp.connectionType} ${fp.downlink ? fp.downlink + 'Mbps' : ''} ${fp.rtt ? fp.rtt + 'ms RTT' : ''}</div>` : ''}
        ${fp.batteryLevel !== undefined ? `<div><span style="color:#666;">Battery:</span> ${fp.batteryLevel}% ${fp.batteryCharging ? '(charging)' : '(discharging)'}</div>` : ''}
        ${fp.deviceHash ? `<div><span style="color:#666;">Device Hash:</span> ${fp.deviceHash.slice(0, 16)}...</div>` : ''}
        ${fp.canvasFingerprint ? `<div><span style="color:#666;">Canvas FP:</span> ${fp.canvasFingerprint.slice(0, 16)}...</div>` : ''}
        ${fp.installedFonts && fp.installedFonts.length ? `<div><span style="color:#666;">Fonts:</span> ${fp.installedFonts.slice(0, 10).join(', ')}${fp.installedFonts.length > 10 ? '...' : ''}</div>` : ''}
        ${fp.doNotTrack ? `<div><span style="color:#c44;">DNT: ENABLED</span></div>` : ''}
        ${bh.tosScrollDepth ? `<div><span style="color:#666;">ToS scroll:</span> ${bh.tosScrollDepth} / consent in ${bh.timeToConsentMs ? (bh.timeToConsentMs / 1000).toFixed(1) + 's' : '?'}</div>` : ''}
        <div><span style="color:#666;">Consent data:</span> ${msg.consentData ? 'YES' : 'NO'}</div>
      </div>
    </div>
  `;

  elLanes.insertBefore(lane, elLanes.firstChild);
}

function updateFeedLabel(terminalId) {
  const info = clientInfo[terminalId];
  if (!info) return;
  const feed = document.querySelector(`.camera-feed[data-terminal="${terminalId}"]`);
  if (feed) {
    const label = feed.querySelector('.feed-label');
    label.textContent = info.name || `TF${terminalId}`;
    const status = feed.querySelector('.feed-status');
    status.textContent = info.ip || (info.fingerprint && info.fingerprint.ip) || '--';
  }
}

// ---- Camera Feeds ----

function ensureFeedExists(sourceId) {
  if (feedCanvases[sourceId]) return;

  const grid = document.getElementById('camera-grid');
  const feed = document.createElement('div');
  feed.className = 'camera-feed';
  feed.dataset.terminal = sourceId;

  const label = document.createElement('div');
  label.className = 'feed-label';
  const info = clientInfo[sourceId];
  label.textContent = info ? info.name : `TF${sourceId}`;

  const canvas = document.createElement('canvas');
  canvas.className = 'feed-canvas';
  canvas.width = 320;
  canvas.height = 240;

  const status = document.createElement('div');
  status.className = 'feed-status';
  status.textContent = info ? info.ip : '--';

  feed.appendChild(label);
  feed.appendChild(canvas);
  feed.appendChild(status);
  grid.appendChild(feed);

  feedCanvases[sourceId] = canvas;
  feedContexts[sourceId] = canvas.getContext('2d');

  feed.addEventListener('click', () => {
    showExamine(sourceId);
  });
}

function handleCameraFrame(sourceId, jpegBytes) {
  ensureFeedExists(sourceId);
  renderJpegToCanvas(sourceId, jpegBytes);

  const feed = document.querySelector(`.camera-feed[data-terminal="${sourceId}"]`);
  if (feed) {
    feed.classList.add('active');
    const status = feed.querySelector('.feed-status');
    if (status.textContent === '--' && clientInfo[sourceId]) {
      status.textContent = clientInfo[sourceId].ip;
    }
  }

  if (examineTerminal === sourceId) {
    renderJpegToExamine(jpegBytes);
  }
}

function handleFaceSnap(sourceId, jpegBytes) {
  ensureFeedExists(sourceId);

  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  latestFaceBlobs[sourceId] = blob;
  createImageBitmap(blob).then(bmp => {
    latestFaces[sourceId] = bmp;
  });

  const feed = document.querySelector(`.camera-feed[data-terminal="${sourceId}"]`);
  if (feed) {
    feed.classList.add('flagged');
    setTimeout(() => feed.classList.remove('flagged'), 2000);
  }

  renderJpegToCanvas(sourceId, jpegBytes);
}

function renderJpegToCanvas(sourceId, jpegBytes) {
  const ctx = feedContexts[sourceId];
  if (!ctx) return;

  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  createImageBitmap(blob).then(bmp => {
    ctx.drawImage(bmp, 0, 0, feedCanvases[sourceId].width, feedCanvases[sourceId].height);
    bmp.close();
  });
}

function renderJpegToExamine(jpegBytes) {
  const ctx = elExamineCanvas.getContext('2d');
  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  createImageBitmap(blob).then(bmp => {
    ctx.drawImage(bmp, 0, 0, elExamineCanvas.width, elExamineCanvas.height);
    bmp.close();
  });
}

function showExamine(terminalId) {
  examineTerminal = terminalId;
  elExamineLabel.textContent = `T${String(terminalId).padStart(2, '0')}`;
  elExamine.classList.remove('hidden');
}

function hideExamine() {
  examineTerminal = null;
  elExamine.classList.add('hidden');
}

// ---- Audio ----

function handleAudio(sourceId, audioBytes) {
  // Copy to aligned buffer (WebSocket offset isn't 4-byte aligned)
  const aligned = new ArrayBuffer(audioBytes.byteLength);
  new Uint8Array(aligned).set(audioBytes);
  const samples = new Float32Array(aligned);

  // Play through speakers (fire and forget — overlapping is intentional)
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const buffer = audioCtx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start();
  }

  // Decode the message
  const result = decodeMessage(samples, sourceId);

  // Create operator swim lane with face + waveform + text
  createOperatorLane(sourceId, samples, result);

  // Update stats
  messageCount++;
  elStats.textContent = `${messageCount} messages`;

  // Print to thermal printer (face + waveform + text → shredder)
  if (printer && printer.connected && result && result.text) {
    printSurveillanceReceipt(sourceId, samples, result);
  }
}

// ---- Operator Swim Lanes ----

function createOperatorLane(sourceId, samples, decodeResult) {
  const lane = document.createElement('div');
  lane.className = 'op-lane active';

  // Face thumbnail
  const faceCanvas = document.createElement('canvas');
  faceCanvas.className = 'op-lane-face';
  faceCanvas.width = 60;
  faceCanvas.height = 45;
  const faceCtx = faceCanvas.getContext('2d');

  // Draw face if we have a recent snapshot
  if (latestFaces[sourceId]) {
    faceCtx.drawImage(latestFaces[sourceId], 0, 0, 60, 45);
  } else {
    faceCtx.fillStyle = '#0a0a0a';
    faceCtx.fillRect(0, 0, 60, 45);
    faceCtx.fillStyle = '#222';
    faceCtx.font = '9px monospace';
    faceCtx.fillText('NO FEED', 4, 25);
  }

  // Body: header + waveform + text
  const body = document.createElement('div');
  body.className = 'op-lane-body';

  const header = document.createElement('div');
  header.className = 'op-lane-header';

  const idSpan = document.createElement('span');
  idSpan.className = 'op-lane-id';
  const info = clientInfo[sourceId];
  idSpan.textContent = info ? info.name : `TF${sourceId}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'op-lane-time';
  timeSpan.textContent = new Date().toTimeString().slice(0, 8);

  header.appendChild(idSpan);
  header.appendChild(timeSpan);

  // Waveform
  const waveCanvas = document.createElement('canvas');
  waveCanvas.className = 'op-lane-waveform';
  waveCanvas.width = 600;
  waveCanvas.height = 24;
  drawMiniWaveform(waveCanvas, samples);

  // Decoded text
  const textDiv = document.createElement('div');
  textDiv.className = 'op-lane-text';

  if (decodeResult && decodeResult.text) {
    textDiv.textContent = decodeResult.text;
    textDiv.classList.add('decoded');
  } else {
    textDiv.textContent = '[decode failed]';
  }

  // Device info line
  const deviceDiv = document.createElement('div');
  deviceDiv.style.cssText = 'color:#333;font-size:10px;margin-bottom:2px;word-break:break-all;';
  if (info) {
    deviceDiv.textContent = `${info.ip} | ${(info.ua || '').slice(0, 80)}`;
  }

  body.appendChild(header);
  body.appendChild(deviceDiv);
  body.appendChild(waveCanvas);
  body.appendChild(textDiv);

  lane.appendChild(faceCanvas);
  lane.appendChild(body);

  elLanes.insertBefore(lane, elLanes.firstChild);

  // Remove 'active' after audio finishes
  const durationMs = (samples.length / SAMPLE_RATE) * 1000;
  setTimeout(() => lane.classList.remove('active'), durationMs);
}

function drawMiniWaveform(canvas, samples) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();

  const step = Math.max(1, Math.floor(samples.length / w));
  for (let x = 0; x < w; x++) {
    const idx = Math.floor(x * samples.length / w);
    let rms = 0;
    for (let j = 0; j < step; j++) {
      const s = samples[idx + j] || 0;
      rms += s * s;
    }
    rms = Math.sqrt(rms / step);
    const y = h / 2 - rms * h;
    const y2 = h / 2 + rms * h;
    ctx.moveTo(x, y);
    ctx.lineTo(x, y2);
  }
  ctx.stroke();
}

// ---- Thermal Printer (Surveillance Edition) ----

async function connectPrinter() {
  printer = new ThermalPrinter();
  try {
    await printer.connect();
    elPrinterStatus.textContent = `CONNECTED`;
    await printer.printStatus('SILBERO DIGITAL // OPERATOR');
  } catch (e) {
    elPrinterStatus.textContent = 'FAILED';
    printer = null;
  }
}

async function printSurveillanceReceipt(sourceId, samples, result) {
  if (!printer || !printer.connected) return;

  const termStr = String(sourceId).padStart(2, '0');
  const timeStr = new Date().toTimeString().slice(0, 8);

  // Header
  await printer.sendBytes([0x1B, 0x61, 0x01]); // Center
  await printer.sendBytes([0x1B, 0x45, 0x01]); // Bold
  await printer.sendText(`T${termStr} // ${timeStr}`);
  await printer.sendBytes([0x0A]);
  await printer.sendBytes([0x1B, 0x45, 0x00]); // Bold off

  // Face image (if available) — print as raster bitmap
  if (latestFaceBlobs[sourceId]) {
    try {
      await printFaceBitmap(sourceId);
    } catch (e) {
      await printer.sendText('[NO FACE DATA]');
      await printer.sendBytes([0x0A]);
    }
  }

  // Decoded text
  await printer.sendBytes([0x1B, 0x61, 0x00]); // Left align
  await printer.sendBytes([0x1D, 0x21, 0x01]); // Double height
  await printer.sendText(result.text);
  await printer.sendBytes([0x0A]);
  await printer.sendBytes([0x1D, 0x21, 0x00]); // Normal

  // Confidence
  await printer.sendBytes([0x1B, 0x61, 0x01]); // Center
  const confStr = Math.round(result.confidence * 100);
  await printer.sendText(`[${confStr}%]`);
  await printer.sendBytes([0x0A]);

  // Separator
  await printer.sendText('________________________');
  await printer.sendBytes([0x1B, 0x64, 2]); // Feed 2 lines

  // Partial cut
  try {
    await printer.sendBytes([0x1D, 0x56, 0x01]);
  } catch (_) {}
}

/**
 * Print face as a dithered bitmap on the thermal printer.
 * Converts the JPEG to a 1-bit black/white bitmap suitable for ESC/POS.
 */
async function printFaceBitmap(sourceId) {
  const blob = latestFaceBlobs[sourceId];
  if (!blob) return;

  const bmp = await createImageBitmap(blob);
  const printWidth = 384; // 48mm at 8 dots/mm (standard 80mm printer)
  const scale = printWidth / bmp.width;
  const printHeight = Math.floor(bmp.height * scale);

  // Render to canvas, grayscale
  const canvas = new OffscreenCanvas(printWidth, printHeight);
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(100%) contrast(1.5)';
  ctx.drawImage(bmp, 0, 0, printWidth, printHeight);
  bmp.close();

  const imageData = ctx.getImageData(0, 0, printWidth, printHeight);
  const pixels = imageData.data;

  // Convert to 1-bit with Floyd-Steinberg dithering
  const gray = new Float32Array(printWidth * printHeight);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = pixels[i * 4] / 255; // Already grayscale
  }

  for (let y = 0; y < printHeight; y++) {
    for (let x = 0; x < printWidth; x++) {
      const idx = y * printWidth + x;
      const old = gray[idx];
      const val = old < 0.5 ? 0 : 1;
      gray[idx] = val;
      const err = old - val;
      if (x + 1 < printWidth) gray[idx + 1] += err * 7 / 16;
      if (y + 1 < printHeight) {
        if (x > 0) gray[(y + 1) * printWidth + x - 1] += err * 3 / 16;
        gray[(y + 1) * printWidth + x] += err * 5 / 16;
        if (x + 1 < printWidth) gray[(y + 1) * printWidth + x + 1] += err * 1 / 16;
      }
    }
  }

  // ESC/POS raster bit image: GS v 0
  const bytesPerRow = Math.ceil(printWidth / 8);
  const cmd = [
    0x1D, 0x76, 0x30, 0x00,
    bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF,
    printHeight & 0xFF, (printHeight >> 8) & 0xFF,
  ];
  await printer.sendBytes(cmd);

  // Send bitmap data row by row
  for (let y = 0; y < printHeight; y++) {
    const row = new Uint8Array(bytesPerRow);
    for (let x = 0; x < printWidth; x++) {
      if (gray[y * printWidth + x] < 0.5) {
        // Dark pixel = print dot
        row[Math.floor(x / 8)] |= (0x80 >> (x % 8));
      }
    }
    await printer.sendBytes(row);
  }
}

// ---- Init ----
init();
