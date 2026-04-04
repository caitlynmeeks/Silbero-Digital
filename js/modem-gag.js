/**
 * Modem Gag — Bell 103 handshake squawk generator
 *
 * Generates the unmistakable sound of a 300 baud modem handshake.
 * Placed deliberately in the 1-2 kHz range where trance music is loudest,
 * so it sounds maximally wrong. Triggered randomly between Silbo messages.
 *
 * In the cistern, the reverb will turn this into a churning metallic growl.
 */

const SAMPLE_RATE = 48000;

// Bell 103 frequencies
const ORIGINATE_MARK = 1270;  // binary 1
const ORIGINATE_SPACE = 1070; // binary 0
const ANSWER_MARK = 2225;     // binary 1
const ANSWER_SPACE = 2025;    // binary 0

/**
 * Generate Bell 103 FSK for a byte sequence.
 */
function fskEncode(bytes, markFreq, spaceFreq, baudRate = 300) {
  const samplesPerBit = Math.floor(SAMPLE_RATE / baudRate);
  const bits = [];

  for (const byte of bytes) {
    // Start bit (space)
    bits.push(0);
    // Data bits (LSB first)
    for (let i = 0; i < 8; i++) {
      bits.push((byte >> i) & 1);
    }
    // Stop bit (mark)
    bits.push(1);
  }

  const totalSamples = bits.length * samplesPerBit;
  const output = new Float32Array(totalSamples);
  let phase = 0;

  for (let b = 0; b < bits.length; b++) {
    const freq = bits[b] === 1 ? markFreq : spaceFreq;
    for (let i = 0; i < samplesPerBit; i++) {
      const idx = b * samplesPerBit + i;
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      output[idx] = 0.4 * Math.sin(phase);
    }
  }

  return output;
}

/**
 * Generate a carrier tone (pure mark frequency).
 */
function carrierTone(freq, durationMs, amplitude = 0.4) {
  const samples = Math.floor((durationMs / 1000) * SAMPLE_RATE);
  const output = new Float32Array(samples);
  let phase = 0;

  for (let i = 0; i < samples; i++) {
    phase += (2 * Math.PI * freq) / SAMPLE_RATE;
    output[i] = amplitude * Math.sin(phase);
  }

  return output;
}

/**
 * Generate a modem handshake sequence.
 *
 * Structure:
 * 1. Answer tone (2225 Hz) — 300ms
 * 2. Brief silence — 50ms
 * 3. Originate carrier (1270 Hz) — 200ms
 * 4. Binary FSK encoding of "NO CARRIER" or random garbage — ~800ms
 * 5. Abrupt cutoff
 *
 * Total: ~1.5 seconds of beautiful noise.
 */
export function generateHandshake() {
  const segments = [];

  // Answer tone
  segments.push(carrierTone(ANSWER_MARK, 300));

  // Brief silence
  segments.push(new Float32Array(Math.floor(0.05 * SAMPLE_RATE)));

  // Originate carrier
  segments.push(carrierTone(ORIGINATE_MARK, 200));

  // Encode "NO CARRIER\r\n" as FSK
  const message = 'NO CARRIER\r\n';
  const bytes = Array.from(message).map(c => c.charCodeAt(0));
  segments.push(fskEncode(bytes, ORIGINATE_MARK, ORIGINATE_SPACE, 300));

  // Concatenate
  const totalLength = segments.reduce((sum, s) => sum + s.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const seg of segments) {
    output.set(seg, offset);
    offset += seg.length;
  }

  return output;
}

/**
 * Generate a burst of random modem garbage — just FSK-encoded random bytes.
 * Shorter and more chaotic than the handshake.
 */
export function generateGarbage(durationMs = 800) {
  const byteCount = Math.floor((durationMs / 1000) * 300 / 10); // ~10 bits per byte at 300 baud
  const bytes = [];
  for (let i = 0; i < byteCount; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  return fskEncode(bytes, ORIGINATE_MARK, ORIGINATE_SPACE, 300);
}

/**
 * Should we play a modem gag before this message?
 * ~10% chance, for maximum comedic timing.
 */
export function shouldPlayModemGag() {
  return Math.random() < 0.10;
}

export { SAMPLE_RATE };
