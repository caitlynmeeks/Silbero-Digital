/**
 * Silbero Digital — Operator Surveillance Console
 *
 * The panopticon. Shows live camera feeds, decoded messages in swim lanes,
 * and detailed biometric dossiers from the server-side face analysis.
 * The operator sees everything the subjects don't know is being collected.
 */

import {
  synthesizeSilbo, playSilboAsync, getWaveform, deriveVoiceProfile,
  SAMPLE_RATE, getFreq, PUNCT_PERC
} from './silbo-synth.js';
import { ThermalPrinter } from './thermal-printer.js';
import * as midi from './midi-bridge.js';

const MSG_AUDIO = 0x01;
const MSG_CAMERA = 0x02;
const MSG_FACE_SNAP = 0x03;

// ---- State ----
let audioCtx = null;
let ws = null;
let printer = null;
let messageCount = 0;
let subjectCount = 0;

const latestFaces = {};      // terminalId -> ImageBitmap
const latestFaceBlobs = {};  // terminalId -> Blob
const faceAnalysis = {};     // terminalId -> analysis result from server
const clientInfo = {};       // terminalId -> registration dossier

// ---- Mixer State ----
const mixerState = {};       // terminalId -> { muted, soloed, looping, lastSamples, lastDurationMs, lastText, loopTimer }
let globalQuantize = false;
let globalBPM = 120;
let internalMuted = false;
let quantizeStartTime = 0;   // AudioContext time when quantize grid started

function getMixer(terminalId) {
  if (!mixerState[terminalId]) {
    mixerState[terminalId] = { muted: false, soloed: false, looping: false, lastSamples: null, lastDurationMs: 0, lastText: null, loopTimer: null };
  }
  return mixerState[terminalId];
}

function isAnySoloed() {
  return Object.values(mixerState).some(m => m.soloed);
}

function shouldPlay(terminalId) {
  const m = getMixer(terminalId);
  if (m.muted) return false;
  if (isAnySoloed() && !m.soloed) return false;
  return true;
}

// ---- Euclidean Rhythm Engine ----
//
// Bjorklund's algorithm: distribute K pulses as evenly as possible
// across N steps. Produces the rhythmic patterns found in West African
// bell patterns, Cuban tresillo, bossa nova, and most world music.
//
// E(3,8)  = [1,0,0,1,0,0,1,0]  — Cuban tresillo
// E(5,8)  = [1,0,1,1,0,1,1,0]  — Cuban cinquillo
// E(5,12) = [1,0,0,1,0,1,0,0,1,0,1,0] — Bembé bell
// E(7,12) = [1,0,1,1,0,1,0,1,1,0,1,0] — West African bell
// E(5,16) = [1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,0] — Bossa nova

function bjorklund(pulses, steps) {
  if (pulses >= steps) return new Array(steps).fill(1);
  if (pulses <= 0) return new Array(steps).fill(0);

  let pattern = [];
  for (let i = 0; i < steps; i++) {
    pattern.push(i < pulses ? [1] : [0]);
  }

  let level = 0;
  while (true) {
    let counts = 0;
    const newPattern = [];
    let i = 0;
    let j = pattern.length - 1;

    while (i < j && pattern[j][0] !== pattern[i][0]) {
      newPattern.push(pattern[i].concat(pattern[j]));
      i++;
      j--;
      counts++;
    }

    if (counts <= 1) break;

    // Append remaining unmatched elements
    while (i <= j) {
      newPattern.push(pattern[i]);
      i++;
    }
    pattern = newPattern;
    level++;
  }

  return pattern.flat();
}

/**
 * Density presets. Each returns a boolean mask for the given step count.
 *   'all'  — every step plays
 *   '1/2'  — every other step
 *   '1/3'  — every third step
 *   '1/4'  — every fourth step
 *   'e3'   — Euclidean 3 of N
 *   'e5'   — Euclidean 5 of N
 *   'e7'   — Euclidean 7 of N
 *   'e9'   — Euclidean 9 of N
 *   'e11'  — Euclidean 11 of N
 */
function getDensityMask(preset, stepCount) {
  if (preset === 'all' || !preset) return new Array(stepCount).fill(true);

  // Simple divisors
  const divMatch = preset.match(/^1\/(\d+)$/);
  if (divMatch) {
    const div = parseInt(divMatch[1]);
    return Array.from({ length: stepCount }, (_, i) => i % div === 0);
  }

  // Euclidean
  const eucMatch = preset.match(/^e(\d+)$/);
  if (eucMatch) {
    const pulses = Math.min(parseInt(eucMatch[1]), stepCount);
    const pattern = bjorklund(pulses, stepCount);
    return pattern.map(v => v === 1);
  }

  return new Array(stepCount).fill(true);
}

/**
 * Apply a density mask to text: replace masked-out characters with spaces.
 * Preserves existing spaces (they stay as rests regardless).
 */
function applyDensity(text, preset) {
  if (preset === 'all' || !preset) return text;

  // Count only non-space characters for the mask
  const chars = [];
  const indices = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') {
      chars.push(text[i]);
      indices.push(i);
    }
  }

  const mask = getDensityMask(preset, chars.length);
  const result = text.split('');

  for (let i = 0; i < chars.length; i++) {
    if (!mask[i]) {
      result[indices[i]] = ' '; // rest
    }
  }

  return result.join('');
}

// ---- Clip State (per swim lane) ----
let clipIdCounter = 0;
const clips = {};

function createClip(sourceId, samples, text, durationMs) {
  const id = ++clipIdCounter;
  clips[id] = {
    sourceId,
    samples,
    text,           // original text
    durationMs,
    channel: midi.getTerminalChannel(sourceId),
    density: 'all', // density preset
    live: false,
    looping: false,
    loopTimer: null,
  };
  return id;
}

/**
 * Re-synthesize a clip with its current density setting.
 */
function resynthClip(clipId) {
  const clip = clips[clipId];
  if (!clip) return;

  const thinnedText = applyDensity(clip.text, clip.density);
  const fa = faceAnalysis[clip.sourceId];
  const voiceProfile = (fa && fa.faces && fa.faces[0])
    ? deriveVoiceProfile(fa.faces[0])
    : getWaveform(clip.sourceId);

  const { samples, durationMs } = synthesizeSilbo(thinnedText, voiceProfile);
  clip.samples = samples;
  clip.durationMs = durationMs;
}

function triggerClip(clipId) {
  const clip = clips[clipId];
  if (!clip) return;
  const thinnedText = applyDensity(clip.text, clip.density);
  const savedCh = midi.getTerminalChannel(clip.sourceId);
  midi.setTerminalChannel(clip.sourceId, clip.channel);
  playAudioSamples(clip.samples);
  midi.sendMelodyMIDI(clip.sourceId, thinnedText, clip.durationMs, getFreq, PUNCT_PERC);
  broadcastNote(clip.channel, clip.text, thinnedText, clip.durationMs, clip.sourceId);
  midi.setTerminalChannel(clip.sourceId, savedCh);
}

