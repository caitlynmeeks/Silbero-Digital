/**
 * Silbo Terminal — Main application (Modem Edition)
 *
 * Classic FSK modem encoding/decoding with glitched Silbo Gomero imagery.
 * The modem screech is the medium; the whistler images are the metaphor.
 *
 * Audio pipeline:
 *   [keyboard] -> modem FSK encoder -> speaker
 *   microphone -> Goertzel detector -> FSK decoder -> display + printer
 */

import {
  encodeMessage, decodeMessage, detectCarrier,
  loopbackTest, generateHandshake, getFreqs,
  SAMPLE_RATE, BAUD_RATE, FREQ_PLAN
} from './modem.js';
import { GlitchRenderer } from './glitch.js';
import { ThermalPrinter } from './thermal-printer.js';

// ---- State ----
let audioCtx = null;
let micStream = null;
let analyserNode = null;
let micProcessor = null;
let terminalId = 1;
let listenTo = [1, 2, 3, 4, 5];
let isTransmitting = false;
let isListening = false;
let printer = null;
let glitch = null;

// Circular buffer for incoming audio (8 seconds — modem messages are longer)
const MIC_BUFFER_SECONDS = 8;
let micBuffer = null;
let micBufferWritePos = 0;

// ---- DOM refs ----
const elTerminalId = document.getElementById('terminal-id');
const elStatus = document.getElementById('status');
const elMessages = document.getElementById('messages');
const elInput = document.getElementById('input');
const elConfigPanel = document.getElementById('config-panel');
const elBtnConfig = document.getElementById('btn-config');
const elBtnPrinter = document.getElementById('btn-printer');
const elBtnStart = document.getElementById('btn-start');
const elPrinterStatus = document.getElementById('printer-status');
const elInputTerminalId = document.getElementById('input-terminal-id');
const elListenCheckboxes = document.getElementById('listen-checkboxes');
const elSpectrogram = document.getElementById('spectrogram');
const spectrogramCtx = elSpectrogram.getContext('2d', { willReadFrequently: true });
const elGlitchCanvas = document.getElementById('glitch-canvas');

// ---- UI Setup ----

function initUI() {
  // Build listen checkboxes
  for (let i = 1; i <= 5; i++) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = i !== 1;
    cb.dataset.terminal = i;
    cb.addEventListener('change', () => { listenTo = getListenTargets(); });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(` ${i}`));
    elListenCheckboxes.appendChild(label);
  }

  elBtnConfig.addEventListener('click', () => {
    elConfigPanel.classList.toggle('hidden');
  });

  elInputTerminalId.addEventListener('change', () => {
    terminalId = parseInt(elInputTerminalId.value, 10) || 1;
    updateHeader();
    for (const cb of elListenCheckboxes.querySelectorAll('input')) {
      cb.checked = parseInt(cb.dataset.terminal, 10) !== terminalId;
    }
    listenTo = getListenTargets();
  });

  elBtnPrinter.addEventListener('click', connectPrinter);
  elBtnStart.addEventListener('click', startTerminal);

  // Text input — auto-start on first Enter
  elInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !isTransmitting) {
      const text = elInput.value.trim();
      if (text.length > 0) {
        if (!audioCtx) await startTerminal();
        elInput.value = '';
        transmitMessage(text);
      }
    }
  });

  // Init glitch renderer
  elGlitchCanvas.width = 400;
  elGlitchCanvas.height = 300;
  glitch = new GlitchRenderer(elGlitchCanvas);
  glitch.start();

  updateHeader();
  addSystemMessage('SILBO TERMINAL v0.2 [MODEM] -- type and press Enter, or CONFIG to set up');
}

function getListenTargets() {
  const targets = [];
  for (const cb of elListenCheckboxes.querySelectorAll('input')) {
    if (cb.checked) targets.push(parseInt(cb.dataset.terminal, 10));
  }
  return targets;
}

function updateHeader() {
  elTerminalId.textContent = `TERMINAL ${String(terminalId).padStart(2, '0')}`;
}

function setStatus(status) {
  elStatus.textContent = status;
  elStatus.className = '';
  if (status === 'ONLINE') elStatus.classList.add('online');
  else if (status === 'RECEIVING') elStatus.classList.add('receiving');
  else if (status === 'TRANSMITTING') elStatus.classList.add('transmitting');
}

// ---- Messages ----

