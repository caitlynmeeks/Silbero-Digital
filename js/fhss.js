/**
 * FHSS — Frequency Hopping Spread Spectrum carrier management
 *
 * Manages the carrier frequency plan for up to 5 simultaneous terminals.
 * Each terminal transmits on 4 carriers (FHSS redundancy) within the
 * 3.5–7 kHz band, above the main energy of trance music.
 *
 * The receiver runs parallel decode pipelines on all carriers for all
 * active terminals and takes a majority vote per symbol.
 */

/**
 * Carrier frequency plan.
 *
 * 5 terminals, each with 4 FHSS carriers. Carriers are spread across
 * 3.5–7.0 kHz with 80 Hz guard bands between adjacent carriers.
 *
 * Each terminal's 4 carriers are interleaved across the band rather than
 * grouped — this means a single trance synth note can't wipe out all 4
 * carriers of any one terminal simultaneously.
 *
 * Pitch range per carrier: ±180 Hz (360 Hz occupied bandwidth)
 * Guard band: 80 Hz
 * Slot width: 360 + 80 = 440 Hz
 * Total slots needed: 5 terminals x 4 carriers = 20 slots
 * Total bandwidth: 20 x 440 = 8800 Hz — too wide!
 *
 * Solution: reduce to 3 FHSS carriers per terminal with wider spacing.
 * 5 x 3 = 15 slots. Still too many for 3.5 kHz of bandwidth.
 *
 * Better solution: stagger carriers so different terminals share the same
 * frequency slots with time-domain CSMA separation. Each terminal has 3
 * carriers, with carrier sets partially overlapping between terminals.
 * The decoder uses terminal-specific preamble signatures to distinguish.
 *
 * Practical plan for 5 terminals with 3 carriers each in 3.5–7.0 kHz:
 */

// Carrier center frequencies per terminal (Hz)
// Arranged so each terminal's 3 carriers span the full band
export const CARRIER_PLAN = {
  1: [3700, 4900, 6100],
  2: [3900, 5100, 6300],
  3: [4100, 5300, 6500],
  4: [4300, 5500, 6700],
  5: [4500, 5700, 6900],
};

// Pitch range per carrier (Hz from center)
// Extra margin to include space marker at +190 Hz
export const PITCH_RANGE = 210;

// Guard band between adjacent carriers (Hz)
export const GUARD_BAND = 80;

// Minimum spacing between carriers of different terminals: 200 Hz
// This is enough for bandpass filtering to separate them.

/**
 * Get the carrier frequencies for a terminal.
 */
export function getCarriers(terminalId) {
  return CARRIER_PLAN[terminalId] || CARRIER_PLAN[1];
}

/**
 * Get the bandpass filter bounds for a specific carrier.
 * Used by the decoder to isolate one carrier from the mix.
 */
export function getFilterBounds(carrierHz) {
  return {
    low: carrierHz - PITCH_RANGE - 20,   // slight extra margin
    high: carrierHz + PITCH_RANGE + 20,
  };
}

/**
 * Preamble signature per terminal — a unique ascending/descending chirp
 * pattern that identifies which terminal is transmitting. The decoder
 * correlates against all 5 preamble templates to determine source.
 *
 * Terminal 1: up sweep
 * Terminal 2: down sweep
 * Terminal 3: up-down (chevron)
 * Terminal 4: down-up (valley)
 * Terminal 5: double pulse
 */
export const PREAMBLE_PATTERNS = {
  1: 'up',
  2: 'down',
  3: 'chevron',
  4: 'valley',
  5: 'double',
};

/**
 * Check if a frequency band is likely to be clear of trance music energy.
 * Based on typical trance spectral profile.
 *
 * @param {number} freqHz - Frequency to check
 * @returns {string} - 'clear', 'marginal', or 'contested'
 */
export function bandClearance(freqHz) {
  if (freqHz < 500) return 'contested';   // kick/bass
  if (freqHz < 2000) return 'contested';  // synth mids
  if (freqHz < 3500) return 'marginal';   // upper synths
  if (freqHz < 8000) return 'clear';      // our operating range
  if (freqHz < 16000) return 'marginal';  // hi-hats
  return 'clear';
}

/**
 * Majority vote across decoded carrier streams.
 *
 * @param {string[]} decodedStreams - Array of decoded strings, one per carrier
 * @returns {{ text: string, confidence: number }}
 */
export function majorityVote(decodedStreams) {
  if (decodedStreams.length === 0) return { text: '', confidence: 0 };

  const maxLen = Math.max(...decodedStreams.map(s => s.length));
  let text = '';
  let totalConfidence = 0;

  for (let i = 0; i < maxLen; i++) {
    // Count character votes at position i
    const votes = {};
    let validVotes = 0;

    for (const stream of decodedStreams) {
      if (i < stream.length) {
        const ch = stream[i];
        votes[ch] = (votes[ch] || 0) + 1;
        validVotes++;
      }
    }

    // Find winner
    let bestChar = '?';
    let bestCount = 0;
    for (const [ch, count] of Object.entries(votes)) {
      if (count > bestCount) {
        bestChar = ch;
        bestCount = count;
      }
    }

    text += bestChar;
    totalConfidence += bestCount / validVotes;
  }

  const confidence = maxLen > 0 ? totalConfidence / maxLen : 0;
  return { text, confidence };
}