function startClipLoop(clipId) {
  const clip = clips[clipId];
  if (!clip || clip.looping) return;
  clip.looping = true;

  // Use worker-based interval for background-safe timing
  workerInterval('clip_' + clipId, () => {
    if (!clip.looping) return;
    const thinnedText = applyDensity(clip.text, clip.density);
    const savedCh = midi.getTerminalChannel(clip.sourceId);
    midi.setTerminalChannel(clip.sourceId, clip.channel);
    if (clip.live) {
      playAudioSamples(clip.samples);
    }
    midi.sendMelodyMIDI(clip.sourceId, thinnedText, clip.durationMs, getFreq, PUNCT_PERC);
    broadcastNote(clip.channel, clip.text, thinnedText, clip.durationMs, clip.sourceId);
    midi.setTerminalChannel(clip.sourceId, savedCh);
  }, clip.durationMs);

  // Also fire immediately on first tick
  triggerClip(clipId);
}

function stopClipLoop(clipId) {
  const clip = clips[clipId];
  if (!clip) return;
  clip.looping = false;
  workerClearInterval('clip_' + clipId);
  vizChannel.postMessage({ type: 'stop', channel: clip.channel, sourceId: clip.sourceId });
}

// ---- Channel Visualization Broadcast ----
// Sends events to the channel-viz window via BroadcastChannel.
const vizChannel = new BroadcastChannel('silbero-viz');

/**
 * Broadcast a note event to the VIZ window.
 * @param {number} channel
 * @param {string} displayText - Full original text (for readability)
 * @param {string} activeText - Thinned text after density (which chars trigger)
 * @param {number} durationMs
 * @param {number} sourceId
 */
function broadcastNote(channel, displayText, activeText, durationMs, sourceId) {
  vizChannel.postMessage({
    type: 'note',
    channel,
    displayText,
    activeText,
    durationMs,
    sourceId,
    name: clientInfo[sourceId]?.name || `TF${sourceId}`,
    time: Date.now(),
  });

  // Per-character tick events for channel label flash (only for active chars)
  const msPerChar = durationMs / Math.max(1, displayText.length);
  for (let i = 0; i < displayText.length; i++) {
    if (activeText[i] && activeText[i] !== ' ') {
      setTimeout(() => {
        vizChannel.postMessage({ type: 'tick', channel, time: Date.now() });
      }, i * msPerChar);
    }
  }
}

function broadcastBassNote(midiNote, durationMs) {
  vizChannel.postMessage({ type: 'bass', midiNote, durationMs, time: Date.now() });
}

function broadcastDrum(percType) {
  vizChannel.postMessage({ type: 'drum', percType, time: Date.now() });
}

// ---- Timer Worker ----
// Web Workers are NOT throttled when the tab loses focus. This is critical
// for keeping the sequencer running at full speed while the operator works
// in Logic Pro. Every timing-sensitive loop uses this instead of setInterval.
const timerWorker = new Worker(URL.createObjectURL(new Blob([`
  const timers = {};
  self.onmessage = (e) => {
    const { id, cmd, ms } = e.data;
    if (cmd === 'start') {
      if (timers[id]) clearInterval(timers[id]);
      timers[id] = setInterval(() => self.postMessage(id), ms || 25);
    } else if (cmd === 'stop') {
      if (timers[id]) { clearInterval(timers[id]); delete timers[id]; }
    }
  };
`], { type: 'text/javascript' })));

const workerCallbacks = {};
timerWorker.onmessage = (e) => {
  const cb = workerCallbacks[e.data];
  if (cb) cb();
};

function workerInterval(id, callback, ms) {
  workerCallbacks[id] = callback;
  timerWorker.postMessage({ id, cmd: 'start', ms });
}

function workerClearInterval(id) {
  timerWorker.postMessage({ id, cmd: 'stop' });
  delete workerCallbacks[id];
}

// ---- Psytrance Bass Engine ----
//
// Continuous backing track on the AudioContext. Uses the Worker timer
// so it keeps running at full speed even when the browser tab is in
// the background (operator working in Logic Pro).
//
// Patterns:
//   - psy:    classic "rest, on, on, on" 16th note pattern (psytrance)
//   - drive:  every 16th note (relentless)
//   - arp:    arpeggio over E minor pentatonic (E, G, A, B, D)
//   - arpUp:  ascending arpeggio E2, B2, E3, G3, B3 looping
//   - off:    half-step shuffle (off-beat 8ths)

const bassEngine = {
  enabled: false,
  pattern: 'psy',
  noteIdx: 0,
  nextNoteTime: 0,
  step: 0,
  scheduleTimer: null,
  rootMidi: 28,    // E1 (MIDI 28)
};

const BASS_PATTERNS = {
  // Each entry is an array of 16 sixteenths over one bar.
  // null = rest. Numbers = semitone offset from rootMidi.
  psy:    [null, 0, 0, 0,  null, 0, 0, 0,  null, 0, 0, 0,  null, 0, 0, 0],
  drive:  [0,    0, 0, 0,  0,    0, 0, 0,  0,    0, 0, 0,  0,    0, 0, 0],
  off:    [null, 0, null, 0,  null, 0, null, 0,  null, 0, null, 0,  null, 0, null, 0],
  arp:    [0, 7, 12, 7,  0, 7, 12, 15,  0, 7, 12, 19,  0, 7, 12, 7],     // E pent rolling
  arpUp:  [0, 7, 12, 19,  0, 7, 12, 19,  0, 7, 12, 19,  0, 7, 12, 19],   // ascending pluck
  arpDn:  [19, 12, 7, 0,  19, 12, 7, 0,  19, 12, 7, 0,  19, 12, 7, 0],   // descending
  acid:   [0, null, 12, 0,  null, 7, 0, null,  12, 0, null, 7,  0, null, 12, 7], // acid line
};

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function startBassEngine() {
  if (bassEngine.enabled || !audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  bassEngine.enabled = true;
  bassEngine.nextNoteTime = audioCtx.currentTime + 0.05;
  bassEngine.step = 0;
  scheduleAhead();
  workerInterval('bass', scheduleAhead, 25);
}

function stopBassEngine() {
  bassEngine.enabled = false;
  workerClearInterval('bass');
}

function scheduleAhead() {
  if (!bassEngine.enabled || !audioCtx) return;
  const lookAhead = 0.1;
  const sixteenthDur = 60 / globalBPM / 4;
  const pattern = BASS_PATTERNS[bassEngine.pattern] || BASS_PATTERNS.psy;

  while (bassEngine.nextNoteTime < audioCtx.currentTime + lookAhead) {
    const stepInBar = bassEngine.step % pattern.length;
    const offset = pattern[stepInBar];

    if (offset !== null) {
      const midi = bassEngine.rootMidi + offset;
      playBassNote(bassEngine.nextNoteTime, sixteenthDur * 0.95, midi);
    }

    bassEngine.nextNoteTime += sixteenthDur;
    bassEngine.step++;
  }
}

/**
 * Play a single psytrance bass note at a precisely scheduled time.
 * Sawtooth + sub sine, into resonant lowpass with envelope sweep, into
 * a punchy amp envelope. The classic plucky-deep psytrance signature.
 */
function playBassNote(when, duration, midiNote) {
  // MIDI output + viz broadcast
  midi.sendBassNoteMIDI(midiNote, duration * 1000, 100);
  broadcastBassNote(midiNote, duration * 1000);

  // Skip internal audio if muted
  if (internalMuted) return;

  const ctx = audioCtx;
  const freq = midiToFreq(midiNote);

  // Oscillators
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = freq;

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = freq / 2;  // sub octave

  // Resonant lowpass filter
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 10;
  filter.frequency.setValueAtTime(900, when);
  filter.frequency.exponentialRampToValueAtTime(180, when + 0.06);

  // Amp envelope: pluck
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, when);
  amp.gain.linearRampToValueAtTime(0.45, when + 0.004);
  amp.gain.exponentialRampToValueAtTime(0.001, when + duration);

  // Routing: osc + sub -> filter -> amp -> dest
  osc.connect(filter);
  sub.connect(filter);
  filter.connect(amp);
  amp.connect(ctx.destination);

  osc.start(when);
  osc.stop(when + duration + 0.02);
  sub.start(when);
  sub.stop(when + duration + 0.02);
}


