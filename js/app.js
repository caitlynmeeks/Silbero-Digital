/**
 * Silbero Digital — Main application (WebSocket Relay Edition)
 *
 * Messages are encoded as modem audio, played locally, and relayed
 * via WebSocket to all other terminals. Receiving terminals play
 * the incoming audio and decode it simultaneously. Multiple incoming
 * transmissions overlap in parallel "swim lanes" — the chaos is the point.
 *
 * Pipeline:
 *   [keyboard] -> modem encoder -> play locally + send via WebSocket
 *   WebSocket incoming -> play audio + decode -> swim lane display + printer
 */

import {
  synthesizeSilbo, playSilbo, playSilboAsync, getWaveform,
  SAMPLE_RATE, MAX_MESSAGE_LENGTH
} from './silbo-synth.js';
import { GlitchRenderer } from './glitch.js';
import { ThermalPrinter } from './thermal-printer.js';
import { captureSelfie } from './camera.js';
import { annotateWithFaceDetection } from './face-detect.js';
import { collectFingerprint, TypingBiometrics, BehaviorTracker, estimateHandedness } from './fingerprint.js';
import { setLanguage, t, getLang } from './i18n.js';

// Binary message type bytes (for selfie relay)
const MSG_FACE_SNAP = 0x03;

// ---- State ----
let audioCtx = null;
let terminalId = 0;  // Assigned by server or random
let isTransmitting = false;
let printer = null;
let glitch = null;
let ws = null;
let wsConnected = false;
let camera = null;
let consentData = false;
let consentPrivacy = false;
let userName = '';
let userTag = '';
let displayName = '';
let selfieBlob = null;     // annotated (for local display/avatars)
let selfieRawBlob = null;  // raw (sent to server for ML analysis)
let selfieDataUrl = null;
let selfieDetections = null;
let fingerprint = null;
const typing = new TypingBiometrics();
const behavior = new BehaviorTracker();

// ---- DOM refs ----
const elSplash = document.getElementById('splash');
const elNamePrompt = document.getElementById('name-prompt');
const elTerminal = document.getElementById('terminal');
const elTerminalId = document.getElementById('terminal-id');
const elStatus = document.getElementById('status');
const elWsStatus = document.getElementById('ws-status');
const elChatLog = document.getElementById('chat-log');
const elInput = document.getElementById('input');
const elGlitchCanvas = document.getElementById('glitch-canvas');
const elBtnSend = document.getElementById('btn-send');

// Splash elements
const elConsentData = document.getElementById('consent-data');
const elConsentPrivacy = document.getElementById('consent-privacy');
const elBtnSilbero = document.getElementById('btn-silbero');
const elInputName = document.getElementById('input-name');
const elBtnEnter = document.getElementById('btn-enter');

// ---- UI Setup ----