function addMessage(text, source, confidence = 1, isOutgoing = false) {
  const div = document.createElement('div');
  div.className = 'message';
  if (confidence < 0.6) div.classList.add('low-confidence');

  const sourceSpan = document.createElement('span');
  sourceSpan.className = 'source';
  sourceSpan.textContent = isOutgoing
    ? `[T${String(terminalId).padStart(2, '0')} >>] `
    : `[T${String(source).padStart(2, '0')} <<] `;

  const textSpan = document.createElement('span');
  textSpan.className = `text ${isOutgoing ? '' : 'incoming'}`;
  textSpan.textContent = text;

  div.appendChild(sourceSpan);
  div.appendChild(textSpan);

  if (!isOutgoing && confidence < 1) {
    const confSpan = document.createElement('span');
    confSpan.className = 'confidence';
    confSpan.textContent = `${Math.round(confidence * 100)}%`;
    div.appendChild(confSpan);
  }

  elMessages.appendChild(div);
  elMessages.scrollTop = elMessages.scrollHeight;
}

function addMessageAnimated(text, source, confidence = 1) {
  const div = document.createElement('div');
  div.className = 'message';
  if (confidence < 0.6) div.classList.add('low-confidence');

  const sourceSpan = document.createElement('span');
  sourceSpan.className = 'source';
  sourceSpan.textContent = `[T${String(source).padStart(2, '0')} <<] `;

  const textSpan = document.createElement('span');
  textSpan.className = 'text incoming decoding';

  const cursorSpan = document.createElement('span');
  cursorSpan.className = 'cursor-blink';
  cursorSpan.textContent = '_';

  div.appendChild(sourceSpan);
  div.appendChild(textSpan);
  div.appendChild(cursorSpan);
  elMessages.appendChild(div);

  let i = 0;
  const interval = setInterval(() => {
    if (i < text.length) {
      textSpan.textContent += text[i];
      i++;
      elMessages.scrollTop = elMessages.scrollHeight;
    } else {
      clearInterval(interval);
      cursorSpan.remove();
      textSpan.classList.remove('decoding');
      if (confidence < 1) {
        const confSpan = document.createElement('span');
        confSpan.className = 'confidence';
        confSpan.textContent = `${Math.round(confidence * 100)}%`;
        div.appendChild(confSpan);
      }
    }
  }, 35); // Faster reveal for modem speed (~28 chars/sec at 300 baud)
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.textContent = text;
  elMessages.appendChild(div);
  elMessages.scrollTop = elMessages.scrollHeight;
}

// ---- Audio Engine ----

async function initAudio() {
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: SAMPLE_RATE,
    }
  });

  const micSource = audioCtx.createMediaStreamSource(micStream);

  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 4096;
  analyserNode.smoothingTimeConstant = 0.7;
  micSource.connect(analyserNode);

  const bufferSize = 4096;
  micProcessor = audioCtx.createScriptProcessor(bufferSize, 1, 1);

  micBuffer = new Float32Array(MIC_BUFFER_SECONDS * SAMPLE_RATE);
  micBufferWritePos = 0;

  micProcessor.onaudioprocess = (e) => {
    if (!isListening) return;
    const input = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < input.length; i++) {
      micBuffer[micBufferWritePos] = input[i];
      micBufferWritePos = (micBufferWritePos + 1) % micBuffer.length;
    }
    const output = e.outputBuffer.getChannelData(0);
    output.fill(0);
  };

  micSource.connect(micProcessor);
  micProcessor.connect(audioCtx.destination);
  return true;
}

async function playAudio(samples) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const buffer = audioCtx.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(samples);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  return new Promise((resolve) => {
    source.onended = resolve;
    source.start();
  });
}

// ---- Transmit ----

async function transmitMessage(text) {
  if (isTransmitting) return;
  isTransmitting = true;
  setStatus('TRANSMITTING');
  elInput.disabled = true;

  addMessage(text, terminalId, 1, true);

  // Ramp up glitch visuals during transmission
  glitch.setIntensity(0.9);

  // Digital loopback test
  const loopback = loopbackTest(text, terminalId);
  if (loopback) {
    addSystemMessage(`[loopback] "${loopback.text}" (${Math.round(loopback.confidence * 100)}%) checksum:${loopback.text === text ? 'OK' : 'FAIL'}`);
  } else {
    addSystemMessage('[loopback] decode failed');
  }

  // Encode and play the modem audio
  const modemAudio = encodeMessage(text, terminalId);
  await playAudio(modemAudio);

  // Post-transmit cooldown
  await sleep(500);
  clearRecentAudio(MIC_BUFFER_SECONDS);

  // Ramp down glitch
  glitch.setIntensity(0);

  isTransmitting = false;
  elInput.disabled = false;
  elInput.focus();
  setStatus(isListening ? 'ONLINE' : 'OFFLINE');
}

// ---- Receive / Decode ----

let decodeInterval = null;

