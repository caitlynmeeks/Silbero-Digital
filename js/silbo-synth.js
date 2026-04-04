/**
 * Silbo Synth — Ornamental Silbo Gomero whistle synthesis
 *
 * Maps text to pitch gestures based on the real Silbo Gomero phoneme system.
 * Purely cosmetic — plays while text is displayed but isn't used for
 * actual message transmission. Each user gets a unique waveform timbre.
 *
 * Based on the Silbo Gomero phoneme mapping:
 *   Vowels:     u=1450Hz, o=1600Hz, a=1700Hz, e=2200Hz, i=2700Hz
 *   Voiced C:   d,j,l,n,r,s,t,y,z = 3100Hz
 *   Unvoiced C: b,c,f,g,k,m,p,q,v,w,x = 800Hz
 *   Space:      silence gap
 *
 * Reference: dittytoy.net/ditty/ba926830fc (CC BY-NC-SA 4.0)
 */

const SAMPLE_RATE = 48000;
const MAX_MESSAGE_LENGTH = 256;

// Waveform types — sine-dominant for authentic whistle, with subtle variation per user
const WAVEFORMS = ['sine', 'sine', 'sine', 'bell', 'sine', 'sine'];

/**
 * Get a deterministic waveform for a terminal ID.
 */
export function getWaveform(terminalId) {
  return WAVEFORMS[terminalId % WAVEFORMS.length];
}

/**
 * Oscillator function for different waveforms.
 */