// ---- DOM refs ----
const elProfiles = document.getElementById('subject-profiles');
const elLanes = document.getElementById('operator-lanes');
const elWsStatus = document.getElementById('op-ws-status');
const elStats = document.getElementById('op-stats');
const elSubjects = document.getElementById('op-subjects');
const elBtnPrinter = document.getElementById('btn-op-printer');
const elPrinterStatus = document.getElementById('op-printer-status');

// ---- Init ----

function init() {
  elBtnPrinter.addEventListener('click', connectPrinter);

  // Channel visualization window
  document.getElementById('btn-viz').addEventListener('click', () => {
    window.open('/channels.html', 'silbero-viz', 'width=1920,height=400,menubar=no,toolbar=no');
  });

  document.getElementById('btn-disconnect-all').addEventListener('click', () => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ command: 'disconnect-all' }));
    }
  });

  // Quantize controls
  const btnQuantize = document.getElementById('btn-quantize');
  const bpmDisplay = document.getElementById('bpm-display');

  btnQuantize.addEventListener('click', () => {
    globalQuantize = !globalQuantize;
    btnQuantize.classList.toggle('active', globalQuantize);
    if (globalQuantize && audioCtx) {
      quantizeStartTime = audioCtx.currentTime;
    }
  });

  document.getElementById('bpm-down').addEventListener('click', () => {
    globalBPM = Math.max(40, globalBPM - 10);
    bpmDisplay.textContent = globalBPM;
    midi.updateClockBPM(globalBPM);
  });

  document.getElementById('bpm-up').addEventListener('click', () => {
    globalBPM = Math.min(300, globalBPM + 10);
    bpmDisplay.textContent = globalBPM;
    midi.updateClockBPM(globalBPM);
  });

  // Bass engine controls
  const btnBass = document.getElementById('btn-bass');
  btnBass.addEventListener('click', () => {
    if (bassEngine.enabled) {
      stopBassEngine();
      btnBass.classList.remove('active');
    } else {
      startBassEngine();
      btnBass.classList.add('active');
    }
  });

  document.getElementById('bass-pattern').addEventListener('change', (e) => {
    bassEngine.pattern = e.target.value;
    bassEngine.step = 0; // restart pattern from top
  });

  document.getElementById('bass-octave').addEventListener('change', (e) => {
    bassEngine.rootMidi = parseInt(e.target.value, 10);
  });

  // MIDI bridge controls
  const btnMidi = document.getElementById('btn-midi');
  const selMidiPort = document.getElementById('midi-port');

  btnMidi.addEventListener('click', async () => {
    if (midi.isEnabled()) {
      // Disconnect
      midi.stopClock();
      midi.disconnect();
      btnMidi.classList.remove('active');
      selMidiPort.disabled = true;
      return;
    }

    // Init and populate port list
    const outputs = await midi.initMIDI();
    selMidiPort.innerHTML = '';
    if (outputs.length === 0) {
      selMidiPort.innerHTML = '<option value="">NO MIDI DEVICES</option>';
      return;
    }
    for (const port of outputs) {
      const opt = document.createElement('option');
      opt.value = port.id;
      opt.textContent = port.name;
      selMidiPort.appendChild(opt);
    }
    selMidiPort.disabled = false;

    // Connect to first port
    if (outputs.length > 0) {
      midi.connectOutput(outputs[0].id);
      midi.startClock(globalBPM);
      btnMidi.classList.add('active');
    }
  });

  // Global pitch bend toggle
  const btnGlobalPB = document.getElementById('btn-global-pb');
  btnGlobalPB.addEventListener('click', () => {
    const now = !midi.getGlobalPitchBend();
    midi.setGlobalPitchBend(now);
    btnGlobalPB.classList.toggle('active', now);
  });

  // Scale and root selectors
  document.getElementById('scale-select').addEventListener('change', (e) => {
    midi.setScale(e.target.value);
  });

  document.getElementById('root-select').addEventListener('change', (e) => {
    midi.setRoot(parseInt(e.target.value, 10));
  });

  // Internal synth mute
  const btnMuteInt = document.getElementById('btn-mute-internal');
  btnMuteInt.addEventListener('click', () => {
    internalMuted = !internalMuted;
    btnMuteInt.classList.toggle('active', internalMuted);
  });

  selMidiPort.addEventListener('change', (e) => {
    if (e.target.value) {
      midi.disconnect();
      midi.connectOutput(e.target.value);
      midi.startClock(globalBPM);
      btnMidi.classList.add('active');
    }
  });

  initAudio();
  connectWebSocket();
}

async function initAudio() {
  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
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
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'dossier':
            handleDossier(msg);
            addEventLane(msg.terminal, 'connect', msg.name || `TF${msg.terminal}`);
            break;
          case 'face-analysis':
            handleFaceAnalysis(msg);
            break;
          case 'face-snap-id':
            handleFaceSnapId(msg);
            break;
          case 'message':
            handleTextMessage(msg);
            break;
          case 'disconnect':
            addEventLane(msg.terminal, 'disconnect', msg.name || `TF${msg.terminal}`);
            break;
        }
      } catch (e) {}
      return;
    }

    if (!(event.data instanceof ArrayBuffer)) return;

    const bytes = new Uint8Array(event.data);
    const msgType = bytes[0];
    const rawByte = bytes[1];
    const fullId = resolveId(rawByte);
    const payload = bytes.subarray(2);

    switch (msgType) {
      case MSG_AUDIO:
        handleAudio(fullId, payload);
        break;
      case MSG_CAMERA:
        handleCameraFrame(fullId, payload);
        break;
      case MSG_FACE_SNAP:
        handleFaceSnap(fullId, payload);
        break;
    }
  };
}

// ---- Dossier (registration) ----

