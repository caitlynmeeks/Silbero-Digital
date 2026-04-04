/**
 * Chirp Encoder — Silbo Gomero-style whistle synthesis
 *
 * Each character is encoded as a continuous pitch glide (chirp) within a
 * carrier band. The output sounds like a human whistling — portamento
 * between pitch targets, vibrato on sustained notes, breath noise, and
 * natural amplitude envelopes.
 *
 * For FHSS robustness, the same message is encoded simultaneously on
 * multiple carrier frequencies. The cistern's reverb is handled by the
 * decoder's matched filtering, not here — we just make it sound beautiful.
 */

const SAMPLE_RATE = 48000;

// Silbo pitch mapping: 27 symbols (a-z + space) mapped to pitch offsets
// within a ±180 Hz range around the carrier.
//
// 27 symbols in 360 Hz = ~13.3 Hz per symbol — well above FFT resolution
// (~3 Hz with parabolic interpolation on 4096-point FFT at 48kHz).
//
// Layout inspired by real Silbo Gomero: vowels get the most distinctive
// positions (widest spacing), consonants fill the gaps. Space is encoded
// as a brief silence (amplitude dip) rather than a frequency target.
const CHAR_MAP = buildCharMap();

function buildCharMap() {
  const map = {};

  // 26 letters spread evenly across ±168 Hz (leaving margin at edges)
  // Sorted so vowels land at memorable positions:
  //   a=-168, e=-55, i=55, o=110, u=168 (approximate, after spreading)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const step = 336 / (alphabet.length - 1); // ~13.4 Hz per symbol

  for (let i = 0; i < alphabet.length; i++) {
    map[alphabet[i]] = Math.round(-168 + step * i);
  }

  // Space = marker tone above the letter range, always detectable
  map[' '] = 190;

  return map;
}

/**
 * Sanitize input text: lowercase, strip unsupported characters.
 * For the installation, people type short plain messages.
 */
export function sanitizeText(text) {
  return text.toLowerCase().replace(/[^a-z ]/g, '');
}

/**
 * Get the pitch offset for a character.
 */
function pitchForChar(ch) {
  const lower = ch.toLowerCase();
  if (lower in CHAR_MAP) return CHAR_MAP[lower];
  return 0; // Unknown chars map to carrier center
}

/**
 * Smoothstep interpolation — cubic ease in/out.
 */
function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Generate a Silbo-style chirp waveform for a single character transition.
 *
 * @param {number} fromFreq - Starting frequency in Hz
 * @param {number} toFreq - Target frequency in Hz
 * @param {number} phase - Current oscillator phase (radians)
 * @param {boolean} isSpace - If true, generate a breath pause instead
 * @param {object} opts - Synthesis parameters
 * @returns {{ samples: Float32Array, phase: number }}
 */
function synthesizeChirp(fromFreq, toFreq, phase, isSpace, opts = {}) {
  const {
    glideMs = 120,       // Glide duration between pitch targets
    sustainMs = 280,     // Hold duration — long enough for 8192-pt FFT to sit inside
    vibratoRate = 6,     // Vibrato LFO rate in Hz
    vibratoDepth = 0,    // DISABLED for decode accuracy — re-enable once decode works
    breathLevel = 0.03,  // Breath noise amplitude
    amplitude = 0.55,    // Peak amplitude
  } = opts;

  if (isSpace) {
    // Space = full-amplitude steady tone at the marker frequency (+190 Hz).
    // Same duration and amplitude as regular letters — no special envelope.
    // The decoder recognizes any peak above +178 Hz offset as a space.
    const markerFreq = toFreq; // carrierHz + 190, set by caller
    const totalSamples = Math.floor(((glideMs + sustainMs) / 1000) * SAMPLE_RATE);
    const samples = new Float32Array(totalSamples);
    let currentPhase = phase;
    for (let i = 0; i < totalSamples; i++) {
      currentPhase += (2 * Math.PI * markerFreq) / SAMPLE_RATE;
      samples[i] = amplitude * Math.sin(currentPhase);
    }
    return { samples, phase: currentPhase };
  }

  const glideSamples = Math.floor((glideMs / 1000) * SAMPLE_RATE);
  const sustainSamples = Math.floor((sustainMs / 1000) * SAMPLE_RATE);
  const totalSamples = glideSamples + sustainSamples;
  const samples = new Float32Array(totalSamples);

  let currentPhase = phase;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    let freq, amp, vibWeight;

    if (i < glideSamples) {
      // Glide phase — smoothstep from fromFreq to toFreq
      const tNorm = i / glideSamples;
      const tSmooth = smoothstep(tNorm);
      freq = fromFreq + (toFreq - fromFreq) * tSmooth;
      vibWeight = tSmooth * 0.3; // Minimal vibrato during glide
      // Soft attack envelope
      amp = amplitude * (0.2 + 0.8 * smoothstep(Math.min(tNorm * 3, 1)));
    } else {
      // Sustain phase — hold on target with full vibrato
      const sustainT = (i - glideSamples) / sustainSamples;
      freq = toFreq;
      vibWeight = 1.0;
      // Gentle decay at end of sustain
      amp = amplitude * (1.0 - 0.15 * sustainT);
    }

    // Apply vibrato
    const vibrato = vibratoDepth * Math.sin(2 * Math.PI * vibratoRate * t) * vibWeight;
    const instantFreq = freq + vibrato;

    // Phase accumulation (continuous phase FM synthesis)
    currentPhase += (2 * Math.PI * instantFreq) / SAMPLE_RATE;

    // Main whistle tone
    const whistle = amp * Math.sin(currentPhase);

    // Breath noise — bandpass-ish by modulating with the whistle envelope
    const breath = (Math.random() * 2 - 1) * breathLevel * amp;

    samples[i] = whistle + breath;
  }

  return { samples: samples, phase: currentPhase };
}