function initUI() {
  const elLangSelect = document.getElementById('lang-select');

  // Language selector — first screen
  for (const btn of document.querySelectorAll('.lang-btn')) {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      setLanguage(lang);
      elLangSelect.classList.add('hidden');
      elSplash.classList.remove('hidden');
      applyTranslations();
    });
  }

  function applyTranslations() {
    // Update all translatable text in the splash
    document.querySelector('#splash-content > .splash-section:nth-child(1) h2').textContent = t('splashTitle');
    document.querySelector('#splash-content > .splash-section:nth-child(1) p:nth-child(2)').textContent = t('splashDesc1');
    document.querySelector('#splash-content > .splash-section:nth-child(1) p:nth-child(3)').textContent = t('splashDesc2');
    document.querySelector('#splash-content > .splash-section:nth-child(2) h2').textContent = t('silboTitle');
    document.querySelector('#splash-content > .splash-section:nth-child(2) p').textContent = t('silboDesc');

    // Consent labels
    const consentLabels = document.querySelectorAll('.consent-label span');
    if (consentLabels[0]) consentLabels[0].innerHTML = `${t('consentData')} <em>${t('consentDataNote')}</em>`;
    if (consentLabels[1]) consentLabels[1].innerHTML = `${t('consentPrivacy')}`;

    elBtnSilbero.textContent = t('letsSilbero');
    document.getElementById('splash-footer').textContent = t('splashFooter');
    document.getElementById('oauth-label').textContent = t('orSignIn');

    // Name prompt
    document.getElementById('name-label').textContent = t('whatsYourName');
    document.getElementById('name-hint').textContent = t('leaveBlank');
    elBtnEnter.textContent = t('enter');

    // Terminal
    elInput.placeholder = t('placeholder');
    elBtnSend.textContent = t('send');
  }

  // Splash screen consent flow
  function updateSilberoButton() {
    consentPrivacy = elConsentPrivacy.checked;
    consentData = elConsentData.checked;
    elBtnSilbero.disabled = !consentPrivacy;
  }

  elConsentData.addEventListener('change', updateSilberoButton);
  elConsentPrivacy.addEventListener('change', updateSilberoButton);
  updateSilberoButton();

  // Track ToS scroll depth
  const splashEl = document.getElementById('splash');
  splashEl.addEventListener('scroll', () => {
    const depth = splashEl.scrollTop / (splashEl.scrollHeight - splashEl.clientHeight);
    behavior.recordTosScroll(depth);
  });

  // Typing biometrics on the input field
  elInput.addEventListener('keydown', (e) => typing.keydown(e.key));
  elInput.addEventListener('keyup', (e) => typing.keyup(e.key));

  elBtnSilbero.addEventListener('click', () => {
    if (!elConsentPrivacy.checked) return;

    // Assign a random terminal ID
    terminalId = Math.floor(Math.random() * 99999) + 1;
    // UUID-style tag: 50e800-e29b-41d4a7 format
    const uuid = crypto.randomUUID().replace(/-/g, '');
    userTag = `${uuid.slice(0,6)}-${uuid.slice(6,10)}-${uuid.slice(10,16)}`;

    // Show name prompt
    elSplash.classList.add('hidden');
    elNamePrompt.classList.remove('hidden');
    elInputName.value = '';
    elInputName.placeholder = userTag;
    elInputName.focus();
  });

  // Name prompt -> selfie -> fingerprint -> terminal
  async function enterTerminal() {
    const raw = elInputName.value.trim();
    userName = raw;
    displayName = raw ? `${raw} (${userTag})` : userTag;
    behavior.recordConsent();

    elNamePrompt.classList.add('hidden');

    // Selfie capture (if they consented to data collection)
    if (consentData) {
      const result = await captureSelfie('images/whistler4.jpg');
      if (result) {
        // Keep raw selfie for server-side ML analysis (no overlays)
        selfieRawBlob = result.blob;
        // Run face detection and annotate with targeting overlay for local display
        const annotated = await annotateWithFaceDetection(result.blob);
        selfieBlob = annotated.blob;
        selfieDataUrl = annotated.dataUrl;
        selfieDetections = annotated.detections;
      }
    }

    // Show terminal
    elTerminal.classList.remove('hidden');

    // Use selfie for glitch effect instead of stock images
    if (selfieDataUrl && glitch) {
      glitch.loadImage(selfieDataUrl).catch(() => {});
    }

    // Estimate handedness from selfie
    let handedness = 'unknown';
    if (selfieBlob) {
      try {
        const bmp = await createImageBitmap(selfieBlob);
        handedness = estimateHandedness(bmp);
        bmp.close();
      } catch (e) {}
    }

    // Collect device fingerprint (sent to server with registration, not displayed to user)
    collectFingerprint().then(fp => {
      fp.handedness = handedness;
      fingerprint = fp;
    });

    await startTerminal();
  }

  elBtnEnter.addEventListener('click', enterTerminal);
  elInputName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enterTerminal();
  });

  // Send button (for mobile) and Enter key
  async function doSend() {
    if (isTransmitting) return;
    const text = elInput.value.trim();
    if (text.length > 0) {
      if (!audioCtx) await startTerminal();
      elInput.value = '';
      transmitMessage(text);
    }
  }

  elBtnSend.addEventListener('click', doSend);
  elInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSend();
  });

  // Init glitch renderer (sized to sidebar)
  elGlitchCanvas.width = 320;
  elGlitchCanvas.height = 240;
  glitch = new GlitchRenderer(elGlitchCanvas);
  glitch.start();
}

function updateHeader() {
  elTerminalId.textContent = `SILBERO.DIGITAL`;
}

function setStatus(status) {
  elStatus.textContent = status;
  elStatus.className = '';
  if (status === 'ONLINE') elStatus.classList.add('online');
  else if (status === 'RECEIVING') elStatus.classList.add('receiving');
  else if (status === 'TRANSMITTING') elStatus.classList.add('transmitting');
}


// ---- IRC Chat ----

// Map of known terminal IDs to display names and avatars
const knownNames = {};
const knownAvatars = {};  // terminalId -> data URL of selfie