function handleDossier(msg) {
  clientInfo[msg.terminal] = msg;

  if (!document.getElementById(`subject-${msg.terminal}`)) {
    subjectCount++;
    elSubjects.textContent = `${subjectCount} subjects`;
  }

  // Create subject profile card (will be enriched by face analysis)
  createOrUpdateSubjectCard(msg.terminal);

  // Log to swim lanes
  const lane = createLane(msg.terminal, 'dossier');
  const fp = msg.fingerprint || {};
  const body = lane.querySelector('.op-lane-body');

  const deviceDiv = document.createElement('div');
  deviceDiv.className = 'op-lane-device';
  const lines = [
    fp.ip ? `${fp.ip} (${fp.city || '?'}, ${fp.country || '?'})` : msg.ip || '?',
    fp.gpuRenderer || '',
    fp.screenWidth ? `${fp.screenWidth}x${fp.screenHeight} @${fp.pixelRatio}x` : '',
    fp.hardwareConcurrency ? `${fp.hardwareConcurrency} cores${fp.deviceMemory ? ' / ' + fp.deviceMemory + 'GB' : ''}` : '',
    fp.deviceHash ? `DH:${fp.deviceHash.slice(0, 16)}` : '',
  ].filter(Boolean);
  deviceDiv.textContent = lines.join(' | ');
  body.appendChild(deviceDiv);

  const tag = document.createElement('div');
  tag.style.cssText = 'color:#333;font-size:9px;margin-top:2px;';
  tag.textContent = 'CONNECTED';
  body.appendChild(tag);
}

// ---- Binary ID Resolution ----
// Binary protocol uses 1-byte source ID (truncated). We resolve to full
// terminal IDs by matching against registered terminals in clientInfo.
const binaryIdMap = {}; // truncated byte -> full terminal ID

/**
 * Resolve a truncated 1-byte source ID to the full terminal ID.
 * Searches registered terminals for a match.
 */
function resolveId(truncatedByte) {
  if (binaryIdMap[truncatedByte] !== undefined) return binaryIdMap[truncatedByte];
  for (const tid of Object.keys(clientInfo)) {
    if ((Number(tid) & 0xFF) === truncatedByte) {
      binaryIdMap[truncatedByte] = Number(tid);
      return Number(tid);
    }
  }
  return truncatedByte; // fallback if no match yet
}

function handleFaceSnapId(msg) {
  const truncId = msg.binarySourceByte;
  const fullId = msg.terminal;
  binaryIdMap[truncId] = fullId;

  // Migrate any data stored under the truncated ID
  if (truncId !== fullId) {
    if (latestFaces[truncId]) {
      latestFaces[fullId] = latestFaces[truncId];
      delete latestFaces[truncId];
    }
    if (latestFaceBlobs[truncId]) {
      latestFaceBlobs[fullId] = latestFaceBlobs[truncId];
      delete latestFaceBlobs[truncId];
    }
    if (faceAnalysis[truncId]) {
      faceAnalysis[fullId] = faceAnalysis[truncId];
      delete faceAnalysis[truncId];
    }
    // Remove ghost DOM elements created under truncated ID
    const ghostCard = document.getElementById(`subject-${truncId}`);
    if (ghostCard) ghostCard.remove();

    createOrUpdateSubjectCard(fullId);
  }
}

// ---- Face Analysis (from server ML) ----

function handleFaceAnalysis(msg) {
  faceAnalysis[msg.terminal] = msg.analysis;
  createOrUpdateSubjectCard(msg.terminal);
}

/**
 * Create or update the subject profile card with all available data.
 */
