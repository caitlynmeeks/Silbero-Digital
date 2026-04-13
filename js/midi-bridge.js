/**
 * MIDI Bridge — Routes Silbero Digital signals to external DAWs
 *
 * Sends MIDI via the WebMIDI API to a virtual MIDI port (e.g., macOS IAC Driver).
 * Logic Pro / Cubase / Ableton receives these as standard MIDI input.
 *
 * Channel mapping:
 *   1-8:  Terminal whistle melodies (one per active user)
 *   9:    Bass engine
 *   10:   Percussion (SID hits → GM drum map)
 *   11:   Space chord anchor (E major power chord)
 *
 * Microtonal handling:
 *   31-TET notes don't land on piano keys. For each note we send:
 *   1) Note On for the nearest 12-TET MIDI note
 *   2) Pitch Bend to tune it to the exact microtonal frequency
 *   The bend range assumes ±2 semitones (standard). Most instruments respect this.
 *
 * Setup:
 *   macOS: Audio MIDI Setup → IAC Driver → enable, add port
 *   Logic Pro: create tracks receiving MIDI from "IAC Driver"
 */

// ---- State ----
let midiAccess = null;
let midiOutput = null;
let midiEnabled = false;
const terminalChannelMap = {}; // terminalId -> MIDI channel (1-8)
let nextChannel = 0;

// Channel assignments (0-indexed internally, displayed 1-indexed)
const CH_BASS = 8;       // channel 9
const CH_DRUMS = 9;      // channel 10 (GM drums)
const CH_CHORD = 10;     // channel 11
const MAX_MELODY_CHANNELS = 8;

// Pitch bend range in semitones (standard ±2)
const BEND_RANGE = 2;

// ---- Scale Quantizer ----
//
// When pitch bend is disabled, microtonal frequencies snap to the nearest
// note in the selected scale. This turns the 31-TET whistle into
// conventional harmony that Logic Pro instruments play in tune.

const SCALES = {
  chromatic:    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major:        [0, 2, 4, 5, 7, 9, 11],
  minor:        [0, 2, 3, 5, 7, 8, 10],
  dorian:       [0, 2, 3, 5, 7, 9, 10],
  mixolydian:   [0, 2, 4, 5, 7, 9, 10],
  phrygian:     [0, 1, 3, 5, 7, 8, 10],
  lydian:       [0, 2, 4, 6, 7, 9, 11],
  locrian:      [0, 1, 3, 5, 6, 8, 10],
  pentatonic:   [0, 2, 4, 7, 9],
  'pent-minor': [0, 3, 5, 7, 10],
  blues:        [0, 3, 5, 6, 7, 10],
  'harm-minor': [0, 2, 3, 5, 7, 8, 11],
  'whole-tone': [0, 2, 4, 6, 8, 10],
  'hungarian':  [0, 2, 3, 6, 7, 8, 11],
  'arabic':     [0, 1, 4, 5, 7, 8, 11],
};

export const SCALE_NAMES = Object.keys(SCALES);

const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export { ROOT_NAMES };

let globalScale = 'chromatic';
let globalRoot = 4;              // E (semitones from C)
let globalPitchBend = true;      // true = microtonal bends, false = snap to scale
const perTerminalPitchBend = {}; // terminalId -> boolean override (undefined = use global)

export function setScale(scaleName) {
  if (SCALES[scaleName]) globalScale = scaleName;
}

export function setRoot(rootSemitone) {
  globalRoot = rootSemitone % 12;
}

export function setGlobalPitchBend(enabled) {
  globalPitchBend = enabled;
}

export function setTerminalPitchBend(terminalId, enabled) {
  perTerminalPitchBend[terminalId] = enabled;
}

export function getTerminalPitchBend(terminalId) {
  if (perTerminalPitchBend[terminalId] !== undefined) return perTerminalPitchBend[terminalId];
  return globalPitchBend;
}

export function getGlobalPitchBend() {
  return globalPitchBend;
}

export function getScale() { return globalScale; }
export function getRoot() { return globalRoot; }

/**
 * Snap a MIDI note number to the nearest degree in the current scale/root.
 */
function quantizeToScale(midiNote) {
  const intervals = SCALES[globalScale] || SCALES.chromatic;
  // Build all valid MIDI notes in this scale across all octaves
  let bestNote = midiNote;
  let bestDist = 999;
  for (let oct = -1; oct <= 10; oct++) {
    for (const deg of intervals) {
      const candidate = globalRoot + deg + (oct * 12);
      if (candidate < 0 || candidate > 127) continue;
      const dist = Math.abs(midiNote - candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestNote = candidate;
      }
    }
  }
  return bestNote;
}

