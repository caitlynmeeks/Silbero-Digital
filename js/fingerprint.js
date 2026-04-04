/**
 * Fingerprint — Device intelligence collector
 *
 * Harvests every piece of information the browser will surrender
 * without any permissions prompt. The resulting dossier is sent to
 * the operator station.
 *
 * This is disclosed in the ToS. The art is in the aggregation.
 */

/**
 * Collect everything. Returns a comprehensive dossier object.
 */
export async function collectFingerprint() {
  const d = {};

  // ---- Network & Location ----
  d.timestamp = new Date().toISOString();
  d.url = location.href;
  d.referrer = document.referrer || null;

  // IP geolocation (fetched from free API)
  try {
    const geo = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
    if (geo.ok) {
      const g = await geo.json();
      d.ip = g.ip;
      d.city = g.city;
      d.region = g.region;
      d.country = g.country_name;
      d.countryCode = g.country_code;
      d.postalCode = g.postal;
      d.latitude = g.latitude;
      d.longitude = g.longitude;
      d.timezone = g.timezone;
      d.isp = g.org;
      d.asn = g.asn;
    }
  } catch (e) {
    d.ip = null;
    d.geoError = e.message;
  }

  // ---- Connection ----
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    d.connectionType = conn.effectiveType;  // '4g', '3g', etc.
    d.downlink = conn.downlink;             // Mbps
    d.rtt = conn.rtt;                       // ms
    d.saveData = conn.saveData;
  }

  // ---- Device ----
  d.userAgent = navigator.userAgent;
  d.platform = navigator.platform;
  d.vendor = navigator.vendor;
  d.maxTouchPoints = navigator.maxTouchPoints;
  d.hardwareConcurrency = navigator.hardwareConcurrency;  // CPU cores
  d.deviceMemory = navigator.deviceMemory || null;        // GB RAM (Chrome)
  d.language = navigator.language;
  d.languages = [...(navigator.languages || [])];

  // ---- Screen ----
  d.screenWidth = screen.width;
  d.screenHeight = screen.height;
  d.screenAvailWidth = screen.availWidth;
  d.screenAvailHeight = screen.availHeight;
  d.colorDepth = screen.colorDepth;
  d.pixelRatio = window.devicePixelRatio;
  d.innerWidth = window.innerWidth;
  d.innerHeight = window.innerHeight;
  d.orientation = screen.orientation?.type || null;

  // ---- Preferences ----
  d.darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  d.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  d.doNotTrack = navigator.doNotTrack === '1' || window.doNotTrack === '1';

  // ---- Timezone ----
  d.timezoneOffset = new Date().getTimezoneOffset();
  d.timezoneIANA = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // ---- Battery ----
  try {
    if (navigator.getBattery) {
      const batt = await navigator.getBattery();
      d.batteryLevel = Math.round(batt.level * 100);
      d.batteryCharging = batt.charging;
    }
  } catch (e) {}

  // ---- WebGL (GPU identification) ----
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        d.gpuVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        d.gpuRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
      d.webglVersion = gl.getParameter(gl.VERSION);
      d.webglVendor = gl.getParameter(gl.VENDOR);
      d.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    }
  } catch (e) {}

  // ---- Canvas Fingerprint ----
  // Renders text and shapes, hashes the result — unique per device/GPU/font stack
  try {
    const c = document.createElement('canvas');
    c.width = 280;
    c.height = 30;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('Silbero.Digital <canvas> fp', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('Silbero.Digital <canvas> fp', 4, 17);
    d.canvasFingerprint = await hashString(c.toDataURL());
  } catch (e) {
    d.canvasFingerprint = null;
  }

  // ---- Audio Fingerprint ----
  // AudioContext oscillator output varies by device
  try {
    const actx = new OfflineAudioContext(1, 4410, 44100);
    const osc = actx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -50;
    comp.knee.value = 40;
    comp.ratio.value = 12;
    comp.attack.value = 0;
    comp.release.value = 0.25;
    osc.connect(comp);
    comp.connect(actx.destination);
    osc.start(0);
    const rendered = await actx.startRendering();
    const data = rendered.getChannelData(0);
    // Hash a slice of the output
    let sum = 0;
    for (let i = 4000; i < 4410; i++) sum += Math.abs(data[i]);
    d.audioFingerprint = sum.toFixed(10);
  } catch (e) {
    d.audioFingerprint = null;
  }

  // ---- Installed Fonts (subset detection) ----
  try {
    d.installedFonts = detectFonts();
  } catch (e) {
    d.installedFonts = [];
  }

  // ---- Media Capabilities ----
  d.mediaDevices = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    d.mediaDevices = devices.map(dev => ({
      kind: dev.kind,
      label: dev.label || null,  // Only populated after permission granted
    }));
  } catch (e) {}

  // ---- Storage ----
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      d.storageQuota = est.quota;
      d.storageUsage = est.usage;
    }
  } catch (e) {}

  // ---- Misc ----
  d.cookiesEnabled = navigator.cookieEnabled;
  d.pdfViewerEnabled = navigator.pdfViewerEnabled;
  d.webdriver = navigator.webdriver;  // true if automated (headless browser)

  // ---- Composite Hash ----
  // A single hash that uniquely identifies this device across sessions
  const composite = [
    d.canvasFingerprint, d.audioFingerprint, d.gpuRenderer,
    d.userAgent, d.screenWidth, d.screenHeight, d.pixelRatio,
    d.hardwareConcurrency, d.timezoneIANA, d.language,
    (d.installedFonts || []).join(',')
  ].join('|');
  d.deviceHash = await hashString(composite);

  // Generate a deterministic MAC-format address from the device hash
  // Browsers can't read real MACs, but this derived ID looks authentic
  const macHash = await hashString('mac:' + composite);
  d.macAddress = macHash.slice(0, 12).match(/.{2}/g).join(':').toUpperCase();

  return d;
}