function createOrUpdateSubjectCard(terminalId) {
  let card = document.getElementById(`subject-${terminalId}`);
  const info = clientInfo[terminalId] || {};
  const analysis = faceAnalysis[terminalId];
  const face = analysis && analysis.faces && analysis.faces[0];
  const fp = info.fingerprint || {};

  if (!card) {
    card = document.createElement('div');
    card.className = 'subject-card';
    card.id = `subject-${terminalId}`;
    elProfiles.appendChild(card);
  }

  const hasAnalysis = !!analysis;
  card.className = `subject-card ${face ? 'complete' : hasAnalysis ? 'complete' : 'analyzing'}`;

  const name = info.name || `TF${terminalId}`;

  // Build card HTML
  let html = `
    <div class="subject-card-header">
      <div class="subject-face">
        <canvas id="subject-face-canvas-${terminalId}" width="320" height="240"></canvas>
      </div>
      <div class="subject-identity">
        <div class="subject-name">${esc(name)}</div>
        <div class="subject-tag">T${String(terminalId).padStart(5, '0')} ${info.time ? new Date(info.time).toTimeString().slice(0, 8) : ''}</div>
        <div class="subject-primary">`;

  if (face) {
    html += `
          <div class="subject-stat">
            <span class="subject-stat-label">AGE</span>
            <span class="subject-stat-value highlight">${Math.round(face.age)}</span>
          </div>
          <div class="subject-stat">
            <span class="subject-stat-label">GENDER</span>
            <span class="subject-stat-value highlight">${face.gender.toUpperCase()}</span>
          </div>
          <div class="subject-stat">
            <span class="subject-stat-label">EXPR</span>
            <span class="subject-stat-value">${face.expression.dominant.toUpperCase()}</span>
          </div>`;
  } else if (hasAnalysis) {
    html += `
          <div class="subject-stat">
            <span class="subject-stat-label">STATUS</span>
            <span class="subject-stat-value">NO FACE DETECTED</span>
          </div>`;
  } else {
    html += `
          <div class="subject-stat">
            <span class="subject-stat-label">STATUS</span>
            <span class="subject-stat-value">AWAITING ANALYSIS</span>
          </div>`;
  }

  html += `
        </div>
      </div>
    </div>`;

  if (face) {
    // Expression bar visualization
    const exprColors = {
      neutral: '#555', happy: '#777', sad: '#444', angry: '#666',
      fearful: '#333', disgusted: '#444', surprised: '#666'
    };
    html += `<div class="expression-bar">`;
    for (const [expr, score] of Object.entries(face.expression.scores)) {
      if (score > 0.01) {
        html += `<div class="expression-segment" style="width:${score * 100}%;background:${exprColors[expr] || '#333'}" title="${expr}: ${Math.round(score * 100)}%"></div>`;
      }
    }
    html += `</div>`;

    // Detailed analysis grid
    html += `<div class="subject-details">`;
    html += detail('EYES', face.eyeColor.color.toUpperCase());
    html += detail('SKIN', `${face.skinTone.label.toUpperCase()} (${face.skinTone.fitzpatrick})`);
    html += detail('HAIR', face.hairColor.color.toUpperCase());
    html += detail('SHAPE', face.faceShape.toUpperCase());
    html += detail('SYMMETRY', `${Math.round(face.symmetry * 100)}%`);
    html += detail('IPD', `${face.ipd}px`);
    html += detail('GLASSES', face.glasses.detected ? 'DETECTED' : 'NONE');
    html += detail('FACIAL HAIR', (face.facialHair.mustache || face.facialHair.beard) ?
      [face.facialHair.mustache && 'MUSTACHE', face.facialHair.beard && 'BEARD'].filter(Boolean).join('+') : 'NONE');
    html += detail('YAW', `${face.headPose.yaw > 0 ? '+' : ''}${face.headPose.yaw}`);
    html += detail('PITCH', `${face.headPose.pitch > 0 ? '+' : ''}${face.headPose.pitch}`);
    html += detail('ROLL', `${face.headPose.roll > 0 ? '+' : ''}${face.headPose.roll}`);
    html += detail('GENDER CONF', `${Math.round(face.genderConfidence * 100)}%`);
    html += `</div>`;
  }

  // Device fingerprint summary
  if (fp.ip || fp.deviceHash) {
    html += `<div class="subject-device">`;
    if (fp.ip) html += `<span>IP:</span> ${esc(fp.ip)} `;
    if (fp.city) html += `${esc(fp.city)}, ${esc(fp.countryCode || fp.country || '')} `;
    if (fp.macAddress) html += `<span>MAC:</span> ${esc(fp.macAddress)} `;
    if (fp.deviceHash) html += `<span>DH:</span> ${fp.deviceHash.slice(0, 20)} `;
    if (fp.doNotTrack) html += `<span style="color:#555">DNT:ON</span> `;
    html += `</div>`;
  }

  // Mixer controls
  const m = getMixer(terminalId);
  html += `
    <div class="mixer-controls" data-terminal="${terminalId}">
      <button class="mixer-btn ${m.muted ? 'active' : ''}" data-action="mute">M</button>
      <button class="mixer-btn ${m.soloed ? 'active' : ''}" data-action="solo">S</button>
      <button class="mixer-btn ${m.looping ? 'active' : ''}" data-action="loop">LOOP</button>
      <button class="mixer-btn pb-btn ${midi.getTerminalPitchBend(terminalId) ? 'active' : ''}" data-action="pb" title="Pitch Bend">PB</button>
      <select class="midi-ch-select" data-action="midi-ch" title="MIDI channel">
        ${[1,2,3,4,5,6,7,8].map(n => `<option value="${n - 1}" ${midi.getTerminalChannel(terminalId) === n - 1 ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>`;

  card.innerHTML = html;

  // Wire mixer button events
  card.querySelectorAll('.mixer-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const mx = getMixer(terminalId);

      if (action === 'mute') {
        // Mute suppresses playback but keeps loop timer running so timing
        // is preserved and the operator can toggle it back in on the beat.
        mx.muted = !mx.muted;
        btn.classList.toggle('active', mx.muted);
      } else if (action === 'solo') {
        mx.soloed = !mx.soloed;
        btn.classList.toggle('active', mx.soloed);
      } else if (action === 'loop') {
        if (mx.looping) {
          stopLoop(terminalId);
        } else {
          startLoop(terminalId);
        }
        btn.classList.toggle('active', mx.looping);
      }
    });
  });

  // Per-user pitch bend toggle
  const pbBtn = card.querySelector('.pb-btn');
  if (pbBtn) {
    pbBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = midi.getTerminalPitchBend(terminalId);
      midi.setTerminalPitchBend(terminalId, !current);
      pbBtn.classList.toggle('active', !current);
    });
  }

  // MIDI channel selector
  const chSelect = card.querySelector('.midi-ch-select');
  if (chSelect) {
    chSelect.addEventListener('click', (e) => e.stopPropagation());
    chSelect.addEventListener('change', (e) => {
      midi.setTerminalChannel(terminalId, parseInt(e.target.value, 10));
    });
  }

  // Cmd+click to move card to far left (prioritize subjects of interest)
  card.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      elProfiles.insertBefore(card, elProfiles.firstChild);
    }
  });

  // Draw face to canvas after DOM update
  requestAnimationFrame(() => {
    const faceCanvas = document.getElementById(`subject-face-canvas-${terminalId}`);
    if (!faceCanvas) return;
    const ctx = faceCanvas.getContext('2d');
    const cw = 320;
    const ch = 240;
    faceCanvas.width = cw;
    faceCanvas.height = ch;

    if (latestFaces[terminalId]) {
      ctx.drawImage(latestFaces[terminalId], 0, 0, cw, ch);
      if (face) {
        drawFaceAnnotations(ctx, face, analysis.imageWidth, analysis.imageHeight, cw, ch);
      }
    } else {
      drawUnknownUser(ctx, cw, ch);
    }
  });
}

/**
 * Draw an unknown user silhouette when no face image exists.
 * Dark surveillance-style head/shoulders with targeting overlay.
 */
function drawUnknownUser(ctx, w, h) {
  // Background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const headR = w * 0.12;
  const headY = h * 0.35;

  // Head circle
  ctx.fillStyle = '#181818';
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fill();

  // Shoulders arc
  ctx.beginPath();
  ctx.ellipse(cx, h * 0.85, w * 0.28, h * 0.3, 0, Math.PI, 0);
  ctx.fill();

  // Neck
  ctx.fillRect(cx - headR * 0.4, headY + headR - 2, headR * 0.8, h * 0.12);

  // Targeting reticle over the head
  ctx.strokeStyle = 'rgba(255, 204, 0, 0.3)';
  ctx.lineWidth = 1.5;
  const rr = headR * 1.8;

  // Outer circle
  ctx.beginPath();
  ctx.arc(cx, headY, rr, 0, Math.PI * 2);
  ctx.stroke();

  // Crosshairs
  ctx.strokeStyle = 'rgba(255, 204, 0, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - rr * 1.5, headY);
  ctx.lineTo(cx - rr * 0.3, headY);
  ctx.moveTo(cx + rr * 0.3, headY);
  ctx.lineTo(cx + rr * 1.5, headY);
  ctx.moveTo(cx, headY - rr * 1.5);
  ctx.lineTo(cx, headY - rr * 0.3);
  ctx.moveTo(cx, headY + rr * 0.3);
  ctx.lineTo(cx, headY + rr * 1.5);
  ctx.stroke();

  // Corner brackets
  ctx.strokeStyle = 'rgba(255, 204, 0, 0.25)';
  ctx.lineWidth = 1;
  const bx = cx - w * 0.3, by = h * 0.08, bw = w * 0.6, bh = h * 0.75;
  const cl = bw * 0.15;
  ctx.beginPath();
  ctx.moveTo(bx, by + cl); ctx.lineTo(bx, by); ctx.lineTo(bx + cl, by);
  ctx.moveTo(bx + bw - cl, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cl);
  ctx.moveTo(bx, by + bh - cl); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cl, by + bh);
  ctx.moveTo(bx + bw - cl, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - cl);
  ctx.stroke();

  // "NO ID" label
  ctx.fillStyle = 'rgba(255, 204, 0, 0.4)';
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('NO ID', cx, h * 0.92);
  ctx.textAlign = 'left';

  // Scan lines
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  for (let y = 0; y < h; y += 3) {
    ctx.fillRect(0, y, w, 1);
  }
}

function detail(label, value) {
  return `<div class="subject-detail"><span class="subject-detail-label">${label}</span><span class="subject-detail-value">${value}</span></div>`;
}

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/**
 * Draw surveillance-style facial annotation overlay.
 * Yellow targeting reticles, green landmark traces, red crosshairs.
 */
function drawFaceAnnotations(ctx, face, srcW, srcH, dstW, dstH) {
  const sx = dstW / srcW;
  const sy = dstH / srcH;

  const b = face.box;
  const bx = b.x * sx, by = b.y * sy, bw = b.width * sx, bh = b.height * sy;
  const cornerLen = Math.min(bw, bh) * 0.25;

  // --- Yellow bounding box with corner brackets ---
  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(bx, by + cornerLen); ctx.lineTo(bx, by); ctx.lineTo(bx + cornerLen, by);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bx + bw - cornerLen, by); ctx.lineTo(bx + bw, by); ctx.lineTo(bx + bw, by + cornerLen);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bx, by + bh - cornerLen); ctx.lineTo(bx, by + bh); ctx.lineTo(bx + cornerLen, by + bh);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bx + bw - cornerLen, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.lineTo(bx + bw, by + bh - cornerLen);
  ctx.stroke();

  // Thin full bounding box
  ctx.strokeStyle = 'rgba(255, 204, 0, 0.2)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);

  // --- Green jawline trace ---
  if (face.landmarks.jawline && face.landmarks.jawline.length > 2) {
    ctx.strokeStyle = 'rgba(0, 255, 100, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(face.landmarks.jawline[0].x * sx, face.landmarks.jawline[0].y * sy);
    for (let i = 1; i < face.landmarks.jawline.length; i++) {
      ctx.lineTo(face.landmarks.jawline[i].x * sx, face.landmarks.jawline[i].y * sy);
    }
    ctx.stroke();

    // Jawline dots
    ctx.fillStyle = 'rgba(0, 255, 100, 0.6)';
    for (const pt of face.landmarks.jawline) {
      ctx.beginPath();
      ctx.arc(pt.x * sx, pt.y * sy, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // --- Red eye targeting circles + crosshairs ---
  for (const eye of [face.landmarks.leftEyeCenter, face.landmarks.rightEyeCenter]) {
    const ex = eye.x * sx;
    const ey = eye.y * sy;
    const r = Math.max(6, bw * 0.08);

    // Outer targeting circle
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ex, ey, r, 0, Math.PI * 2);
    ctx.stroke();

    // Inner dot
    ctx.fillStyle = 'rgba(255, 60, 60, 0.5)';
    ctx.beginPath();
    ctx.arc(ex, ey, 2, 0, Math.PI * 2);
    ctx.fill();

    // Crosshair lines
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.5)';
    ctx.lineWidth = 1;
    const ext = r * 2.5;
    ctx.beginPath();
    ctx.moveTo(ex - ext, ey); ctx.lineTo(ex - r * 0.5, ey);
    ctx.moveTo(ex + r * 0.5, ey); ctx.lineTo(ex + ext, ey);
    ctx.moveTo(ex, ey - ext); ctx.lineTo(ex, ey - r * 0.5);
    ctx.moveTo(ex, ey + r * 0.5); ctx.lineTo(ex, ey + ext);
    ctx.stroke();
  }

  // --- Nose crosshair (cyan) ---
  const nx = face.landmarks.noseTip.x * sx;
  const ny = face.landmarks.noseTip.y * sy;
  ctx.strokeStyle = 'rgba(0, 200, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(nx - 5, ny); ctx.lineTo(nx + 5, ny);
  ctx.moveTo(nx, ny - 5); ctx.lineTo(nx, ny + 5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0, 200, 255, 0.4)';
  ctx.beginPath();
  ctx.arc(nx, ny, 2, 0, Math.PI * 2);
  ctx.fill();

  // --- Mouth marker (cyan) ---
  const mx = face.landmarks.mouthCenter.x * sx;
  const my = face.landmarks.mouthCenter.y * sy;
  ctx.strokeStyle = 'rgba(0, 200, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx - 8, my); ctx.lineTo(mx + 8, my);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0, 200, 255, 0.3)';
  ctx.beginPath();
  ctx.arc(mx, my, 2, 0, Math.PI * 2);
  ctx.fill();

  // --- Center crosshair (dim) ---
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  ctx.strokeStyle = 'rgba(255, 204, 0, 0.08)';
  ctx.lineWidth = 0.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(bx, cy); ctx.lineTo(bx + bw, cy);
  ctx.moveTo(cx, by); ctx.lineTo(cx, by + bh);
  ctx.stroke();
  ctx.setLineDash([]);

  // --- Scan lines ---
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  for (let y = 0; y < dstH; y += 3) {
    ctx.fillRect(0, y, dstW, 1);
  }

  // --- Labels ---
  const fontSize = Math.max(9, dstW * 0.055);
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.textAlign = 'left';

  // Top label: FACE_0 with yellow
  ctx.fillStyle = 'rgba(255, 204, 0, 0.8)';
  ctx.fillText(`FACE_0`, bx, by - 6);

  // Box dimensions (dimmer)
  ctx.font = `${fontSize * 0.8}px monospace`;
  ctx.fillStyle = 'rgba(255, 204, 0, 0.4)';
  ctx.fillText(`[${b.x},${b.y} ${b.width}x${b.height}]`, bx, by + bh + fontSize + 2);

  // Bottom label: age/gender
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  const label = `${face.gender.toUpperCase()} ~${Math.round(face.age)} ${face.expression.dominant.toUpperCase()}`;
  ctx.fillText(label, bx, by + bh + fontSize * 2 + 4);

  // Confidence (top-right)
  ctx.fillStyle = 'rgba(255, 204, 0, 0.6)';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(face.genderConfidence * 100)}%`, bx + bw, by - 6);
  ctx.textAlign = 'left';
}