// GM drum map for SID percussion types
const PERC_TO_GM = {
  'kick':    36,  // Bass Drum 1
  'snare':   38,  // Acoustic Snare
  'hihat':   42,  // Closed Hi-Hat
  'openhat': 46,  // Open Hi-Hat
  'rim':     37,  // Side Stick
  'cowbell': 56,  // Cowbell
  'tom':     45,  // Low Tom
  'clap':    39,  // Hand Clap
  'click':   33,  // Metronome Click
  'zap':     55,  // Splash Cymbal
  'blip':    75,  // Claves
  'buzz':    70,  // Maracas
};

// ---- Init ----

/**
 * Request WebMIDI access and populate available output ports.
 * Returns array of { id, name } for each output.
 */
export async function initMIDI() {
  if (midiAccess) return getOutputs();

  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    console.log('MIDI access granted');
    return getOutputs();
  } catch (e) {
    console.warn('WebMIDI not available:', e.message);
    return [];
  }
}

/**
 * Get list of available MIDI output ports.
 */
export function getOutputs() {
  if (!midiAccess) return [];
  const outputs = [];
  for (const [id, port] of midiAccess.outputs) {
    outputs.push({ id, name: port.name });
  }
  return outputs;
}

/**
 * Connect to a specific MIDI output port by ID.
 */
export function connectOutput(portId) {
  if (!midiAccess) return false;
  midiOutput = midiAccess.outputs.get(portId);
  if (midiOutput) {
    midiEnabled = true;
    console.log(`MIDI output: ${midiOutput.name}`);
    return true;
  }
  return false;
}

/**
 * Disconnect MIDI output. Sends All Notes Off on all channels.
 */
export function disconnect() {
  if (midiOutput && midiEnabled) {
    for (let ch = 0; ch < 16; ch++) {
      allNotesOff(ch);
    }
  }
  midiEnabled = false;
  midiOutput = null;
}

export function isEnabled() {
  return midiEnabled && midiOutput !== null;
}

// ---- Channel Management ----

/**
 * Get or assign a MIDI melody channel (0-7) for a terminal.
 * Channels are assigned round-robin by default.
 */
export function getTerminalChannel(terminalId) {
  if (terminalChannelMap[terminalId] !== undefined) {
    return terminalChannelMap[terminalId];
  }
  const ch = nextChannel % MAX_MELODY_CHANNELS;
  terminalChannelMap[terminalId] = ch;
  nextChannel++;
  return ch;
}

/**
 * Manually assign a MIDI channel (0-7) to a terminal.
 */
export function setTerminalChannel(terminalId, channel) {
  terminalChannelMap[terminalId] = channel;
}

// ---- Low-level MIDI ----

function send(bytes) {
  if (!midiEnabled || !midiOutput) return;
  midiOutput.send(bytes);
}

function sendAt(bytes, time) {
  if (!midiEnabled || !midiOutput) return;
  midiOutput.send(bytes, time);
}

function noteOn(channel, note, velocity) {
  send([0x90 | (channel & 0xF), note & 0x7F, velocity & 0x7F]);
}

function noteOff(channel, note) {
  send([0x80 | (channel & 0xF), note & 0x7F, 0]);
}

function pitchBend(channel, value) {
  // value: -8192 to +8191, center = 0
  const bent = Math.max(0, Math.min(16383, value + 8192));
  const lsb = bent & 0x7F;
  const msb = (bent >> 7) & 0x7F;
  send([0xE0 | (channel & 0xF), lsb, msb]);
}

function controlChange(channel, cc, value) {
  send([0xB0 | (channel & 0xF), cc & 0x7F, value & 0x7F]);
}

function allNotesOff(channel) {
  controlChange(channel, 123, 0);  // All Notes Off
  controlChange(channel, 121, 0);  // Reset All Controllers
  pitchBend(channel, 0);           // Reset pitch bend
}

// ---- MIDI Clock ----

let clockTimer = null;

/**
 * Start sending MIDI clock at the given BPM.
 * MIDI clock = 24 pulses per quarter note.
 */
export function startClock(bpm) {
  stopClock();
  const pulsesPerBeat = 24;
  const msPerPulse = 60000 / bpm / pulsesPerBeat;

  send([0xFA]); // MIDI Start
  clockTimer = setInterval(() => {
    send([0xF8]); // MIDI Clock pulse
  }, msPerPulse);
}

export function stopClock() {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
    send([0xFC]); // MIDI Stop
  }
}

/**
 * Update clock tempo (restart with new BPM).
 */