/**
 * Estimate handedness from a selfie image.
 * Analyzes which side of the image has more activity (brightness variance)
 * near the face region. The dominant hand tends to be higher/more active
 * in a whistling gesture.
 *
 * Note: front camera mirrors the image, so left-in-image = right hand.
 *
 * @param {HTMLCanvasElement|ImageBitmap} image
 * @returns {string} 'right', 'left', or 'unknown'
 */
export function estimateHandedness(imageSource) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageSource, 0, 0, 160, 120);

    const data = ctx.getImageData(0, 0, 160, 120).data;

    // Compare brightness variance in left vs right halves of upper region
    // (where hands would be in a whistle gesture)
    let leftVar = 0, rightVar = 0;
    let leftMean = 0, rightMean = 0;
    let leftCount = 0, rightCount = 0;

    // Upper 60% of image, split left/right
    for (let y = 0; y < 72; y++) {
      for (let x = 0; x < 160; x++) {
        const idx = (y * 160 + x) * 4;
        const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        if (x < 80) {
          leftMean += brightness;
          leftCount++;
        } else {
          rightMean += brightness;
          rightCount++;
        }
      }
    }
    leftMean /= leftCount;
    rightMean /= rightCount;

    // Variance
    for (let y = 0; y < 72; y++) {
      for (let x = 0; x < 160; x++) {
        const idx = (y * 160 + x) * 4;
        const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        if (x < 80) {
          leftVar += (brightness - leftMean) ** 2;
        } else {
          rightVar += (brightness - rightMean) ** 2;
        }
      }
    }
    leftVar /= leftCount;
    rightVar /= rightCount;

    // Higher variance = more hand/gesture activity
    // Remember: front camera mirrors, so left-in-image = right hand
    const ratio = leftVar / (rightVar + 0.001);
    if (ratio > 1.15) return 'right-handed (estimated)';
    if (ratio < 0.85) return 'left-handed (estimated)';
    return 'ambiguous';
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Detect installed fonts by measuring rendered text width.
 * If a font is installed, text rendered in that font will have
 * different dimensions than the fallback.
 */