/**
 * Encode a text message as a Silbo-style whistle on a given carrier frequency.
 *
 * @param {string} text - Message to encode
 * @param {number} carrierHz - Center frequency of the carrier band
 * @param {object} opts - Synthesis options
 * @returns {Float32Array} - Audio samples at SAMPLE_RATE
 */
export function encodeMessage(text, carrierHz = 4500, opts = {}) {
  const chars = text.split('');
  const allSamples = [];
  let phase = 0;
  let prevFreq = carrierHz; // Start at carrier center

  for (const ch of chars) {
    const isSpace = ch === ' ';
    const targetOffset = pitchForChar(ch);
    const targetFreq = carrierHz + targetOffset;

    const result = synthesizeChirp(prevFreq, targetFreq, phase, isSpace, opts);
    allSamples.push(result.samples);
    phase = result.phase;
    prevFreq = isSpace ? carrierHz : targetFreq;
  }

  // Concatenate all chirp segments
  const totalLength = allSamples.reduce((sum, s) => sum + s.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const segment of allSamples) {
    output.set(segment, offset);
    offset += segment.length;
  }

  return output;
}

/**
 * Encode message on multiple FHSS carriers simultaneously.
 * Returns a mixed-down mono signal with the same message on all carriers.
 *
 * @param {string} text - Message to encode
 * @param {number[]} carriers - Array of carrier frequencies
 * @param {object} opts - Synthesis options
 * @returns {Float32Array}
 */
export function encodeMessageFHSS(text, carriers, opts = {}) {
  const streams = carriers.map(c => encodeMessage(text, c, opts));
  const maxLen = Math.max(...streams.map(s => s.length));
  const mixed = new Float32Array(maxLen);

  for (const stream of streams) {
    for (let i = 0; i < stream.length; i++) {
      mixed[i] += stream[i];
    }
  }

  // Normalize to prevent clipping
  const scale = 1.0 / carriers.length;
  for (let i = 0; i < maxLen; i++) {
    mixed[i] *= scale;
  }

  return mixed;
}

/**
 * Generate a preamble — short ascending chirp sweep so receivers can detect
 * the start of a transmission and sync their decoders.
 *
 * @param {number} carrierHz - Carrier frequency
 * @param {number} durationMs - Preamble duration
 * @returns {Float32Array}
 */
export function generatePreamble(carrierHz, durationMs = 200) {
  const samples = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const output = new Float32Array(samples);
  let phase = 0;
  const startFreq = carrierHz - 180;
  const endFreq = carrierHz + 180;

  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    const freq = startFreq + (endFreq - startFreq) * t;
    // Amplitude envelope: fade in and out
    const env = Math.sin(Math.PI * t) * 0.5;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    output[i] = env * Math.sin(phase);
  }

  return output;
}

/**
 * Get the chirp signature for a character at a given carrier — used by the
 * decoder for matched filtering.
 *
 * @param {string} ch - Character
 * @param {number} carrierHz - Carrier frequency
 * @param {number} prevFreq - Previous frequency (for glide start)
 * @returns {Float32Array}
 */
export function getChirpTemplate(ch, carrierHz, prevFreq) {
  const isSpace = ch === ' ';
  const targetFreq = carrierHz + pitchForChar(ch);
  // Generate a clean template without breath noise for correlation
  const result = synthesizeChirp(prevFreq, targetFreq, 0, isSpace, {
    breathLevel: 0,
    amplitude: 1.0,
  });
  return result.samples;
}

export { SAMPLE_RATE, CHAR_MAP, pitchForChar };