function startDecoding() {
  isListening = true;

  decodeInterval = setInterval(() => {
    if (isTransmitting) return;

    for (const tid of listenTo) {
      if (tid === terminalId) continue;

      const recentAudio = getRecentAudio(2.0);
      if (recentAudio.length === 0) continue;

      if (!detectCarrier(recentAudio, tid)) continue;

      // Carrier detected — grab full buffer and decode
      setStatus('RECEIVING');
      glitch.setIntensity(0.6);

      const fullAudio = getRecentAudio(MIC_BUFFER_SECONDS);
      const result = decodeMessage(fullAudio, tid);

      if (result && result.text.length > 0) {
        addMessageAnimated(result.text, result.source, result.confidence);

        if (printer && printer.connected) {
          printer.printMessage(result.text, result.source, result.confidence);
        }

        clearRecentAudio(MIC_BUFFER_SECONDS);
      }

      glitch.setIntensity(0);
      setStatus('ONLINE');
    }
  }, 500);
}

function stopDecoding() {
  isListening = false;
  if (decodeInterval) {
    clearInterval(decodeInterval);
    decodeInterval = null;
  }
}

function getRecentAudio(seconds) {
  if (!micBuffer) return new Float32Array(0);
  const samples = Math.min(Math.floor(seconds * SAMPLE_RATE), micBuffer.length);
  const output = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const idx = (micBufferWritePos - samples + i + micBuffer.length) % micBuffer.length;
    output[i] = micBuffer[idx];
  }
  return output;
}

function clearRecentAudio(seconds) {
  const samples = Math.min(Math.floor(seconds * SAMPLE_RATE), micBuffer.length);
  for (let i = 0; i < samples; i++) {
    const idx = (micBufferWritePos - samples + i + micBuffer.length) % micBuffer.length;
    micBuffer[idx] = 0;
  }
}

// ---- Spectrogram ----

let spectrogramAnimFrame = null;

function startSpectrogram() {
  const width = elSpectrogram.width;
  const height = elSpectrogram.height;
  const freqData = new Uint8Array(analyserNode.frequencyBinCount);

  function draw() {
    analyserNode.getByteFrequencyData(freqData);

    const imageData = spectrogramCtx.getImageData(1, 0, width - 1, height);
    spectrogramCtx.putImageData(imageData, 0, 0);

    // Show 0-4000 Hz (where our modem signals live)
    const maxBin = Math.floor((4000 / (SAMPLE_RATE / 2)) * freqData.length);

    for (let y = 0; y < height; y++) {
      const binIdx = Math.floor((1 - y / height) * maxBin);
      const value = freqData[binIdx] || 0;
      const brightness = Math.floor(value * 0.7);
      spectrogramCtx.fillStyle = `rgb(${brightness},${brightness},${brightness})`;
      spectrogramCtx.fillRect(width - 1, y, 1, 1);
    }

    // Draw frequency markers for our terminal's mark/space
    const freqs = getFreqs(terminalId);
    for (const f of [freqs.mark, freqs.space]) {
      const y = height - (f / 4000) * height;
      spectrogramCtx.fillStyle = 'rgba(100,100,100,0.6)';
      spectrogramCtx.fillRect(width - 1, Math.floor(y), 1, 1);
    }

    spectrogramAnimFrame = requestAnimationFrame(draw);
  }

  draw();
}

// ---- Printer ----

async function connectPrinter() {
  printer = new ThermalPrinter();
  try {
    await printer.connect();
    elPrinterStatus.textContent = `CONNECTED (${printer.mode})`;
    await printer.printStatus(`SILBO TERMINAL ${String(terminalId).padStart(2, '0')} ONLINE`);
    addSystemMessage(`Printer connected via ${printer.mode}`);
  } catch (e) {
    elPrinterStatus.textContent = 'FAILED';
    addSystemMessage(`Printer: ${e.message}`);
    printer = null;
  }
}

// ---- Start / Stop ----

async function startTerminal() {
  try {
    addSystemMessage('Initializing audio...');
    await initAudio();

    terminalId = parseInt(elInputTerminalId.value, 10) || 1;
    listenTo = getListenTargets();
    updateHeader();

    const freqs = getFreqs(terminalId);
    addSystemMessage(`Modem: mark=${freqs.mark}Hz space=${freqs.space}Hz @ ${BAUD_RATE} baud`);
    addSystemMessage(`Listening for: ${listenTo.filter(t => t !== terminalId).join(', ') || 'none'}`);

    startDecoding();
    startSpectrogram();

    elConfigPanel.classList.add('hidden');
    setStatus('ONLINE');
    elInput.focus();

    addSystemMessage('Terminal online. Type a message and press Enter.');

    if (printer && printer.connected) {
      await printer.printStatus('LISTENING');
    }
  } catch (e) {
    addSystemMessage(`Error: ${e.message}`);
    console.error(e);
  }
}

// ---- Util ----

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- Init ----
initUI();
