/**
 * Chirp Decoder — FFT-based receiver for Silbo whistle signals
 *
 * Uses short-time FFT to track the dominant frequency within each carrier
 * band, then maps the frequency trajectory back to characters using the
 * same pitch map as the encoder.
 *
 * For cistern reverb robustness: the FFT peak-picking naturally favors
 * the strongest (direct) signal over reverb tails, and the bandpass
 * filtering rejects out-of-band energy from trance music.
 *
 * Pipeline:
 *   mic input -> bandpass filter -> sliding FFT -> peak frequency tracking ->
 *   time-based segmentation -> pitch-to-char lookup -> majority vote
 */

import { SAMPLE_RATE, CHAR_MAP, pitchForChar } from './chirp-encoder.js';
import { getCarriers, getFilterBounds, majorityVote } from './fhss.js';

// Decoder parameters
const FFT_SIZE = 8192;                     // ~170ms window at 48kHz — 5.86 Hz/bin resolution
const HOP_SIZE = 2048;                     // ~42ms hop
const MIN_ENERGY_THRESHOLD = 0.0005;       // Noise gate (RMS)
const SYMBOL_DURATION_S = 0.400;           // glide (120ms) + sustain (280ms) per char
const SYMBOL_HOPS = Math.round(SYMBOL_DURATION_S / (HOP_SIZE / SAMPLE_RATE));

/**
 * Bandpass filter via biquad — 2nd order peaking.
 */
function designBandpass(lowHz, highHz, sampleRate) {
  const centerHz = (lowHz + highHz) / 2;
  const bw = highHz - lowHz;
  const w0 = (2 * Math.PI * centerHz) / sampleRate;
  const Q = centerHz / bw;
  const alpha = Math.sin(w0) / (2 * Q);

  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;

  return {
    b: [b0 / a0, b1 / a0, b2 / a0],
    a: [1, a1 / a0, a2 / a0],
  };
}

function applyBiquad(signal, coeffs) {
  const { b, a } = coeffs;
  const output = new Float32Array(signal.length);
  let z1 = 0, z2 = 0;

  for (let i = 0; i < signal.length; i++) {
    const x = signal[i];
    const y = b[0] * x + z1;
    z1 = b[1] * x - a[1] * y + z2;
    z2 = b[2] * x - a[2] * y;
    output[i] = y;
  }

  return output;
}

/**
 * Hann window for FFT.
 */
function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

/**
 * Simple radix-2 DIT FFT (in-place, complex).
 * Input: real/imag arrays of length N (must be power of 2).
 */
function fft(real, imag) {
  const N = real.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  // Cooley-Tukey butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let i = 0; i < N; i += len) {
      let curReal = 1, curImag = 0;
      for (let j = 0; j < halfLen; j++) {
        const tReal = curReal * real[i + j + halfLen] - curImag * imag[i + j + halfLen];
        const tImag = curReal * imag[i + j + halfLen] + curImag * real[i + j + halfLen];
        real[i + j + halfLen] = real[i + j] - tReal;
        imag[i + j + halfLen] = imag[i + j] - tImag;
        real[i + j] += tReal;
        imag[i + j] += tImag;
        const newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }
}

/**
 * Find the peak frequency in an FFT magnitude spectrum within a Hz range.
 * Uses parabolic interpolation around the peak bin for sub-bin accuracy.
 */
function findPeakFrequency(magnitudes, sampleRate, fftSize, minHz, maxHz) {
  const binWidth = sampleRate / fftSize;
  const minBin = Math.max(1, Math.floor(minHz / binWidth));
  const maxBin = Math.min(magnitudes.length - 2, Math.ceil(maxHz / binWidth));

  let peakBin = minBin;
  let peakMag = magnitudes[minBin];

  for (let i = minBin + 1; i <= maxBin; i++) {
    if (magnitudes[i] > peakMag) {
      peakMag = magnitudes[i];
      peakBin = i;
    }
  }

  // Check if peak is significant above noise floor
  // (average magnitude in the search range)
  let avgMag = 0;
  for (let i = minBin; i <= maxBin; i++) avgMag += magnitudes[i];
  avgMag /= (maxBin - minBin + 1);

  if (peakMag < avgMag * 4) return null; // No clear tonal peak (silence/noise)

  // Parabolic interpolation for sub-bin precision
  if (peakBin > 0 && peakBin < magnitudes.length - 1) {
    const alpha = magnitudes[peakBin - 1];
    const beta = magnitudes[peakBin];
    const gamma = magnitudes[peakBin + 1];
    const denom = alpha - 2 * beta + gamma;
    if (denom !== 0) {
      const correction = 0.5 * (alpha - gamma) / denom;
      return (peakBin + correction) * binWidth;
    }
  }

  return peakBin * binWidth;
}

