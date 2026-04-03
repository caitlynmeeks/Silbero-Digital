/**
 * Modem — Full FSK encoder/decoder for art installation
 *
 * Each terminal gets its own mark/space frequency pair, spaced across
 * 1.1–3.0 kHz. 300 baud for the classic modem warble and noise robustness.
 *
 * Protocol per message:
 *   1. Carrier tone (mark freq, 500ms) — announces presence
 *   2. Sync byte (0xAA) — alternating bits for receiver clock sync
 *   3. Length byte — message length
 *   4. ASCII payload — the typed message
 *   5. Checksum byte — XOR of all payload bytes
 *   6. Carrier off
 *
 * Decoding uses the Goertzel algorithm (efficient single-frequency
 * energy detection) to distinguish mark from space in each bit period.
 */

const SAMPLE_RATE = 48000;
const BAUD_RATE = 60;
const SAMPLES_PER_BIT = Math.floor(SAMPLE_RATE / BAUD_RATE);

// Frequency plan: 5 terminals, each with mark/space pair
// 300 Hz FSK shift. Both tones are modulated by a shared wandering curve
// so the output sounds musical rather than two-tone.
const FREQ_PLAN = {
  1: { mark: 900,  space: 1200 },
  2: { mark: 1500, space: 1800 },
  3: { mark: 2100, space: 2400 },
  4: { mark: 2700, space: 3000 },
  5: { mark: 3300, space: 3600 },
};

/**
 * Shared pitch modulation curve — a sum of slow incommensurate sines.
 * Creates an organic, non-repeating wandering pattern.
 * Both encoder and decoder evaluate this identically.
 *
 * TUNING GUIDE:
 *   - Amplitude: how far the pitch wanders (Hz). Safe up to ~250 Hz
 *     before tones from adjacent terminals could overlap.
 *   - Rate: how fast it wanders (Hz). Keep below ~2 Hz or the drift
 *     within one bit period gets too large for the Goertzel.
 *   - More components = more complex/organic movement.
 *   - Irrational rate ratios = never repeats.
 */

// Portamento: 0 = hard switch, 0.15 = subtle glide, 0.4 = syrupy, 0.8 = almost legato
const PORTAMENTO = 0.0;

// Waveform: 'sine' = pure tone, 'saw' = buzzy/nasal, 'square' = hollow/reedy,
//           'triangle' = soft/mellow
const WAVEFORM = 'triangle';

// ---- TWEAK THESE ----
const MOD_COMPONENTS = [
  { amp: 200, rate: 0.11 },   // massive glacial swell
  // { amp: 140, rate: 0.29 },   // deep rolling drift
  // { amp: 80,  rate: 0.53 },   // mid wobble
   { amp: 50,  rate: 0.87 },   // warble
  // { amp: 30,  rate: 0.43 },   // fast shimmer
   { amp: 15,  rate: 0.91 },   // nervous flutter
];
// Peak deviation: ±515 Hz — the tones roam a full octave

function pitchModulation(t) {
  let offset = 0;
  for (const c of MOD_COMPONENTS) {
    offset += c.amp * Math.sin(2 * Math.PI * c.rate * t);
  }
  return offset;
}

/**
 * Oscillator waveform. Phase is in radians.
 */