// Avatar tracking — every chat message references its avatar column so
// we can update them all together when a user transmits / mark elapsed time.
const avatarsByTerminal = {};   // terminalId -> Array of avatar column DOM elements
const lastTransmitTime = {};    // terminalId -> Date.now() of last transmission

function registerAvatar(terminalId, avatarCol) {
  if (!avatarsByTerminal[terminalId]) avatarsByTerminal[terminalId] = [];
  avatarsByTerminal[terminalId].push(avatarCol);
}

function setTransmitting(terminalId, on) {
  const cols = avatarsByTerminal[terminalId] || [];
  for (const col of cols) col.classList.toggle('transmitting', on);
}

function markTransmission(terminalId) {
  lastTransmitTime[terminalId] = Date.now();
}

function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m${s.toString().padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}`;
}

function updateAllTimers() {
  const now = Date.now();
  for (const [tid, cols] of Object.entries(avatarsByTerminal)) {
    const last = lastTransmitTime[tid];
    if (!last) continue;
    const display = formatElapsed(Math.floor((now - last) / 1000));
    for (const col of cols) {
      const timer = col.querySelector('.chat-msg-timer');
      if (timer) timer.textContent = display;
    }
  }
}

setInterval(updateAllTimers, 1000);

function timeStamp() {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * Add a chat message to the log. Returns an object with methods to update it.
 *
 * @param {string} name - Display name of sender
 * @param {boolean} isSelf - Is this our own message
 * @param {Float32Array} samples - Audio samples for waveform
 * @param {number} sourceId - Terminal ID of sender (for avatar lookup)
 */
function addChatMessage(name, isSelf, samples, sourceId) {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${isSelf ? 'self' : ''}`;

  // Avatar + content wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'chat-msg-wrapper';

  // Avatar column: image + timer overlay + name label
  const avatarCol = document.createElement('div');
  avatarCol.className = 'chat-msg-avatar-col';
  avatarCol.dataset.terminal = sourceId;

  const avatar = document.createElement('div');
  avatar.className = 'chat-msg-avatar';
  const avatarUrl = isSelf ? selfieDataUrl : knownAvatars[sourceId];
  if (avatarUrl) {
    avatar.style.backgroundImage = `url(${avatarUrl})`;
  }

  // Timer overlay (top-right of image)
  const timerEl = document.createElement('div');
  timerEl.className = 'chat-msg-timer';
  timerEl.textContent = '0s';
  avatar.appendChild(timerEl);

  // Name label below image
  const nameLabel = document.createElement('div');
  nameLabel.className = 'chat-msg-name-label';
  nameLabel.textContent = name;

  avatarCol.appendChild(avatar);
  avatarCol.appendChild(nameLabel);

  // Register so future updates touch all of this user's avatars
  registerAvatar(sourceId, avatarCol);

  // Content column
  const content = document.createElement('div');
  content.className = 'chat-msg-content';

  // Header: name + timestamp
  const header = document.createElement('div');
  header.className = 'chat-msg-header';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'chat-msg-name';
  nameSpan.textContent = name;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'chat-msg-time';
  timeSpan.textContent = timeStamp();

  const confSpan = document.createElement('span');
  confSpan.className = 'chat-msg-confidence';

  header.appendChild(nameSpan);
  header.appendChild(timeSpan);
  header.appendChild(confSpan);

  // Waveform
  const waveCanvas = document.createElement('canvas');
  waveCanvas.className = 'chat-msg-waveform';
  waveCanvas.width = 1200;
  waveCanvas.height = 80;

  // Text
  const textDiv = document.createElement('div');
  textDiv.className = 'chat-msg-text';

  content.appendChild(header);
  content.appendChild(waveCanvas);
  content.appendChild(textDiv);

  wrapper.appendChild(avatarCol);
  wrapper.appendChild(content);
  msg.appendChild(wrapper);

  elChatLog.appendChild(msg);
  elChatLog.scrollTop = elChatLog.scrollHeight;

  return {
    setText(text) {
      textDiv.textContent = text;
      if (samples) drawWaveformProgressive(waveCanvas, samples, 1);
    },

    animateText(text, msPerChar) {
      let i = 0;
      const totalChars = text.length;
      textDiv.innerHTML = '<span class="cursor">_</span>';

      const interval = setInterval(() => {
        if (i < totalChars) {
          textDiv.textContent = text.slice(0, i + 1);
          const cursor = document.createElement('span');
          cursor.className = 'cursor';
          cursor.textContent = '_';
          textDiv.appendChild(cursor);
          i++;

          // Progressive waveform reveal — draw up to current position
          if (samples) {
            const progress = i / totalChars;
            drawWaveformProgressive(waveCanvas, samples, progress);
          }

          elChatLog.scrollTop = elChatLog.scrollHeight;

          // Per-character glitch pulse on avatar
          avatar.classList.add('glitching');
          setTimeout(() => avatar.classList.remove('glitching'), msPerChar * 0.6);
        } else {
          clearInterval(interval);
          textDiv.textContent = text;
          avatar.classList.remove('glitching');
          // Final full waveform
          if (samples) drawWaveformProgressive(waveCanvas, samples, 1);
        }
      }, msPerChar);
    },

    setConfidence(confidence) {
      if (confidence !== undefined) {
        confSpan.textContent = `${Math.round(confidence * 100)}%`;
      }
    },
  };
}