function oscillate(phase, waveform) {
  const p = ((phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  switch (waveform) {
    case 'triangle':
      return p < Math.PI ? (2 * p / Math.PI) - 1 : 3 - (2 * p / Math.PI);
    case 'sawtooth':
      return (p / Math.PI) - 1;
    case 'square':
      return p < Math.PI ? 0.6 : -0.6;
    case 'softsaw': {
      // Sawtooth with rounded edges
      const raw = (p / Math.PI) - 1;
      return raw * (1 - 0.3 * Math.cos(p));
    }
    case 'bell': {
      // Sine with harmonic overtones (bell-like)
      return Math.sin(p) * 0.6 + Math.sin(p * 2) * 0.25 + Math.sin(p * 3) * 0.1;
    }
    default: // sine
      return Math.sin(p);
  }
}

/**
 * Spanish Phrygian pentatonic — all Silbo pitches snap to this scale.
 * Features the signature minor 2nd interval (E-F) that gives flamenco
 * and Andalusian music its haunting, Middle Eastern-tinged character.
 * Perfect for the Canary Islands, which sit between Spain and Africa.
 *
 * E Phrygian pentatonic: E, F, A, B, C
 * (root, flat 2nd, 4th, 5th, flat 6th)
 */
const PENTATONIC_FREQS = [];
{
  const baseNotes = [329.63, 349.23, 440.00, 493.88, 523.25]; // E4 F4 A4 B4 C5
  for (let octave = 0; octave < 5; octave++) {
    for (const note of baseNotes) {
      PENTATONIC_FREQS.push(note * Math.pow(2, octave));
    }
  }
  PENTATONIC_FREQS.sort((a, b) => a - b);
}

/**
 * Snap a frequency to the nearest pentatonic note.
 */
function snapToPentatonic(freq) {
  let best = PENTATONIC_FREQS[0];
  let bestDist = Math.abs(freq - best);
  for (const note of PENTATONIC_FREQS) {
    const dist = Math.abs(freq - note);
    if (dist < bestDist) {
      best = note;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Get the Silbo frequency for a character, snapped to pentatonic scale.
 * Returns null for characters that produce silence.
 */
function getFreq(char) {
  const c = char.toLowerCase();
  let rawFreq = null;

  // Vowels — distinct frequency bands (Silbo Gomero mapping)
  if (c === 'u') rawFreq = 1450 + (Math.random() - 0.5) * 100;
  else if (c === 'o') rawFreq = 1600 + (Math.random() - 0.5) * 200;
  else if (c === 'a') rawFreq = 1700 + (Math.random() - 0.5) * 160;
  else if (c === 'e') rawFreq = 2200 + (Math.random() - 0.5) * 400;
  else if (c === 'i') rawFreq = 2700 + (Math.random() - 0.5) * 200;
  // Voiced consonants — high cluster
  else if ('djlnrstyz'.includes(c)) rawFreq = 3100 + (Math.random() - 0.5) * 200;
  // Unvoiced consonants — low cluster
  else if ('bcfgkmpqvwx'.includes(c)) rawFreq = 800 + (Math.random() - 0.5) * 100;
  // Numbers
  else if (c >= '0' && c <= '9') rawFreq = 1400 + (parseInt(c) * 200);

  if (rawFreq === null) return null; // space, punctuation = silence
  return snapToPentatonic(rawFreq);
}

/**
 * Get amplitude for a character. Silent consonants and spaces get 0.
 */
function getGain(char) {
  const c = char.toLowerCase();
  if ('abdefgijlmnorsuvwyz0123456789'.includes(c)) return 1;
  return 0;
}

const MIN_DURATION_S = 3.0;
const MAX_DURATION_S = 9.0;

/**
 * Character duration ratios (relative to one beat).
 */
function getCharRatio(char) {
  const c = char.toLowerCase();
  if (c === ' ') return 0.4;
  if ('aeiou'.includes(c)) return 0.35;
  if ('stlckqj'.includes(c)) return 0.08;
  return 0.15;
}

/**
 * Calculate BPM so the message duration is between 3s and 9s.
 */
function calculateBPM(text) {
  let totalBeats = 0;
  for (const char of text) {
    totalBeats += getCharRatio(char);
  }
  // duration = totalBeats * (60/BPM)
  // For min 3s: BPM <= totalBeats * 60 / 3
  // For max 9s: BPM >= totalBeats * 60 / 9
  const bpmForMin = (totalBeats * 60) / MIN_DURATION_S;
  const bpmForMax = (totalBeats * 60) / MAX_DURATION_S;
  return Math.max(bpmForMax, Math.min(bpmForMin, 128));
}

function getDuration(char, bpm) {
  return getCharRatio(char) * (60 / bpm);
}

/**
 * Synthesize Silbo whistle audio for a text message.
 * BPM auto-adjusts so every message is at least 3 seconds long.
 *
 * @param {string} text - Message text (max 256 chars)
 * @param {string} waveform - Oscillator waveform type
 * @returns {{ samples: Float32Array, durationMs: number }}
 */
export function synthesizeSilbo(text, waveform = 'sine') {
  const msg = text.slice(0, MAX_MESSAGE_LENGTH);
  const bpm = calculateBPM(msg);

  // Pre-calculate total duration
  let totalDuration = 0;
  for (const char of msg) {
    totalDuration += getDuration(char, bpm);
  }
  totalDuration += 0.3; // Fade out tail

  const totalSamples = Math.ceil(totalDuration * SAMPLE_RATE);
  const samples = new Float32Array(totalSamples);

  let phase = 0;
  let currentFreq = 1400;
  let currentGain = 0;
  let sampleIdx = 0;

  // Portamento: lower = more slide. 4 gives long, singing glides.
  const portamentoRate = 4;

  for (const char of msg) {
    const targetFreq = getFreq(char);
    const targetGain = getGain(char);
    const duration = getDuration(char, bpm);
    const charSamples = Math.floor(duration * SAMPLE_RATE);

    for (let i = 0; i < charSamples && sampleIdx < totalSamples; i++) {
      const dt = 1 / SAMPLE_RATE;

      // Smooth portamento toward target frequency
      if (targetFreq !== null) {
        currentFreq += portamentoRate * (targetFreq - currentFreq) * dt * 60;
      }

      // Smooth gain envelope
      const gainTarget = targetGain;
      currentGain += portamentoRate * (gainTarget - currentGain) * dt * 60;

      // Generate sample
      phase += (2 * Math.PI * currentFreq) / SAMPLE_RATE;
      const sample = oscillate(phase, waveform) * currentGain * 0.3;

      // Add subtle breath noise
      const breath = (Math.random() - 0.5) * 0.008 * currentGain;

      samples[sampleIdx] = sample + breath;
      sampleIdx++;
    }
  }

  // Fade out tail — long, singing decay
  const fadeOutSamples = Math.min(Math.floor(0.3 * SAMPLE_RATE), totalSamples - sampleIdx);
  for (let i = 0; i < fadeOutSamples && sampleIdx < totalSamples; i++) {
    currentGain *= 0.997;
    phase += (2 * Math.PI * currentFreq) / SAMPLE_RATE;
    samples[sampleIdx] = oscillate(phase, waveform) * currentGain * 0.3;
    sampleIdx++;
  }

  const finalSamples = samples.subarray(0, sampleIdx);
  return { samples: finalSamples, durationMs: (sampleIdx / SAMPLE_RATE) * 1000 };
}

/**
 * Play audio samples through an AudioContext.
 * Returns a promise that resolves when playback finishes.
 */
export function playSilbo(audioCtx, samples) {
  if (!audioCtx) return Promise.resolve();
  if (audioCtx.state === 'suspended') audioCtx.resume();

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

/**
 * Play Silbo audio without waiting (fire and forget).
 */
export function playSilboAsync(audioCtx, samples) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const buffer = audioCtx.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(samples);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start();
}

export { SAMPLE_RATE, MAX_MESSAGE_LENGTH };