function oscillator(phase) {
  switch (WAVEFORM) {
    case 'square':
      return Math.sin(phase) >= 0 ? 1 : -1;
    case 'saw': {
      const p = (phase % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      return (p / Math.PI) - 1;
    }
    case 'triangle': {
      const p = (phase % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      return p < Math.PI ? (2 * p / Math.PI) - 1 : 3 - (2 * p / Math.PI);
    }
    default: // sine
      return Math.sin(phase);
  }
}

/**
 * Get frequencies for a terminal.
 */
export function getFreqs(terminalId) {
  return FREQ_PLAN[terminalId] || FREQ_PLAN[1];
}

// ---- ENCODER ----

/**
 * Generate a tone at a given frequency for a given number of samples.
 * Maintains phase continuity via the phase parameter.
 */
function generateTone(freq, numSamples, phase, amplitude = 0.45) {
  const samples = new Float32Array(numSamples);
  let p = phase;
  for (let i = 0; i < numSamples; i++) {
    samples[i] = amplitude * oscillator(p);
    p += (2 * Math.PI * freq) / SAMPLE_RATE;
  }
  return { samples, phase: p };
}

/**
 * Encode a single byte as 8N1 FSK with pitch modulation and portamento.
 *
 * @param {number} byte - The byte to encode
 * @param {number} markFreq - Base mark frequency
 * @param {number} spaceFreq - Base space frequency
 * @param {number} phase - Current oscillator phase
 * @param {number} prevFreq - Previous base frequency (for portamento)
 * @param {number} timeOffset - Time offset in seconds (for modulation curve sync)
 */
function encodeByte(byte, markFreq, spaceFreq, phase, prevFreq, timeOffset) {
  const bits = [];
  bits.push(0); // start bit (space)
  for (let i = 0; i < 8; i++) bits.push((byte >> i) & 1); // data LSB first
  bits.push(1); // stop bit (mark)

  const portamentoSamples = Math.floor(SAMPLES_PER_BIT * PORTAMENTO);

  const totalSamples = bits.length * SAMPLES_PER_BIT;
  const samples = new Float32Array(totalSamples);
  let currentPhase = phase;
  let lastBaseFreq = prevFreq || markFreq;

  for (let b = 0; b < bits.length; b++) {
    const targetBaseFreq = bits[b] === 1 ? markFreq : spaceFreq;
    const offset = b * SAMPLES_PER_BIT;

    for (let i = 0; i < SAMPLES_PER_BIT; i++) {
      // Time for modulation curve (disabled when timeOffset < 0)
      const t = timeOffset + (offset + i) / SAMPLE_RATE;
      const mod = timeOffset >= 0 ? pitchModulation(t) : 0;

      // Base frequency with portamento
      let baseFreq;
      if (i < portamentoSamples && lastBaseFreq !== targetBaseFreq) {
        const s = i / portamentoSamples;
        baseFreq = lastBaseFreq + (targetBaseFreq - lastBaseFreq) * s * s * (3 - 2 * s);
      } else {
        baseFreq = targetBaseFreq;
      }

      // Apply shared modulation curve
      const freq = baseFreq + mod;

      currentPhase += (2 * Math.PI * freq) / SAMPLE_RATE;
      samples[offset + i] = 0.45 * oscillator(currentPhase);
    }

    lastBaseFreq = targetBaseFreq;
  }

  const newTimeOffset = timeOffset + totalSamples / SAMPLE_RATE;
  return { samples, phase: currentPhase, lastFreq: lastBaseFreq, timeOffset: newTimeOffset };
}

/**
 * Generate the classic modem handshake/negotiation sound.
 *
 * Sequence:
 *   - Answer tone (2100 Hz) — 400ms
 *   - Silence — 100ms
 *   - Originate mark tone — 300ms
 *   - Scrambled training — 200ms of alternating mark/space at high speed
 *
 * This is the sound people love.
 */
export function generateHandshake(terminalId) {
  const freqs = getFreqs(terminalId);
  const segments = [];
  let phase = 0;

  // Answer tone (2100 Hz — the ITU V.25 calling tone)
  let result = generateTone(2100, Math.floor(0.4 * SAMPLE_RATE), phase, 0.4);
  segments.push(result.samples);
  phase = result.phase;

  // Silence
  segments.push(new Float32Array(Math.floor(0.1 * SAMPLE_RATE)));

  // Originate carrier (mark tone)
  result = generateTone(freqs.mark, Math.floor(0.3 * SAMPLE_RATE), phase, 0.4);
  segments.push(result.samples);
  phase = result.phase;

  // Scrambled training — rapidly alternating mark/space (sounds like the modem "negotiating")
  const trainingSamples = Math.floor(0.3 * SAMPLE_RATE);
  const trainingBuf = new Float32Array(trainingSamples);
  const fastBaud = 1200; // Faster for the training burst
  const fastSamplesPerBit = Math.floor(SAMPLE_RATE / fastBaud);
  for (let i = 0; i < trainingSamples; i++) {
    const bitIdx = Math.floor(i / fastSamplesPerBit);
    // Pseudo-random pattern for that classic scrambled sound
    const bit = ((bitIdx * 7 + 3) % 11) > 5 ? 1 : 0;
    const freq = bit ? freqs.mark : freqs.space;
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    trainingBuf[i] = 0.4 * oscillator(phase);
  }
  segments.push(trainingBuf);

  // Brief silence before data
  segments.push(new Float32Array(Math.floor(0.05 * SAMPLE_RATE)));

  return concatFloat32Arrays(segments);
}

/**
 * Encode a text message as FSK modem audio.
 *
 * @param {string} text - Message to send
 * @param {number} terminalId - Which terminal (determines frequencies)
 * @returns {Float32Array} - Complete audio including handshake
 */
export function encodeMessage(text, terminalId) {
  const freqs = getFreqs(terminalId);
  const segments = [];

  // Handshake preamble
  segments.push(generateHandshake(terminalId));

  // Carrier and sync byte are UNMODULATED so the decoder can find them.
  // Modulation starts with the data bytes.
  let phase = 0;
  let lastFreq = freqs.mark;
  let timeOffset = 0; // Modulation clock starts at 0 when data begins

  // Carrier (mark tone for 200ms — unmodulated)
  let result = generateTone(freqs.mark, Math.floor(0.2 * SAMPLE_RATE), phase);
  segments.push(result.samples);
  phase = result.phase;

  // Sync byte (0xAA — unmodulated, timeBase=-1 disables modulation)
  result = encodeByte(0xAA, freqs.mark, freqs.space, phase, lastFreq, -1);
  segments.push(result.samples);
  phase = result.phase;
  lastFreq = result.lastFreq;

  // Source terminal ID byte
  result = encodeByte(terminalId, freqs.mark, freqs.space, phase, lastFreq, timeOffset);
  segments.push(result.samples);
  phase = result.phase;
  lastFreq = result.lastFreq;
  timeOffset = result.timeOffset;

  // Length byte
  const msgBytes = Array.from(text).map(c => c.charCodeAt(0) & 0x7F);
  result = encodeByte(msgBytes.length, freqs.mark, freqs.space, phase, lastFreq, timeOffset);
  segments.push(result.samples);
  phase = result.phase;
  lastFreq = result.lastFreq;
  timeOffset = result.timeOffset;

  // Payload
  let checksum = 0;
  for (const byte of msgBytes) {
    result = encodeByte(byte, freqs.mark, freqs.space, phase, lastFreq, timeOffset);
    segments.push(result.samples);
    phase = result.phase;
    lastFreq = result.lastFreq;
    timeOffset = result.timeOffset;
    checksum ^= byte;
  }

  // Checksum
  result = encodeByte(checksum, freqs.mark, freqs.space, phase, lastFreq, timeOffset);
  segments.push(result.samples);
  phase = result.phase;

  // Trailing carrier (mark, 100ms)
  result = generateTone(freqs.mark, Math.floor(0.1 * SAMPLE_RATE), phase);
  segments.push(result.samples);

  return concatFloat32Arrays(segments);
}

// ---- DECODER ----

/**
 * Goertzel algorithm — efficiently computes the energy at a single
 * frequency in a signal block. Much faster than FFT when you only
 * need one or two frequencies.
 *
 * @param {Float32Array} samples - Audio block
 * @param {number} targetFreq - Frequency to detect (Hz)
 * @param {number} sampleRate - Sample rate
 * @returns {number} - Magnitude squared at the target frequency
 */
function goertzel(samples, targetFreq, sampleRate) {
  const N = samples.length;
  const k = Math.round((targetFreq * N) / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);

  let s0 = 0, s1 = 0, s2 = 0;

  for (let i = 0; i < N; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  // Magnitude squared
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Detect whether a bit period contains mark or space.
 * Applies the shared pitch modulation curve to shift Goertzel targets.
 *
 * @param {Float32Array} bitSamples - One bit period of audio
 * @param {number} markFreq - Base mark frequency
 * @param {number} spaceFreq - Base space frequency
 * @param {number} bitCenterTime - Time at center of this bit (for modulation)
 * @returns {{ bit: number, confidence: number }}
 */
function detectBit(bitSamples, markFreq, spaceFreq, bitCenterTime) {
  // Shift detection frequencies by the same modulation curve
  const mod = bitCenterTime >= 0 ? pitchModulation(bitCenterTime) : 0;
  const markTarget = markFreq + mod;
  const spaceTarget = spaceFreq + mod;

  const markEnergy = goertzel(bitSamples, markTarget, SAMPLE_RATE);
  const spaceEnergy = goertzel(bitSamples, spaceTarget, SAMPLE_RATE);

  const total = markEnergy + spaceEnergy;
  if (total < 0.001) return { bit: -1, confidence: 0 };

  const bit = markEnergy > spaceEnergy ? 1 : 0;
  const confidence = Math.abs(markEnergy - spaceEnergy) / total;

  return { bit, confidence };
}

/**
 * Decode a byte from audio starting at the given sample offset.
 * Expects 8N1 framing: start bit (space), 8 data (LSB first), stop bit (mark).
 *
 * @param {number} timeBase - Time in seconds corresponding to sample offset 0 of audio
 *                            (for modulation curve sync). Use -1 to disable modulation.
 */
function decodeByte(audio, offset, markFreq, spaceFreq, timeBase) {
  const bitsNeeded = 10;
  if (offset + bitsNeeded * SAMPLES_PER_BIT > audio.length) return null;

  function bitTime(bitIndex) {
    if (timeBase < 0) return -1;
    // timeBase tracks modulation time; only add the bit position within this byte,
    // NOT the absolute audio offset (that's just where to read samples from)
    return timeBase + (bitIndex + 0.5) * SAMPLES_PER_BIT / SAMPLE_RATE;
  }

  // Check start bit (should be space = 0)
  const startSamples = audio.subarray(offset, offset + SAMPLES_PER_BIT);
  const startBit = detectBit(startSamples, markFreq, spaceFreq, bitTime(0));
  if (startBit.bit !== 0) return null;

  // Read 8 data bits
  let byte = 0;
  let totalConf = startBit.confidence;

  for (let i = 0; i < 8; i++) {
    const bitOffset = offset + (1 + i) * SAMPLES_PER_BIT;
    const bitSamples = audio.subarray(bitOffset, bitOffset + SAMPLES_PER_BIT);
    const result = detectBit(bitSamples, markFreq, spaceFreq, bitTime(1 + i));
    if (result.bit === 1) byte |= (1 << i);
    totalConf += result.confidence;
  }

  // Check stop bit (should be mark = 1)
  const stopOffset = offset + 9 * SAMPLES_PER_BIT;
  const stopSamples = audio.subarray(stopOffset, stopOffset + SAMPLES_PER_BIT);
  const stopBit = detectBit(stopSamples, markFreq, spaceFreq, bitTime(9));
  totalConf += stopBit.confidence;

  return {
    byte,
    confidence: totalConf / 10,
    samplesConsumed: bitsNeeded * SAMPLES_PER_BIT,
  };
}

/**
 * Find the start of a transmission by looking for the sync byte (0xAA).
 * Scans through the audio looking for the alternating mark/space pattern.
 *
 * Since we don't know the modulation time alignment yet, we search with
 * modulation disabled (timeBase=-1). The 0xAA pattern alternates rapidly
 * between mark and space, so even with modulation shifting both tones,
 * the mark-vs-space comparison still works — modulation shifts both equally.
 *
 * Returns the sample offset AND the estimated time base for modulation sync.
 */
function findSync(audio, markFreq, spaceFreq) {
  const step = Math.floor(SAMPLES_PER_BIT / 4);
  const maxSearch = audio.length - 12 * SAMPLES_PER_BIT;

  let bestConf = 0;
  let bestByte = -1;
  for (let offset = 0; offset < maxSearch; offset += step) {
    const result = decodeByte(audio, offset, markFreq, spaceFreq, -1);
    if (result && result.confidence > bestConf) {
      bestConf = result.confidence;
      bestByte = result.byte;
    }
    if (result && result.byte === 0xAA && result.confidence > 0.3) {
      console.log(`findSync: found 0xAA at offset=${offset} conf=${result.confidence.toFixed(3)}`);
      const dataOffset = offset + result.samplesConsumed;
      return { offset: dataOffset, timeBase: 0 };
    }
  }
  console.log(`findSync: FAILED. best byte=0x${bestByte.toString(16)} conf=${bestConf.toFixed(3)} searched ${maxSearch} samples`);

  return null;
}

/**
 * Detect if there's modem carrier energy in the audio for a given terminal.
 *
 * @param {Float32Array} audio - Raw mic audio
 * @param {number} terminalId - Which terminal to check
 * @returns {boolean}
 */
export function detectCarrier(audio, terminalId) {
  const freqs = getFreqs(terminalId);

  // Check for mark or space energy in the first second
  const checkLength = Math.min(audio.length, SAMPLE_RATE);
  const blockSize = SAMPLES_PER_BIT * 4;

  for (let offset = 0; offset + blockSize <= checkLength; offset += blockSize) {
    const block = audio.subarray(offset, offset + blockSize);
    const markE = goertzel(block, freqs.mark, SAMPLE_RATE);
    const spaceE = goertzel(block, freqs.space, SAMPLE_RATE);

    // Check if either tone is significantly present
    if (markE > 1.0 || spaceE > 1.0) return true;
  }

  return false;
}

/**
 * Full decode pipeline — find sync, read header, decode payload.
 * Uses the shared modulation curve for frequency tracking.
 */
export function decodeMessage(audio, terminalId) {
  const freqs = getFreqs(terminalId);

  // Find sync byte (returns offset and timeBase for modulation sync)
  const sync = findSync(audio, freqs.mark, freqs.space);
  if (!sync) return null;

  let offset = sync.offset;
  let timeBase = sync.timeBase;

  // Helper: decode a byte and advance offset/timeBase
  function readByte() {
    const result = decodeByte(audio, offset, freqs.mark, freqs.space, timeBase);
    if (result) {
      offset += result.samplesConsumed;
      timeBase += result.samplesConsumed / SAMPLE_RATE;
    }
    return result;
  }

  // Read source terminal ID
  const sourceResult = readByte();
  if (!sourceResult) return null;
  const source = sourceResult.byte;

  // Read length
  const lenResult = readByte();
  if (!lenResult || lenResult.byte === 0 || lenResult.byte > 160) return null;
  const msgLen = lenResult.byte;

  // Read payload
  const chars = [];
  let checksum = 0;
  let totalConf = sourceResult.confidence + lenResult.confidence;

  for (let i = 0; i < msgLen; i++) {
    const charResult = readByte();
    if (!charResult) break;
    chars.push(String.fromCharCode(charResult.byte));
    checksum ^= charResult.byte;
    totalConf += charResult.confidence;
  }

  // Read and verify checksum
  const checksumResult = readByte();
  let checksumValid = false;
  if (checksumResult) {
    checksumValid = checksumResult.byte === checksum;
    totalConf += checksumResult.confidence;
  }

  const text = chars.join('');
  const avgConf = totalConf / (2 + chars.length + 1);
  const confidence = checksumValid ? avgConf : avgConf * 0.5;

  if (text.length === 0) return null;

  return { text, source, confidence };
}

// ---- LOOPBACK TEST ----

/**
 * Encode and immediately decode a message (digital loopback).
 * For verifying the encoder/decoder agree.
 */
export function loopbackTest(text, terminalId) {
  const audio = encodeMessage(text, terminalId);
  return decodeMessage(audio, terminalId);
}

// ---- UTIL ----

function concatFloat32Arrays(arrays) {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0);
  const output = new Float32Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    output.set(arr, offset);
    offset += arr.length;
  }
  return output;
}

export { SAMPLE_RATE, BAUD_RATE, FREQ_PLAN };