/**
 * Draw waveform progressively — only renders up to `progress` (0-1).
 * Reveals left-to-right in sync with text typing.
 */
function drawWaveformProgressive(canvas, samples, progress) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const revealX = Math.floor(w * Math.min(1, progress));

  ctx.fillStyle = '#141414';
  ctx.fillRect(0, 0, w, h);

  // Center line (full width, dim)
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  if (revealX < 1) return;

  const step = Math.max(1, Math.floor(samples.length / w));

  // Filled envelope — upper
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  for (let x = 0; x < revealX; x++) {
    const idx = Math.floor(x * samples.length / w);
    let rms = 0;
    for (let j = 0; j < step; j++) {
      const s = samples[idx + j] || 0;
      rms += s * s;
    }
    rms = Math.sqrt(rms / step);
    ctx.lineTo(x, h / 2 - rms * h * 0.95);
  }
  ctx.lineTo(revealX, h / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(180, 180, 180, 0.3)';
  ctx.fill();

  // Filled envelope — lower
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  for (let x = 0; x < revealX; x++) {
    const idx = Math.floor(x * samples.length / w);
    let rms = 0;
    for (let j = 0; j < step; j++) {
      const s = samples[idx + j] || 0;
      rms += s * s;
    }
    rms = Math.sqrt(rms / step);
    ctx.lineTo(x, h / 2 + rms * h * 0.95);
  }
  ctx.lineTo(revealX, h / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(180, 180, 180, 0.2)';
  ctx.fill();

  // Bright signal trace
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  for (let x = 0; x < revealX; x++) {
    const idx = Math.floor(x * samples.length / w);
    let val = 0;
    for (let j = 0; j < step; j++) val += samples[idx + j] || 0;
    val /= step;
    ctx.lineTo(x, h / 2 - val * h * 1.8);
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Playhead indicator at reveal edge
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(revealX, 0);
  ctx.lineTo(revealX, h);
  ctx.stroke();
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-system';
  div.textContent = `[${timeStamp()}] ${text}`;
  elChatLog.appendChild(div);
  elChatLog.scrollTop = elChatLog.scrollHeight;
}

// Keep old name for compatibility
const addSystemLane = addSystemMessage;

// ---- Audio Engine ----

async function initAudio() {
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return true;
}

// ---- WebSocket ----

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}`;

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = async () => {
    wsConnected = true;
    elWsStatus.textContent = 'WS:OK';

    // Create a small avatar data URL for relay to other clients
    let avatarSmall = null;
    if (selfieBlob) {
      try {
        const bmp = await createImageBitmap(selfieBlob);
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const cx = c.getContext('2d');
        const s = Math.min(bmp.width, bmp.height);
        cx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 64, 64);
        bmp.close();
        avatarSmall = c.toDataURL('image/jpeg', 0.5);
      } catch (e) {}
    }

    // Register with name + dossier + avatar
    const registration = {
      terminal: terminalId,
      name: displayName,
      language: getLang(),
      consentData,
      avatar: avatarSmall,
      faceDetections: selfieDetections || [],
      fingerprint: fingerprint || {},
      behavior: behavior.getSummary(),
    };
    ws.send(JSON.stringify(registration));
    knownNames[terminalId] = displayName;

    // Send raw selfie (no overlays) for server-side face analysis
    if (selfieRawBlob) {
      selfieRawBlob.arrayBuffer().then(buf => {
        sendFaceSnapshot(new Uint8Array(buf));
      });
    }
  };

  ws.onclose = () => {
    wsConnected = false;
    elWsStatus.textContent = 'WS:--';
    elWsStatus.className = '';
    // Reconnect after 2 seconds
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
    wsConnected = false;
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      // Binary: selfie relay
      const bytes = new Uint8Array(event.data);
      if (bytes[0] === MSG_FACE_SNAP) {
        const sourceId = bytes[1];
        const jpegBytes = bytes.subarray(2);
        const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        knownAvatars[sourceId] = URL.createObjectURL(blob);
      }
    } else if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'name' && msg.terminal && msg.name) {
          knownNames[msg.terminal] = msg.name;
          if (msg.avatar) knownAvatars[msg.terminal] = msg.avatar;
        } else if (msg.type === 'message') {
          handleIncomingMessage(msg);
        }
      } catch (e) {}
    }
  };
}

/**
 * Send encoded audio to the relay server.
 * Format: byte 0 = MSG_AUDIO, byte 1 = terminal ID, rest = Float32 audio.
 */
function sendAudio(samples) {
  if (!ws || !wsConnected) return;

  const audioBytes = new Uint8Array(samples.buffer);
  const packet = new Uint8Array(2 + audioBytes.length);
  packet[0] = MSG_AUDIO;
  packet[1] = terminalId;
  packet.set(audioBytes, 2);

  ws.send(packet.buffer);
}

/**
 * Send the selfie portrait to the operator.
 */
function sendFaceSnapshot(jpegBytes) {
  if (!ws || !wsConnected) return;

  const packet = new Uint8Array(2 + jpegBytes.length);
  packet[0] = MSG_FACE_SNAP;
  packet[1] = terminalId;
  packet.set(jpegBytes, 2);
  ws.send(packet.buffer);
}

/**
 * Handle incoming text message from the relay server.
 * Generates ornamental Silbo audio and plays it while typing text.
 */
function handleIncomingMessage(incoming) {
  const { terminal: sourceId, name: senderName, text, avatar: incomingAvatar } = incoming;

  // Store their avatar if we don't have it
  if (incomingAvatar && !knownAvatars[sourceId]) {
    knownAvatars[sourceId] = incomingAvatar;
  }

  // Generate Silbo audio with this sender's unique waveform
  const waveform = getWaveform(sourceId);
  const { samples: silboAudio, durationMs } = synthesizeSilbo(text, waveform);

  // Add chat message with waveform and avatar
  const msg = addChatMessage(
    senderName || knownNames[sourceId] || `TF${sourceId}`,
    false, silboAudio, sourceId
  );

  // Play the Silbo whistle (simultaneous — the cacophony)
  playSilboAsync(audioCtx, silboAudio);

  glitch.setIntensity(0.7);
  setStatus('RECEIVING');

  // Animate text typing out in sync with audio
  const msPerChar = durationMs / Math.max(1, text.length);
  msg.animateText(text, msPerChar);

  setTimeout(() => {
    glitch.setIntensity(0);
    setStatus('ONLINE');
  }, durationMs);
}

// ---- Transmit ----

async function transmitMessage(text) {
  if (isTransmitting) return;
  isTransmitting = true;
  setStatus('TRANSMITTING');
  elInput.disabled = true;

  const trimmed = text.slice(0, MAX_MESSAGE_LENGTH);
  behavior.recordMessage(trimmed);
  glitch.setIntensity(0.9);

  // Generate ornamental Silbo audio from text
  const waveform = getWaveform(terminalId);
  const { samples: silboAudio, durationMs } = synthesizeSilbo(trimmed, waveform);

  // Add to our chat with waveform — animate text in sync with audio
  const msg = addChatMessage(displayName, true, silboAudio, terminalId);
  const msPerChar = durationMs / Math.max(1, trimmed.length);
  msg.animateText(trimmed, msPerChar);

  // Play Silbo whistle locally
  const playPromise = playSilbo(audioCtx, silboAudio);

  // Send text message to server
  if (ws && wsConnected) {
    ws.send(JSON.stringify({
      type: 'message',
      terminal: terminalId,
      name: displayName,
      text: trimmed,
    }));
  }

  await playPromise;

  glitch.setIntensity(0);
  isTransmitting = false;
  elInput.disabled = false;
  elInput.focus();
  setStatus('ONLINE');
}

// ---- Start ----

async function startTerminal() {
  try {
    await initAudio();
    updateHeader();
    connectWebSocket();
    setStatus('ONLINE');
    elInput.focus();
  } catch (e) {
    addSystemMessage(`Error: ${e.message}`);
    console.error(e);
  }
}

// ---- Init ----
initUI();