export function updateClockBPM(bpm) {
  if (clockTimer) {
    startClock(bpm);
  }
}

// ---- High-level MIDI Note Functions ----

/**
 * Convert a frequency to the nearest MIDI note + pitch bend offset.
 * Returns { note: 0-127, bend: -8192 to +8191 }
 */
function freqToMidiBend(freq) {
  // MIDI note = 69 + 12 * log2(freq / 440)
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const note = Math.round(midiFloat);
  const centsOff = (midiFloat - note) * 100; // cents deviation

  // Pitch bend: ±BEND_RANGE semitones = ±8192
  // centsOff is in range roughly -50 to +50
  const bend = Math.round((centsOff / (BEND_RANGE * 100)) * 8192);

  return { note: Math.max(0, Math.min(127, note)), bend };
}

/**
 * Send a microtonal note on a channel with proper pitch bend.
 * Automatically schedules Note Off after durationMs.
 *
 * @param {number} channel - MIDI channel (0-15)
 * @param {number} freq - Frequency in Hz (will be microtonally bent)
 * @param {number} velocity - 0-127
 * @param {number} durationMs - Note length in milliseconds
 */
export function sendMicrotonalNote(channel, freq, velocity, durationMs, terminalId) {
  if (!midiEnabled) return;

  const { note, bend } = freqToMidiBend(freq);
  const useBend = terminalId !== undefined ? getTerminalPitchBend(terminalId) : globalPitchBend;

  let outNote;
  if (useBend) {
    // Microtonal: pitch bend to exact frequency
    pitchBend(channel, bend);
    outNote = note;
  } else {
    // Scale-quantized: snap to nearest scale degree, no bend
    outNote = quantizeToScale(note);
    pitchBend(channel, 0);
  }

  noteOn(channel, outNote, velocity);
  setTimeout(() => noteOff(channel, outNote), durationMs);
}

/**
 * Send a whistle melody for a terminal's text message.
 * Parses the text character by character and sends a sequence of
 * microtonal MIDI notes on the terminal's assigned channel.
 *
 * @param {number} terminalId - Terminal sending the message
 * @param {string} text - Message text
 * @param {number} durationMs - Total message duration from synthesizeSilbo
 * @param {Function} getCharFreq - Function to get frequency for a character
 * @param {Object} punctPercMap - Map of punctuation -> SID percussion type
 */
export function sendMelodyMIDI(terminalId, text, durationMs, getCharFreq, punctPercMap) {
  if (!midiEnabled) return;

  const ch = getTerminalChannel(terminalId);
  const msPerChar = durationMs / Math.max(1, text.length);

  let offset = 0;
  for (const char of text) {
    const delay = offset;

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      // Whitespace: silent rest, no MIDI output
    } else if (punctPercMap && punctPercMap[char]) {
      // Percussion on channel 10
      const percType = punctPercMap[char];
      const gmNote = PERC_TO_GM[percType] || 37;
      setTimeout(() => {
        noteOn(CH_DRUMS, gmNote, 100);
        setTimeout(() => noteOff(CH_DRUMS, gmNote), 50);
      }, delay);
    } else {
      // Tonal character — send microtonal note on terminal's channel
      const freq = getCharFreq(char);
      if (freq !== null) {
        const vel = char >= 'A' && char <= 'Z' ? 110 : 85;
        setTimeout(() => {
          sendMicrotonalNote(ch, freq, vel, msPerChar * 0.9, terminalId);
        }, delay);
      }
    }

    offset += msPerChar;
  }
}

/**
 * Send a bass note on the bass channel.
 * Called from the bass engine scheduler.
 *
 * @param {number} midiNote - Standard MIDI note number
 * @param {number} durationMs - Note length
 * @param {number} velocity - 0-127
 */
export function sendBassNoteMIDI(midiNote, durationMs, velocity) {
  if (!midiEnabled) return;

  pitchBend(CH_BASS, 0); // Bass is 12-TET, no bend needed
  noteOn(CH_BASS, midiNote, velocity || 100);
  setTimeout(() => {
    noteOff(CH_BASS, midiNote);
  }, durationMs);
}

/**
 * Send a drum hit on channel 10.
 *
 * @param {string} percType - SID percussion type name
 * @param {number} velocity - 0-127
 */
export function sendDrumHitMIDI(percType, velocity) {
  if (!midiEnabled) return;

  const gmNote = PERC_TO_GM[percType] || 37;
  noteOn(CH_DRUMS, gmNote, velocity || 100);
  setTimeout(() => noteOff(CH_DRUMS, gmNote), 50);
}
