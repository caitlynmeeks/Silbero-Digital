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

// Default waveform types — used when no face analysis voice profile exists
const WAVEFORMS = ['sine', 'sine', 'sine', 'bell', 'sine', 'sine'];

/**
 * Get a deterministic waveform for a terminal ID (fallback when no voice profile).
 */
export function getWaveform(terminalId) {
  return WAVEFORMS[terminalId % WAVEFORMS.length];
}

/**
 * Derive a unique voice profile from face analysis data.
 * Maps biometric features to musical characteristics so each person
 * gets a distinct whistle timbre.
 *
 * @param {Object} faceData - First face from analysis.faces[]
 * @returns {Object} Voice profile with waveform, pitchShift, vibrato, harmonics, breathiness
 */
export function deriveVoiceProfile(faceData) {
  if (!faceData) return { waveform: 'sine', pitchShift: 1.0, vibrato: 0.003, harmonics: 0, breathiness: 0.008 };

  // Waveform from face shape
  const shapeWaveforms = {
    oval: 'sine',         // pure, clear
    round: 'bell',        // warm, bell-like
    square: 'sawtooth',   // buzzy, edgy
    heart: 'softsaw',     // warm but with presence
    oblong: 'triangle',   // hollow, flute-like
  };
  const waveform = shapeWaveforms[faceData.faceShape] || 'sine';

  // Pitch shift from age: younger = higher, older = lower
  // Range: 0.7 (elderly, deep) to 1.4 (child, high)
  const age = faceData.age || 30;
  const pitchShift = Math.max(0.7, Math.min(1.4, 1.5 - (age / 80)));

  // Vibrato depth from symmetry: less symmetric = more vibrato (more character)
  // Range: 0.001 (smooth, symmetric face) to 0.015 (wobbly, asymmetric)
  const sym = faceData.symmetry || 0.9;
  const vibrato = 0.001 + (1 - sym) * 0.04;

  // Harmonic richness from facial hair: clean = pure, hairy = buzzy overtones
  // 0 = pure fundamental, 0.3 = rich harmonics
  let harmonics = 0;
  if (faceData.facialHair) {
    if (faceData.facialHair.mustache) harmonics += 0.12;
    if (faceData.facialHair.beard) harmonics += 0.15;
  }

  // Glasses add a slight metallic edge (upper harmonics emphasis)
  if (faceData.glasses && faceData.glasses.detected) harmonics += 0.05;

  // Breathiness from expression: neutral/sad = breathy, happy/surprised = clear
  const expr = faceData.expression ? faceData.expression.dominant : 'neutral';
  const breathMap = { neutral: 0.012, sad: 0.018, angry: 0.006, happy: 0.004, surprised: 0.003, fearful: 0.020, disgusted: 0.010 };
  const breathiness = breathMap[expr] || 0.008;

  return { waveform, pitchShift, vibrato, harmonics, breathiness };
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
 * SID Chip Percussion Synthesis
 *
 * Commodore 64 SID-style percussive hits for punctuation.
 * Each punctuation mark triggers a short (~50-120ms) percussive sound
 * using pulse waves, noise, and pitch sweeps — the signature sounds
 * of 8-bit chiptune drums.
 */

// SID pulse wave with variable duty cycle
function sidPulse(phase, duty) {
  const p = ((phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return p < (2 * Math.PI * duty) ? 0.8 : -0.8;
}

// SID noise (LFSR-style, deterministic from phase)
function sidNoise(phase) {
  // Fast pseudo-random from phase, simulates LFSR
  const x = Math.sin(phase * 127.1 + phase * phase * 43758.5453) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

/**
 * Generate a SID-style percussive hit.
 * Returns Float32Array of samples for the hit.
 *
 * @param {string} type - Percussion type
 * @param {number} sampleRate - Audio sample rate
 * @returns {Float32Array}
 */
function sidPercussion(type, sampleRate) {
  const hits = {
    // Kick drum: pitch sweeps from ~200Hz down to ~50Hz, pulse wave
    'kick': { freq: 200, freqEnd: 50, dur: 0.09, decay: 0.08, wave: 'pulse', duty: 0.5, noiseAmt: 0.1 },
    // Snare: noise + pulse, fast decay
    'snare': { freq: 300, freqEnd: 200, dur: 0.08, decay: 0.06, wave: 'pulse', duty: 0.25, noiseAmt: 0.7 },
    // Closed hi-hat: mostly noise, very short
    'hihat': { freq: 800, freqEnd: 600, dur: 0.04, decay: 0.03, wave: 'noise', duty: 0, noiseAmt: 1.0 },
    // Open hi-hat: noise, longer tail
    'openhat': { freq: 900, freqEnd: 500, dur: 0.1, decay: 0.08, wave: 'noise', duty: 0, noiseAmt: 1.0 },
    // Rim shot: high pulse, very snappy
    'rim': { freq: 1200, freqEnd: 800, dur: 0.03, decay: 0.02, wave: 'pulse', duty: 0.15, noiseAmt: 0.2 },
    // Cowbell: two detuned square waves
    'cowbell': { freq: 587, freqEnd: 540, dur: 0.06, decay: 0.05, wave: 'pulse', duty: 0.5, noiseAmt: 0.0 },
    // Tom: pulse pitch drop, medium
    'tom': { freq: 160, freqEnd: 80, dur: 0.08, decay: 0.07, wave: 'pulse', duty: 0.4, noiseAmt: 0.05 },
    // Clap: burst of noise with double attack
    'clap': { freq: 1000, freqEnd: 600, dur: 0.07, decay: 0.05, wave: 'noise', duty: 0, noiseAmt: 0.9 },
    // Click: very short high pulse
    'click': { freq: 2000, freqEnd: 1500, dur: 0.015, decay: 0.01, wave: 'pulse', duty: 0.1, noiseAmt: 0.0 },
    // Zap: fast downward sweep
    'zap': { freq: 1500, freqEnd: 100, dur: 0.06, decay: 0.05, wave: 'pulse', duty: 0.3, noiseAmt: 0.0 },
    // Blip: fast upward sweep
    'blip': { freq: 200, freqEnd: 800, dur: 0.04, decay: 0.03, wave: 'pulse', duty: 0.5, noiseAmt: 0.0 },
    // Buzz: sawtooth burst
    'buzz': { freq: 120, freqEnd: 80, dur: 0.07, decay: 0.06, wave: 'saw', duty: 0, noiseAmt: 0.1 },
  };

  const h = hits[type] || hits['click'];
  const totalSamples = Math.ceil(h.dur * sampleRate);
  const samples = new Float32Array(totalSamples);
  let phase = 0;
  let noisePhase = 0;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const progress = t / h.dur;

    // Pitch sweep (exponential)
    const freq = h.freq * Math.pow(h.freqEnd / h.freq, progress);

    // Envelope: fast attack, exponential decay
    const attackEnd = 0.002; // 2ms attack
    let env;
    if (t < attackEnd) {
      env = t / attackEnd;
    } else {
      env = Math.exp(-(t - attackEnd) / h.decay);
    }

    // Generate tone
    phase += (2 * Math.PI * freq) / sampleRate;
    noisePhase += (2 * Math.PI * freq * 3.7) / sampleRate; // noise at different rate

    let sample = 0;
    if (h.wave === 'pulse') {
      sample = sidPulse(phase, h.duty) * (1 - h.noiseAmt);
    } else if (h.wave === 'saw') {
      const p = ((phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      sample = ((p / Math.PI) - 1) * (1 - h.noiseAmt);
    } else {
      sample = 0;
    }

    // Mix in noise
    sample += sidNoise(noisePhase) * h.noiseAmt;

    // Cowbell special: add detuned second oscillator
    if (type === 'cowbell') {
      sample = sample * 0.5 + sidPulse(phase * 1.5, 0.5) * 0.5;
    }

    // Clap special: double hit envelope
    if (type === 'clap' && t > 0.01 && t < 0.02) {
      env *= 0.3; // brief gap for double-tap feel
    }

    samples[i] = sample * env * 0.5; // 0.5 = percussion volume
  }

  return samples;
}

/**
 * Map punctuation characters to SID percussion types.
 */
const PUNCT_PERC = {
  '.':  'kick',      // period = kick drum (downbeat, final)
  ',':  'hihat',     // comma = closed hi-hat (tick, continuation)
  '!':  'snare',     // exclamation = snare (accent)
  '?':  'openhat',   // question = open hi-hat (sustained question)
  ';':  'rim',       // semicolon = rim shot (sharp pause)
  ':':  'cowbell',   // colon = cowbell (announcement)
  '\'': 'click',     // apostrophe = click (tiny articulation)
  '"':  'clap',      // quote = clap (emphasis)
  '-':  'tom',       // dash = tom (bridge)
  '(':  'blip',      // open paren = upward blip (opening)
  ')':  'zap',       // close paren = downward zap (closing)
  '/':  'buzz',      // slash = buzz (cutting)
  '\\': 'buzz',
  '@':  'zap',       // at = zap (digital)
  '#':  'snare',     // hash = snare
  '&':  'cowbell',
  '*':  'rim',
  '+':  'blip',
  '=':  'kick',
  '_':  'tom',
  '%':  'hihat',
  '$':  'click',
  '^':  'blip',
  '~':  'zap',
  '|':  'rim',
  '<':  'blip',
  '>':  'zap',
  '[':  'blip',
  ']':  'zap',
  '{':  'blip',
  '}':  'zap',
};

/**
 * Check if a character should trigger SID percussion instead of a tonal note.
 */
function isPunctuation(char) {
  return PUNCT_PERC[char] !== undefined;
}

/**
 * 31-TET Microtonal Scale System
 *
 * 31 equal divisions of the octave. Each step is 2^(1/31) = ~38.71 cents.
 * Why 31-TET? It's the sweet spot between expressiveness and musicality:
 *
 *   - Excellent just intonation approximations (better thirds than 12-TET)
 *   - "Neutral" intervals that sound North African / Middle Eastern
 *   - Perfect for the Canary Islands (between Spain and Africa)
 *   - 31 steps per octave = every ASCII character gets a unique pitch
 *   - E major maps cleanly to steps {0, 5, 10, 13, 18, 23, 28}
 *
 * Design principle: vowels anchor the listener in E major (familiar),
 * consonants and digits use microtonal positions between those anchors
 * (unfamiliar, haunting). The portamento glides between all of these,
 * creating the characteristic Silbo Gomero sliding whistle.
 */

const BASE_FREQ = 329.63; // E4 — our tonal center

/**
 * Convert a 31-TET step + octave offset to frequency.
 * Step 0 at octave 0 = E4. Negative octaves go lower.
 */
function freq31(step, octave) {
  return BASE_FREQ * Math.pow(2, octave + step / 31);
}

// E major scale degrees in 31-TET steps
// E=0, F#=5, G#=10, A=13, B=18, C#=23, D#=28
const E_MAJOR_STEPS = [0, 5, 10, 13, 18, 23, 28];

// Microtonal steps: everything NOT in E major (24 positions per octave)
const MICRO_STEPS = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 19, 20, 21, 22, 24, 25, 26, 27, 29, 30];

/**
 * Vowels — E major anchor tones.
 * These are the notes the ear locks onto. Spread across the scale
 * so every vowel is a clear melodic interval from the others.
 *
 *   a = A4  (step 13) — the warm center, most open vowel
 *   e = E5  (step 0, oct+1) — the root, one octave up
 *   i = C#5 (step 23) — bright major sixth, highest vowel
 *   o = B4  (step 18) — round perfect fifth
 *   u = F#4 (step 5) — deep second degree, darkest vowel
 */
const VOWEL_FREQS = {
  'a': freq31(13, 0),   // A4  ~440 Hz
  'e': freq31(0, 1),    // E5  ~659 Hz
  'i': freq31(23, 0),   // C#5 ~554 Hz
  'o': freq31(18, 0),   // B4  ~494 Hz
  'u': freq31(5, 0),    // F#4 ~370 Hz
};

/**
 * Consonants — microtonal positions between E major degrees.
 * Voiced consonants (melodic, sustained) get steps in the mid register.
 * Unvoiced consonants (percussive, brief) get steps in higher/lower extremes.
 */
const CONSONANT_FREQS = {};
{
  // Voiced consonants: d, g, j, l, m, n, r, v, w, y, z (11)
  // Spread across microtonal steps in octave 0 (E4-E5 range)
  const voiced = 'dgjlmnrvwyz';
  const voicedSteps = [1, 3, 6, 8, 11, 14, 16, 19, 21, 25, 27];
  for (let i = 0; i < voiced.length; i++) {
    CONSONANT_FREQS[voiced[i]] = freq31(voicedSteps[i], 0);
  }

  // Unvoiced consonants: b, c, f, h, k, p, q, s, t, x (10)
  // Lower register (octave -1, E3-E4 range) — darker, more percussive
  const unvoiced = 'bcfhkpqstx';
  const unvoicedSteps = [2, 4, 7, 9, 12, 15, 17, 22, 25, 29];
  for (let i = 0; i < unvoiced.length; i++) {
    CONSONANT_FREQS[unvoiced[i]] = freq31(unvoicedSteps[i], -1);
  }
}

/**
 * Digits — each gets a unique microtonal position in the upper register.
 * Spread evenly across one octave (E5-E6) using steps that avoid E major.
 * This ensures "1", "2", "3" all sound distinctly different.
 */
const DIGIT_FREQS = {};
{
  // Use microtonal steps spread across the upper octave
  // Chosen to maximize interval variety: some close (microtonal shimmer),
  // some far (clear jumps)
  const digitSteps = [2, 6, 9, 14, 17, 20, 24, 27, 30, 4];
  for (let d = 0; d <= 9; d++) {
    DIGIT_FREQS[String(d)] = freq31(digitSteps[d], 1);
  }
}

/**
 * Spaces are handled specially in the synth loop — they trigger a soft
 * E major power chord (E + B + E) to anchor the listener in E major.
 * Punctuation triggers SID chip percussion (see PUNCT_PERC above).
 */

/**
 * Check if a character is an uppercase letter (for sawtooth buzz).
 */
function isUpperCase(char) {
  return char >= 'A' && char <= 'Z';
}

/**
 * Get the tonal frequency for a character.
 * Vowels → E major. Consonants → microtonal. Digits → upper microtonal.
 * Space → handled by E major chord anchor in synth loop.
 * Punctuation → null (handled by SID percussion in synth loop).
 */
function getFreq(char) {
  const c = char.toLowerCase();

  if (VOWEL_FREQS[c]) return VOWEL_FREQS[c];
  if (CONSONANT_FREQS[c]) return CONSONANT_FREQS[c];
  if (DIGIT_FREQS[c]) return DIGIT_FREQS[c];

  // Spaces and punctuation handled specially in the synth loop
  return null;
}

/**
 * Get amplitude for a character.
 */
function getGain(char) {
  const c = char.toLowerCase();
  if (VOWEL_FREQS[c]) return 1.0;
  if (CONSONANT_FREQS[c]) return isUpperCase(char) ? 0.95 : 0.85;
  if (DIGIT_FREQS[c]) return 0.95;
  return 0;
}

const MIN_DURATION_S = 3.0;
const MAX_DURATION_S = 9.0;

/**
 * Character duration ratios (relative to one beat).
 * Vowels sustain (they're the melody). Consonants are brief articulations.
 * Digits get moderate duration so each is clearly audible.
 * Punctuation gets moderate duration for bass notes to ring.
 */
function getCharRatio(char) {
  const c = char.toLowerCase();
  if (c === ' ') return 0.3;                  // space: bass root, moderate rest
  if (VOWEL_FREQS[c]) return 0.35;            // vowels: sustained melody
  if (DIGIT_FREQS[c]) return 0.25;            // digits: clear, distinct
  if ('stckqxhpf'.includes(c)) return 0.08;   // unvoiced: brief pops
  if (CONSONANT_FREQS[c]) return 0.15;        // voiced consonants: moderate
  return 0.2;                                  // punctuation: bass interval
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
 * @param {string|Object} waveformOrProfile - Waveform string or voice profile from deriveVoiceProfile()
 * @returns {{ samples: Float32Array, durationMs: number }}
 */
export function synthesizeSilbo(text, waveformOrProfile = 'sine') {
  // Accept either a string waveform name or a full voice profile object
  const profile = typeof waveformOrProfile === 'object' ? waveformOrProfile : {
    waveform: waveformOrProfile,
    pitchShift: 1.0,
    vibrato: 0.003,
    harmonics: 0,
    breathiness: 0.008,
  };

  const { waveform, pitchShift, vibrato, harmonics, breathiness } = profile;

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
  let harmonicPhase = 0;
  let currentFreq = freq31(0, 0) * pitchShift; // Start at E4
  let currentGain = 0;
  let sampleIdx = 0;

  // Portamento: lower = more slide. 4 gives long, singing glides.
  const portamentoRate = 4;

  // Vibrato LFO
  let vibratoPhase = 0;
  const vibratoRate = 5.5; // Hz — natural vocal tremolo

  // E major power chord frequencies for space anchors
  // Two octaves of root + perfect 5th = unmistakable E major
  const E_CHORD = [
    freq31(0, 0),   // E4
    freq31(18, 0),  // B4 (perfect 5th)
    freq31(0, 1),   // E5 (octave)
  ];

  for (const char of msg) {
    let rawFreq = getFreq(char);
    let targetGain = getGain(char);
    let duration = getDuration(char, bpm);

    // Whitespace: silent rest (keeps timing gap, no sound)
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      const restSamples = Math.floor(duration * SAMPLE_RATE);
      currentGain *= 0.5; // fade toward silence
      for (let i = 0; i < restSamples && sampleIdx < totalSamples; i++) {
        currentGain *= 0.998;
        samples[sampleIdx] = 0;
        sampleIdx++;
      }
      continue;
    }

    // SID percussion: inject percussive hit for punctuation, then continue
    if (isPunctuation(char)) {
      const percType = PUNCT_PERC[char] || 'click';
      const percSamples = sidPercussion(percType, SAMPLE_RATE);
      const charSamples = Math.floor(duration * SAMPLE_RATE);

      for (let i = 0; i < charSamples && sampleIdx < totalSamples; i++) {
        // Mix percussion hit on top of whatever tone is sustaining
        const perc = i < percSamples.length ? percSamples[i] : 0;

        // Continue the tonal sustain (portamento toward silence)
        currentGain *= 0.9995; // gentle fade during percussion
        phase += (2 * Math.PI * currentFreq) / SAMPLE_RATE;
        const tonalSustain = oscillate(phase, waveform) * currentGain * 0.15;

        samples[sampleIdx] = perc + tonalSustain;
        sampleIdx++;
      }
      continue;
    }

    const targetFreq = rawFreq !== null ? rawFreq * pitchShift : null;
    const charSamples = Math.floor(duration * SAMPLE_RATE);
    const charIsUpper = isUpperCase(char);

    for (let i = 0; i < charSamples && sampleIdx < totalSamples; i++) {
      const dt = 1 / SAMPLE_RATE;

      // Smooth portamento toward target frequency
      if (targetFreq !== null) {
        currentFreq += portamentoRate * (targetFreq - currentFreq) * dt * 60;
      }

      // Vibrato modulation
      vibratoPhase += (2 * Math.PI * vibratoRate) / SAMPLE_RATE;
      const vibratoMod = 1 + Math.sin(vibratoPhase) * vibrato;
      const modulatedFreq = currentFreq * vibratoMod;

      // Smooth gain envelope
      currentGain += portamentoRate * (targetGain - currentGain) * dt * 60;

      // Generate primary sample
      phase += (2 * Math.PI * modulatedFreq) / SAMPLE_RATE;
      let sample;

      if (charIsUpper) {
        // CAPS: sawtooth buzz with extra harmonics — aggressive, loud
        const p = ((phase % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const saw = (p / Math.PI) - 1;
        const sawH2 = (((phase * 2) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / Math.PI - 1;
        sample = (saw * 0.7 + sawH2 * 0.2) * currentGain * 0.35;
      } else {
        sample = oscillate(phase, waveform) * currentGain * 0.3;
      }

      // Add harmonics (overtones from facial hair / glasses)
      if (harmonics > 0) {
        harmonicPhase += (2 * Math.PI * modulatedFreq * 2) / SAMPLE_RATE;
        sample += oscillate(harmonicPhase, charIsUpper ? 'sawtooth' : waveform) * currentGain * 0.3 * harmonics;
        sample += oscillate(harmonicPhase * 1.5, 'sine') * currentGain * 0.3 * harmonics * 0.5;
      }

      // Add breath noise (varies by expression)
      const breath = (Math.random() - 0.5) * breathiness * currentGain;

      samples[sampleIdx] = sample + breath;
      sampleIdx++;
    }
  }

  // Fade out tail — long, singing decay
  const fadeOutSamples = Math.min(Math.floor(0.3 * SAMPLE_RATE), totalSamples - sampleIdx);
  for (let i = 0; i < fadeOutSamples && sampleIdx < totalSamples; i++) {
    currentGain *= 0.997;
    vibratoPhase += (2 * Math.PI * vibratoRate) / SAMPLE_RATE;
    const vibratoMod = 1 + Math.sin(vibratoPhase) * vibrato;
    phase += (2 * Math.PI * currentFreq * vibratoMod) / SAMPLE_RATE;
    let sample = oscillate(phase, waveform) * currentGain * 0.3;
    if (harmonics > 0) {
      harmonicPhase += (2 * Math.PI * currentFreq * vibratoMod * 2) / SAMPLE_RATE;
      sample += oscillate(harmonicPhase, waveform) * currentGain * 0.3 * harmonics;
    }
    samples[sampleIdx] = sample;
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

export { SAMPLE_RATE, MAX_MESSAGE_LENGTH, getFreq, PUNCT_PERC };