// ---- Text Messages ----

// ---- Loop Engine ----

function playAudioSamples(samples) {
  if (!audioCtx || internalMuted) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  playSilboAsync(audioCtx, samples);
}

function startLoop(terminalId) {
  const mx = getMixer(terminalId);
  if (!mx.lastSamples) return;
  mx.looping = true;

  workerInterval('loop_' + terminalId, () => {
    if (!mx.looping) return;
    if (shouldPlay(terminalId)) {
      playAudioSamples(mx.lastSamples);
    }
    if (mx.lastText) {
      midi.sendMelodyMIDI(terminalId, mx.lastText, mx.lastDurationMs, getFreq, PUNCT_PERC);
      broadcastNote(midi.getTerminalChannel(terminalId), mx.lastText, mx.lastText, mx.lastDurationMs, terminalId);
    }
  }, mx.lastDurationMs);

  // Fire immediately
  if (shouldPlay(terminalId)) playAudioSamples(mx.lastSamples);
  if (mx.lastText) {
    midi.sendMelodyMIDI(terminalId, mx.lastText, mx.lastDurationMs, getFreq, PUNCT_PERC);
    broadcastNote(midi.getTerminalChannel(terminalId), mx.lastText, mx.lastDurationMs, terminalId);
  }
}

function stopLoop(terminalId) {
  const mx = getMixer(terminalId);
  mx.looping = false;
  workerClearInterval('loop_' + terminalId);
  const btn = document.querySelector(`.mixer-controls[data-terminal="${terminalId}"] [data-action="loop"]`);
  if (btn) btn.classList.remove('active');
  vizChannel.postMessage({ type: 'stop', channel: midi.getTerminalChannel(terminalId), sourceId: terminalId });
}

// ---- Quantize Engine ----

function scheduleQuantized(callback, audioCtx) {
  if (!globalQuantize || !audioCtx) {
    callback();
    return;
  }
  const beatDuration = 60 / globalBPM;
  const now = audioCtx.currentTime;
  if (!quantizeStartTime) quantizeStartTime = now;
  const elapsed = now - quantizeStartTime;
  const nextBeat = Math.ceil(elapsed / beatDuration) * beatDuration + quantizeStartTime;
  const delay = Math.max(0, (nextBeat - now) * 1000);
  setTimeout(callback, delay);
}