/**
 * Run a short-time FFT across the signal and return a frequency track.
 */
function trackFrequency(signal, carrierHz) {
  const window = hannWindow(FFT_SIZE);
  const minHz = carrierHz - 220;
  const maxHz = carrierHz + 220;
  const track = [];

  for (let start = 0; start + FFT_SIZE <= signal.length; start += HOP_SIZE) {
    // Window the segment
    const real = new Float32Array(FFT_SIZE);
    const imag = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      real[i] = signal[start + i] * window[i];
    }

    // FFT
    fft(real, imag);

    // Compute magnitudes (only need first half)
    const halfN = FFT_SIZE / 2;
    const magnitudes = new Float32Array(halfN);
    for (let i = 0; i < halfN; i++) {
      magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }

    // Find peak frequency in carrier band
    const freq = findPeakFrequency(magnitudes, SAMPLE_RATE, FFT_SIZE, minHz, maxHz);

    // Also compute RMS energy in the band for activity detection
    const binWidth = SAMPLE_RATE / FFT_SIZE;
    const loB = Math.floor(minHz / binWidth);
    const hiB = Math.ceil(maxHz / binWidth);
    let bandEnergy = 0;
    for (let i = loB; i <= hiB && i < halfN; i++) {
      bandEnergy += magnitudes[i] * magnitudes[i];
    }
    bandEnergy = Math.sqrt(bandEnergy / Math.max(1, hiB - loB + 1));

    track.push({
      time: start / SAMPLE_RATE,
      freq,
      energy: bandEnergy,
    });
  }

  return track;
}

/**
 * Segment a frequency track into symbols based on timing.
 *
 * All characters (including spaces) are 170ms in the encoder.
 * Use ALL frames (not just active ones) to find the signal boundaries,
 * then divide into fixed 170ms slots. Low-energy slots = spaces.
 */
function segmentToSymbols(track, carrierHz) {
  if (track.length === 0) return [];

  // Find the first and last frame with significant energy (signal boundaries)
  const energyThreshold = 0.005;
  let firstActive = -1, lastActive = -1;
  for (let i = 0; i < track.length; i++) {
    if (track[i].energy > energyThreshold) {
      if (firstActive === -1) firstActive = i;
      lastActive = i;
    }
  }
  if (firstActive === -1) return [];

  const startTime = track[firstActive].time;
  const endTime = track[lastActive].time + (HOP_SIZE / SAMPLE_RATE);
  const duration = endTime - startTime;

  // Divide into fixed-width symbol slots (all chars are 170ms including spaces)
  const numSymbols = Math.max(1, Math.round(duration / SYMBOL_DURATION_S));
  const symbols = [];

  for (let s = 0; s < numSymbols; s++) {
    const slotStart = startTime + s * SYMBOL_DURATION_S;
    const slotEnd = slotStart + SYMBOL_DURATION_S;

    // Get all frames in this slot
    const slotFrames = track.filter(f => f.time >= slotStart && f.time < slotEnd);

    // Skip empty slots (no frames at all — shouldn't happen with fixed-width encoding)
    if (slotFrames.length === 0) {
      symbols.push({ freq: carrierHz + 190, isSpace: true });
      continue;
    }

    // Collect ALL frequency readings in this slot (not just sustain)
    const allFreqs = slotFrames.filter(f => f.freq !== null).map(f => f.freq);

    // Debug: log slot info
    const slotEnergies = slotFrames.map(f => f.energy);
    const avgE = slotEnergies.reduce((a,b) => a+b, 0) / slotEnergies.length;
    console.log(`Slot ${s}: freqs=[${allFreqs.map(f=>f.toFixed(0)).join(',')}] avgEnergy=${avgE.toFixed(4)} frames=${slotFrames.length}`);

    if (allFreqs.length === 0) {
      symbols.push({ freq: carrierHz + 190, isSpace: true });
      continue;
    }

    // Median frequency
    allFreqs.sort((a, b) => a - b);
    const median = allFreqs[Math.floor(allFreqs.length / 2)];
    symbols.push({ freq: median, isSpace: false });
  }

  return symbols;
}