function detectFonts() {
  const testFonts = [
    'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS',
    'Consolas', 'Courier New', 'Georgia', 'Helvetica', 'Helvetica Neue',
    'Impact', 'Lucida Console', 'Monaco', 'Palatino', 'Segoe UI',
    'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
    'Futura', 'Gill Sans', 'Optima', 'Roboto', 'Open Sans',
    'Menlo', 'SF Pro', 'San Francisco', 'Noto Sans',
  ];

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const testString = 'mmmmmmmmlli';
  const baseFont = 'monospace';

  ctx.font = `72px ${baseFont}`;
  const baseWidth = ctx.measureText(testString).width;

  const detected = [];
  for (const font of testFonts) {
    ctx.font = `72px '${font}', ${baseFont}`;
    const width = ctx.measureText(testString).width;
    if (width !== baseWidth) {
      detected.push(font);
    }
  }
  return detected;
}

/**
 * SHA-256 hash a string.
 */
async function hashString(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(hash);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Collect behavioral biometrics from typing.
 * Call on each keypress — builds a timing profile.
 */
export class TypingBiometrics {
  constructor() {
    this.keyTimes = [];
    this.lastKeyTime = null;
    this.intervals = [];
    this.holdTimes = [];
    this.keydowns = {};
  }

  keydown(key) {
    const now = performance.now();
    this.keydowns[key] = now;
    if (this.lastKeyTime) {
      this.intervals.push(now - this.lastKeyTime);
    }
    this.lastKeyTime = now;
  }

  keyup(key) {
    const now = performance.now();
    if (this.keydowns[key]) {
      this.holdTimes.push(now - this.keydowns[key]);
      delete this.keydowns[key];
    }
  }

  /**
   * Get typing profile summary.
   */
  getProfile() {
    if (this.intervals.length < 3) return null;

    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = arr => {
      const m = avg(arr);
      return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
    };

    return {
      avgKeypressInterval: Math.round(avg(this.intervals)),
      stdKeypressInterval: Math.round(std(this.intervals)),
      avgKeyHoldTime: Math.round(avg(this.holdTimes)),
      stdKeyHoldTime: Math.round(std(this.holdTimes)),
      totalKeystrokes: this.intervals.length + 1,
      wordsPerMinute: Math.round(
        (this.intervals.length / (avg(this.intervals) / 1000)) * 60 / 5
      ),
    };
  }
}

/**
 * Track behavioral signals beyond typing.
 */
export class BehaviorTracker {
  constructor() {
    this.sessionStart = Date.now();
    this.messageCount = 0;
    this.messageLengths = [];
    this.tosScrollDepth = 0;
    this.tosTimeMs = 0;
    this.timeToFirstMessage = null;
    this.timeToConsent = null;
  }

  recordConsent() {
    this.timeToConsent = Date.now() - this.sessionStart;
  }

  recordMessage(text) {
    if (this.messageCount === 0) {
      this.timeToFirstMessage = Date.now() - this.sessionStart;
    }
    this.messageCount++;
    this.messageLengths.push(text.length);
  }

  recordTosScroll(depth) {
    this.tosScrollDepth = Math.max(this.tosScrollDepth, depth);
  }

  getSummary() {
    const avg = this.messageLengths.length > 0
      ? Math.round(this.messageLengths.reduce((a, b) => a + b, 0) / this.messageLengths.length)
      : 0;

    return {
      sessionDurationMs: Date.now() - this.sessionStart,
      messageCount: this.messageCount,
      avgMessageLength: avg,
      timeToConsentMs: this.timeToConsent,
      timeToFirstMessageMs: this.timeToFirstMessage,
      tosScrollDepth: Math.round(this.tosScrollDepth * 100) + '%',
    };
  }
}