// ---- Text Message Handler ----

function handleTextMessage(msg) {
  const { terminal: sourceId, name: senderName, text } = msg;

  messageCount++;
  elStats.textContent = `${messageCount} messages`;

  // Generate Silbo audio — use voice profile from face analysis if available
  const fa = faceAnalysis[sourceId];
  const voiceProfile = (fa && fa.faces && fa.faces[0])
    ? deriveVoiceProfile(fa.faces[0])
    : getWaveform(sourceId);
  const { samples: silboAudio, durationMs } = synthesizeSilbo(text, voiceProfile);

  // Store for loop playback
  const mx = getMixer(sourceId);
  mx.lastSamples = silboAudio;
  mx.lastDurationMs = durationMs;
  mx.lastText = text;

  // Play audio (respecting mute/solo/quantize)
  if (shouldPlay(sourceId)) {
    scheduleQuantized(() => {
      if (audioCtx && shouldPlay(sourceId)) {
        playAudioSamples(silboAudio);
      }
      // MIDI output: send melody notes to this terminal's channel
      midi.sendMelodyMIDI(sourceId, text, durationMs, getFreq, PUNCT_PERC);
      broadcastNote(midi.getTerminalChannel(sourceId), text, text, durationMs, sourceId);
    }, audioCtx);
  }

  // Create swim lane with clip controls
  const lane = createLane(sourceId, null, { samples: silboAudio, text, durationMs });
  const body = lane.querySelector('.op-lane-body');

  // Waveform
  const waveCanvas = document.createElement('canvas');
  waveCanvas.className = 'op-lane-waveform';
  waveCanvas.width = 600;
  waveCanvas.height = 24;
  drawMiniWaveform(waveCanvas, silboAudio);
  body.appendChild(waveCanvas);

  // Text
  const textDiv = document.createElement('div');
  textDiv.className = 'op-lane-text decoded';
  textDiv.textContent = text;
  body.appendChild(textDiv);

  // Device info
  const info = clientInfo[sourceId];
  if (info) {
    const deviceDiv = document.createElement('div');
    deviceDiv.className = 'op-lane-device';
    const fp = info.fingerprint || {};
    deviceDiv.textContent = [
      fp.ip || info.ip,
      fp.city,
      fp.gpuRenderer ? fp.gpuRenderer.slice(0, 40) : '',
    ].filter(Boolean).join(' | ');
    body.appendChild(deviceDiv);
  }

  // Animate active state on swim lane
  lane.classList.add('active');
  setTimeout(() => lane.classList.remove('active'), durationMs);

  // Green transmitting state on subject card
  const card = document.getElementById(`subject-${sourceId}`);
  if (card) {
    card.classList.add('transmitting');
    setTimeout(() => card.classList.remove('transmitting'), durationMs);
  }

  // Print
  if (printer && printer.connected && text) {
    printSurveillanceReceipt(sourceId, silboAudio, { text, confidence: 1.0 });
  }
}

// ---- Audio (legacy binary relay) ----

function handleAudio(sourceId, audioBytes) {
  const aligned = new ArrayBuffer(audioBytes.byteLength);
  new Uint8Array(aligned).set(audioBytes);
  const samples = new Float32Array(aligned);

  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const buffer = audioCtx.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start();
  }
}

// ---- Shared Lane Creator ----

/**
 * Add a compact event indicator to the swim lanes.
 */
function addEventLane(terminalId, eventType, name) {
  const lane = document.createElement('div');
  lane.className = 'op-lane event';

  const body = document.createElement('div');
  body.className = 'op-lane-body';

  const typeSpan = document.createElement('span');
  typeSpan.className = `event-type ${eventType}`;
  typeSpan.textContent = eventType === 'connect' ? 'CONNECT' : 'DISCONNECT';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'op-lane-id';
  nameSpan.textContent = name;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'op-lane-time';
  timeSpan.textContent = new Date().toTimeString().slice(0, 8);

  body.appendChild(typeSpan);
  body.appendChild(nameSpan);
  body.appendChild(timeSpan);
  lane.appendChild(body);

  elLanes.insertBefore(lane, elLanes.firstChild);

  // Auto-remove after 30 seconds to keep it clean
  setTimeout(() => {
    if (lane.parentNode) lane.style.opacity = '0.3';
  }, 30000);
}

/**
 * Create a swim lane. If samples/text/duration are provided, the lane
 * becomes a triggerable clip with LIVE/CH/LOOP controls.
 */