/**
 * Map a frequency to the closest character in the CHAR_MAP.
 * With 27 symbols (a-z + space) at 13.4 Hz spacing, the maximum
 * error for a correct match is ~6.7 Hz.
 *
 * Space is encoded as a marker tone at +190 Hz offset (above 'z' at +168).
 * Any peak above +178 Hz is recognized as a space.
 */
function freqToChar(freq, carrierHz) {
  const offset = freq - carrierHz;

  // Space marker detection — above the letter range
  if (offset > 178) return { char: ' ', confidence: 0.9 };

  let bestChar = '?';
  let bestDist = Infinity;

  for (const [ch, charOffset] of Object.entries(CHAR_MAP)) {
    if (ch === ' ') continue; // Space detected by marker above
    const dist = Math.abs(offset - charOffset);
    if (dist < bestDist) {
      bestDist = dist;
      bestChar = ch;
    }
  }

  // Confidence: 0 Hz off = 1.0, beyond half the symbol spacing = 0.0
  const confidence = Math.max(0, 1 - bestDist / 10);
  return { char: bestChar, confidence };
}

/**
 * Decode a chunk of audio on a single carrier frequency.
 */
export function decodeCarrier(audio, carrierHz) {
  const bounds = getFilterBounds(carrierHz);

  // Bandpass filter — apply 3 times for 6th order (steep rolloff)
  const bpCoeffs = designBandpass(bounds.low, bounds.high, SAMPLE_RATE);
  let filtered = audio;
  for (let pass = 0; pass < 3; pass++) {
    filtered = applyBiquad(filtered, bpCoeffs);
  }

  // Track frequency over time
  const freqTrack = trackFrequency(filtered, carrierHz);

  // Segment into symbols
  const symbols = segmentToSymbols(freqTrack, carrierHz);

  // Map symbols to characters
  const chars = symbols.map(sym => {
    if (sym.isSpace) return { char: ' ', confidence: 0.5 };
    return freqToChar(sym.freq, carrierHz);
  });

  const text = chars.map(c => c.char).join('');
  const avgConfidence = chars.length > 0
    ? chars.reduce((sum, c) => sum + c.confidence, 0) / chars.length
    : 0;

  return { text, confidence: avgConfidence, chars };
}

/**
 * Full decode pipeline — decode on all carriers for a source terminal
 * and take majority vote.
 */
export function decodeMessage(audio, sourceTerminalId) {
  const carriers = getCarriers(sourceTerminalId);
  const results = carriers.map(c => decodeCarrier(audio, c));
  const decodedStreams = results.map(r => r.text);
  return majorityVote(decodedStreams);
}

/**
 * Detect if there's a transmission present in the audio.
 * Checks for tonal energy in the carrier band.
 */
export function detectTransmission(audio, carrierHz) {
  const bounds = getFilterBounds(carrierHz);
  const bpCoeffs = designBandpass(bounds.low, bounds.high, SAMPLE_RATE);
  let filtered = applyBiquad(audio, bpCoeffs);
  filtered = applyBiquad(filtered, bpCoeffs);

  // RMS energy
  let energy = 0;
  for (let i = 0; i < filtered.length; i++) {
    energy += filtered[i] * filtered[i];
  }
  energy = Math.sqrt(energy / filtered.length);

  return energy > MIN_ENERGY_THRESHOLD * 5;
}

export { SAMPLE_RATE, FFT_SIZE, HOP_SIZE };