function createLane(sourceId, type, clipData) {
  const lane = document.createElement('div');
  lane.className = `op-lane${type ? ' ' + type : ''}`;

  // Left column: clip controls (if this is a message lane) or face thumbnail
  if (clipData) {
    const clipId = createClip(sourceId, clipData.samples, clipData.text, clipData.durationMs);
    lane.dataset.clipId = clipId;

    const controls = document.createElement('div');
    controls.className = 'clip-controls';

    const btnLive = document.createElement('button');
    btnLive.className = 'clip-btn clip-live';
    btnLive.textContent = 'LIVE';
    btnLive.title = 'Toggle live (Cmd+click lane to trigger)';

    const chSelect = document.createElement('select');
    chSelect.className = 'clip-ch';
    chSelect.title = 'MIDI channel';
    for (let n = 1; n <= 8; n++) {
      const opt = document.createElement('option');
      opt.value = n - 1;
      opt.textContent = n;
      if (n - 1 === clips[clipId].channel) opt.selected = true;
      chSelect.appendChild(opt);
    }

    const btnLoop = document.createElement('button');
    btnLoop.className = 'clip-btn clip-loop';
    btnLoop.textContent = 'LOOP';

    const densitySelect = document.createElement('select');
    densitySelect.className = 'clip-density';
    densitySelect.title = 'Note density / Euclidean rhythm';
    const densityOpts = [
      ['all',  'ALL'],
      ['1/2',  '1/2'],
      ['1/3',  '1/3'],
      ['1/4',  '1/4'],
      ['e3',   'E3'],
      ['e5',   'E5'],
      ['e7',   'E7'],
      ['e9',   'E9'],
      ['e11',  'E11'],
    ];
    for (const [val, label] of densityOpts) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      densitySelect.appendChild(opt);
    }

    // Wire controls
    btnLive.addEventListener('click', (e) => {
      e.stopPropagation();
      const clip = clips[clipId];
      clip.live = !clip.live;
      btnLive.classList.toggle('active', clip.live);
      lane.classList.toggle('clip-live-on', clip.live);
    });

    chSelect.addEventListener('click', (e) => e.stopPropagation());
    chSelect.addEventListener('change', (e) => {
      const clip = clips[clipId];
      clip.channel = parseInt(e.target.value, 10);
      // Override the terminal channel for this clip's MIDI output
      midi.setTerminalChannel(sourceId + '_clip' + clipId, clip.channel);
    });

    btnLoop.addEventListener('click', (e) => {
      e.stopPropagation();
      const clip = clips[clipId];
      if (clip.looping) {
        stopClipLoop(clipId);
        btnLoop.classList.remove('active');
      } else {
        clip.live = true;
        btnLive.classList.add('active');
        lane.classList.add('clip-live-on');
        startClipLoop(clipId);
        btnLoop.classList.add('active');
      }
    });

    densitySelect.addEventListener('click', (e) => e.stopPropagation());
    densitySelect.addEventListener('change', (e) => {
      const clip = clips[clipId];
      clip.density = e.target.value;
      // Re-synthesize with new density for internal audio
      resynthClip(clipId);
      // If looping, restart the loop with new timing
      if (clip.looping) {
        stopClipLoop(clipId);
        startClipLoop(clipId);
        btnLoop.classList.add('active');
      }
    });

    // Cmd+click on lane = trigger this clip
    lane.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const clip = clips[clipId];
        clip.live = true;
        btnLive.classList.add('active');
        lane.classList.add('clip-live-on');
        triggerClip(clipId);
        // Flash the lane
        lane.classList.add('clip-triggered');
        setTimeout(() => lane.classList.remove('clip-triggered'), 300);
      }
    });

    controls.appendChild(btnLive);
    controls.appendChild(chSelect);
    controls.appendChild(btnLoop);
    controls.appendChild(densitySelect);
    lane.appendChild(controls);
  } else {
    // Non-message lanes (dossier, event): just show face
    const faceCanvas = document.createElement('canvas');
    faceCanvas.className = 'op-lane-face';
    faceCanvas.width = 48;
    faceCanvas.height = 48;
    const faceCtx = faceCanvas.getContext('2d');
    if (latestFaces[sourceId]) {
      faceCtx.drawImage(latestFaces[sourceId], 0, 0, 48, 48);
      const fa2 = faceAnalysis[sourceId];
      if (fa2 && fa2.faces && fa2.faces[0]) {
        drawFaceAnnotations(faceCtx, fa2.faces[0], fa2.imageWidth, fa2.imageHeight, 48, 48);
      }
    } else {
      drawUnknownUser(faceCtx, 48, 48);
    }
    lane.appendChild(faceCanvas);
  }

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

  // Face analysis summary tag
  const fa = faceAnalysis[sourceId];
  if (fa && fa.faces && fa.faces[0]) {
    const f = fa.faces[0];
    const tagSpan = document.createElement('span');
    tagSpan.style.cssText = 'color:#333;font-size:9px;letter-spacing:1px;';
    tagSpan.textContent = `${f.gender.toUpperCase()} ~${Math.round(f.age)} ${f.expression.dominant.toUpperCase()}`;
    header.appendChild(tagSpan);
  }

  body.appendChild(header);
  lane.appendChild(body);

  elLanes.insertBefore(lane, elLanes.firstChild);
  return lane;
}

// ---- Face Snap Storage ----

function handleFaceSnap(fullId, jpegBytes) {
  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  latestFaceBlobs[fullId] = blob;
  createImageBitmap(blob).then(bmp => {
    latestFaces[fullId] = bmp;
    createOrUpdateSubjectCard(fullId);
  });
}

function handleCameraFrame() {
  // Camera grid removed — faces shown in subject cards only
}

// ---- Waveform Drawing ----

function drawMiniWaveform(canvas, samples) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = '#030303';
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
    ctx.moveTo(x, h / 2 - rms * h);
    ctx.lineTo(x, h / 2 + rms * h);
  }
  ctx.stroke();
}

// ---- Thermal Printer ----

async function connectPrinter() {
  printer = new ThermalPrinter();
  try {
    await printer.connect();
    elPrinterStatus.textContent = 'CONNECTED';
    await printer.printStatus('SILBERO DIGITAL // OPERATOR');
  } catch (e) {
    elPrinterStatus.textContent = 'FAILED';
    printer = null;
  }
}

async function printSurveillanceReceipt(sourceId, samples, result) {
  if (!printer || !printer.connected) return;

  const termStr = String(sourceId).padStart(5, '0');
  const timeStr = new Date().toTimeString().slice(0, 8);

  await printer.sendBytes([0x1B, 0x61, 0x01]); // Center
  await printer.sendBytes([0x1B, 0x45, 0x01]); // Bold
  await printer.sendText(`T${termStr} // ${timeStr}`);
  await printer.sendBytes([0x0A]);
  await printer.sendBytes([0x1B, 0x45, 0x00]);

  // Face analysis summary
  const fa = faceAnalysis[sourceId];
  if (fa && fa.faces && fa.faces[0]) {
    const f = fa.faces[0];
    await printer.sendText(`${f.gender.toUpperCase()} ~${Math.round(f.age)} ${f.expression.dominant.toUpperCase()}`);
    await printer.sendBytes([0x0A]);
    await printer.sendText(`${f.eyeColor.color} eyes / ${f.skinTone.label} / ${f.faceShape}`);
    await printer.sendBytes([0x0A]);
  }

  if (latestFaceBlobs[sourceId]) {
    try {
      await printFaceBitmap(sourceId);
    } catch (e) {}
  }

  await printer.sendBytes([0x1B, 0x61, 0x00]);
  await printer.sendBytes([0x1D, 0x21, 0x01]);
  await printer.sendText(result.text);
  await printer.sendBytes([0x0A]);
  await printer.sendBytes([0x1D, 0x21, 0x00]);

  await printer.sendBytes([0x1B, 0x61, 0x01]);
  const confStr = Math.round(result.confidence * 100);
  await printer.sendText(`[${confStr}%]`);
  await printer.sendBytes([0x0A]);

  await printer.sendText('________________________');
  await printer.sendBytes([0x1B, 0x64, 2]);

  try {
    await printer.sendBytes([0x1D, 0x56, 0x01]);
  } catch (_) {}
}

async function printFaceBitmap(sourceId) {
  const blob = latestFaceBlobs[sourceId];
  if (!blob) return;

  const bmp = await createImageBitmap(blob);
  const printWidth = 384;
  const scale = printWidth / bmp.width;
  const printHeight = Math.floor(bmp.height * scale);

  const canvas = new OffscreenCanvas(printWidth, printHeight);
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(100%) contrast(1.5)';
  ctx.drawImage(bmp, 0, 0, printWidth, printHeight);
  bmp.close();

  const imageData = ctx.getImageData(0, 0, printWidth, printHeight);
  const pixels = imageData.data;

  const gray = new Float32Array(printWidth * printHeight);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = pixels[i * 4] / 255;
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

  const bytesPerRow = Math.ceil(printWidth / 8);
  const cmd = [
    0x1D, 0x76, 0x30, 0x00,
    bytesPerRow & 0xFF, (bytesPerRow >> 8) & 0xFF,
    printHeight & 0xFF, (printHeight >> 8) & 0xFF,
  ];
  await printer.sendBytes(cmd);

  for (let y = 0; y < printHeight; y++) {
    const row = new Uint8Array(bytesPerRow);
    for (let x = 0; x < printWidth; x++) {
      if (gray[y * printWidth + x] < 0.5) {
        row[Math.floor(x / 8)] |= (0x80 >> (x % 8));
      }
    }
    await printer.sendBytes(row);
  }
}

// ---- Init ----
init();
