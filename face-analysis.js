/**
 * Server-side Face Analysis
 *
 * Uses @vladmandic/face-api (TensorFlow.js) to extract:
 *   - Age, gender, expression (from ML models)
 *   - 68 facial landmarks
 *   - 128-dim face descriptor (for cross-session matching)
 *
 * Custom pixel analysis on top of landmarks:
 *   - Eye color, hair color, skin tone (Fitzpatrick scale)
 *   - Glasses detection, facial hair, face shape
 *   - Facial symmetry score, head pose, interpupillary distance
 */

const path = require('path');
const canvas = require('canvas');
const { createCanvas, loadImage } = canvas;

// tfjs-node must be loaded BEFORE face-api in Node environments
const tf = require('@tensorflow/tfjs-node');
const fapi = require('@vladmandic/face-api');

// Patch face-api to use node-canvas instead of browser DOM
fapi.env.monkeyPatch({ Canvas: canvas.Canvas, Image: canvas.Image, ImageData: canvas.ImageData });

const MODEL_DIR = path.join(__dirname, 'node_modules/@vladmandic/face-api/model');

let modelsLoaded = false;

/**
 * Load all face-api models. Call once at startup.
 */
async function loadModels() {
  if (modelsLoaded) return;

  await fapi.tf.setBackend('tensorflow');
  await fapi.tf.ready();

  await fapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await fapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
  await fapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
  await fapi.nets.ageGenderNet.loadFromDisk(MODEL_DIR);
  await fapi.nets.faceExpressionNet.loadFromDisk(MODEL_DIR);

  modelsLoaded = true;
  console.log('  Face analysis models loaded.');
  console.log(`  TF backend: ${fapi.tf.getBackend()}`);
}

/**
 * Analyze a JPEG image buffer. Returns a rich analysis object or null on failure.
 *
 * @param {Buffer} jpegBuffer - Raw JPEG bytes
 * @returns {Object|null} Analysis results
 */
async function analyzeFace(jpegBuffer) {
  if (!modelsLoaded) {
    console.warn('  Face analysis: models not loaded yet.');
    return null;
  }

  try {
    // Load image into node-canvas
    const img = await loadImage(jpegBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Run full detection pipeline with relaxed confidence threshold
    // Default is 0.5 — we lower it so partial/angled faces still register
    const detectorOptions = new fapi.SsdMobilenetv1Options({ minConfidence: 0.2, maxResults: 5 });
    const detections = await fapi
      .detectAllFaces(canvas, detectorOptions)
      .withFaceLandmarks()
      .withFaceDescriptors()
      .withFaceExpressions()
      .withAgeAndGender();

    if (!detections || detections.length === 0) {
      return { faces: [], imageWidth: img.width, imageHeight: img.height };
    }

    // Get raw pixel data for custom analysis
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const pixels = imageData.data;

    const faces = detections.map((det, i) => {
      const box = det.detection.box;
      const landmarks = det.landmarks;
      const pts = landmarks.positions;
      const expressions = det.expressions;
      const age = det.age;
      const gender = det.gender;
      const genderProbability = det.genderProbability;
      const descriptor = det.descriptor; // Float32Array[128]

      // Dominant expression
      const exprEntries = Object.entries(expressions).sort((a, b) => b[1] - a[1]);
      const dominantExpression = exprEntries[0][0];

      // Eye landmarks: left eye = pts 36-41, right eye = pts 42-47
      const leftEye = pts.slice(36, 42);
      const rightEye = pts.slice(42, 48);
      const leftEyeCenter = centerOf(leftEye);
      const rightEyeCenter = centerOf(rightEye);

      // Interpupillary distance (pixels)
      const ipd = dist(leftEyeCenter, rightEyeCenter);

      // Head pose estimation from landmark geometry
      const headPose = estimateHeadPose(pts, img.width, img.height);

      // Facial symmetry: compare left/right landmark distances from center
      const symmetry = computeSymmetry(pts);

      // Face shape from jawline + face proportions
      const faceShape = classifyFaceShape(pts);

      // Pixel-based analysis
      const eyeColor = sampleEyeColor(pixels, img.width, leftEye, rightEye);
      const skinTone = sampleSkinTone(pixels, img.width, pts);
      const hairColor = sampleHairColor(pixels, img.width, img.height, box);
      const glasses = detectGlasses(pixels, img.width, leftEye, rightEye);
      const facialHair = detectFacialHair(pixels, img.width, pts);

      return {
        index: i,
        box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
        age: Math.round(age * 10) / 10,
        gender,
        genderConfidence: Math.round(genderProbability * 1000) / 1000,
        expression: {
          dominant: dominantExpression,
          scores: Object.fromEntries(exprEntries.map(([k, v]) => [k, Math.round(v * 1000) / 1000])),
        },
        landmarks: {
          count: pts.length,
          leftEyeCenter: roundPt(leftEyeCenter),
          rightEyeCenter: roundPt(rightEyeCenter),
          noseTip: roundPt(pts[30]),
          mouthCenter: roundPt(centerOf(pts.slice(48, 68))),
          jawline: pts.slice(0, 17).map(roundPt),
        },
        ipd: Math.round(ipd * 10) / 10,
        headPose,
        symmetry: Math.round(symmetry * 1000) / 1000,
        faceShape,
        eyeColor,
        skinTone,
        hairColor,
        glasses,
        facialHair,
        descriptor: Array.from(descriptor).map(v => Math.round(v * 10000) / 10000),
      };
    });

    return {
      faces,
      imageWidth: img.width,
      imageHeight: img.height,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error('  Face analysis error:', e.message);
    return null;
  }
}

// ---- Geometry helpers ----

function centerOf(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function roundPt(p) {
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
}

/**
 * Estimate head pose (yaw, pitch, roll) from 2D landmarks.
 * Uses nose tip, eye centers, and mouth center relative to face bounding box.
 */
function estimateHeadPose(pts, imgW, imgH) {
  const leftEyeC = centerOf(pts.slice(36, 42));
  const rightEyeC = centerOf(pts.slice(42, 48));
  const noseTip = pts[30];
  const mouthC = centerOf(pts.slice(48, 68));
  const faceC = centerOf([leftEyeC, rightEyeC, noseTip, mouthC]);

  // Yaw: nose offset from face center, normalized by eye distance
  const eyeDist = dist(leftEyeC, rightEyeC);
  const yaw = ((noseTip.x - faceC.x) / eyeDist) * 45; // rough degrees

  // Pitch: vertical ratio of nose-to-eyes vs nose-to-mouth
  const eyesMidY = (leftEyeC.y + rightEyeC.y) / 2;
  const noseToEyes = noseTip.y - eyesMidY;
  const noseToMouth = mouthC.y - noseTip.y;
  const ratio = noseToEyes / (noseToMouth || 1);
  const pitch = (ratio - 1.0) * 30; // rough degrees

  // Roll: angle between eyes
  const roll = Math.atan2(rightEyeC.y - leftEyeC.y, rightEyeC.x - leftEyeC.x) * (180 / Math.PI);

  return {
    yaw: Math.round(yaw * 10) / 10,
    pitch: Math.round(pitch * 10) / 10,
    roll: Math.round(roll * 10) / 10,
  };
}

/**
 * Compute facial symmetry score (0-1, where 1 = perfect symmetry).
 * Compares distances of left/right landmark pairs from the nose bridge center.
 */
function computeSymmetry(pts) {
  const noseBridge = pts[27]; // top of nose bridge
  // Landmark pairs: (0,16), (1,15), (2,14), (3,13), (4,12), (5,11), (6,10), (7,9)
  // Plus eyes: (36,45), (37,44), (38,43), (39,42), (40,47), (41,46)
  const pairs = [
    [0, 16], [1, 15], [2, 14], [3, 13], [4, 12], [5, 11], [6, 10], [7, 9],
    [36, 45], [37, 44], [38, 43], [39, 42], [40, 47], [41, 46],
    [17, 26], [18, 25], [19, 24], [20, 23], [21, 22], // eyebrows
    [31, 35], [32, 34], // nose wings
    [48, 54], [49, 53], [50, 52], [59, 55], [58, 56], // mouth
  ];

  let totalDiff = 0;
  let totalDist = 0;
  for (const [li, ri] of pairs) {
    const dl = dist(pts[li], noseBridge);
    const dr = dist(pts[ri], noseBridge);
    totalDiff += Math.abs(dl - dr);
    totalDist += (dl + dr) / 2;
  }

  return totalDist > 0 ? Math.max(0, 1 - totalDiff / totalDist) : 0;
}

/**
 * Classify face shape from jawline and face proportions.
 */
function classifyFaceShape(pts) {
  const jawWidth = dist(pts[0], pts[16]);
  const cheekWidth = dist(pts[3], pts[13]);
  const faceHeight = dist(centerOf([pts[19], pts[24]]), pts[8]); // brow to chin

  const ratio = faceHeight / jawWidth;
  const taperRatio = cheekWidth / jawWidth;

  if (ratio > 1.4) return 'oblong';
  if (ratio < 0.95) return 'round';
  if (taperRatio > 0.92 && ratio > 1.1) return 'square';
  if (taperRatio < 0.85) return 'heart';
  if (ratio > 1.15) return 'oval';
  return 'round';
}

// ---- Pixel analysis helpers ----

function getPixel(pixels, w, x, y) {
  x = Math.round(Math.max(0, Math.min(x, w - 1)));
  y = Math.round(Math.max(0, y));
  const i = (y * w + x) * 4;
  return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
}

/**
 * Sample iris region pixels to estimate eye color.
 */
function sampleEyeColor(pixels, imgW, leftEye, rightEye) {
  const samples = [];

  for (const eye of [leftEye, rightEye]) {
    const c = centerOf(eye);
    // Sample a small grid around iris center
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        samples.push(getPixel(pixels, imgW, c.x + dx, c.y + dy));
      }
    }
  }

  const avg = {
    r: samples.reduce((s, p) => s + p.r, 0) / samples.length,
    g: samples.reduce((s, p) => s + p.g, 0) / samples.length,
    b: samples.reduce((s, p) => s + p.b, 0) / samples.length,
  };

  return classifyEyeColor(avg);
}

function classifyEyeColor(rgb) {
  const { r, g, b } = rgb;
  const brightness = (r + g + b) / 3;

  if (brightness < 60) return { color: 'dark brown', rgb };
  if (brightness < 90) {
    if (b > r && b > g) return { color: 'dark blue', rgb };
    return { color: 'brown', rgb };
  }
  if (b > r + 20 && b > g + 10) return { color: 'blue', rgb };
  if (g > r + 10 && g > b + 10) return { color: 'green', rgb };
  if (g > b && r > b && Math.abs(r - g) < 30) return { color: 'hazel', rgb };
  if (r > g + 20 && r > b + 30) return { color: 'amber', rgb };
  if (brightness > 140) return { color: 'light blue', rgb };
  return { color: 'brown', rgb };
}

/**
 * Sample skin region to estimate Fitzpatrick skin tone.
 */
function sampleSkinTone(pixels, imgW, pts) {
  // Sample from cheek regions (between eye and jawline)
  const cheekPts = [
    { x: (pts[1].x + pts[31].x) / 2, y: (pts[1].y + pts[31].y) / 2 },
    { x: (pts[15].x + pts[35].x) / 2, y: (pts[15].y + pts[35].y) / 2 },
    // Forehead center
    { x: pts[27].x, y: pts[27].y - (pts[30].y - pts[27].y) * 0.5 },
  ];

  const samples = [];
  for (const pt of cheekPts) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        samples.push(getPixel(pixels, imgW, pt.x + dx, pt.y + dy));
      }
    }
  }

  const avg = {
    r: samples.reduce((s, p) => s + p.r, 0) / samples.length,
    g: samples.reduce((s, p) => s + p.g, 0) / samples.length,
    b: samples.reduce((s, p) => s + p.b, 0) / samples.length,
  };

  return classifySkinTone(avg);
}

function classifySkinTone(rgb) {
  const { r, g, b } = rgb;
  // ITA (Individual Typology Angle) approximation
  const L = 0.299 * r + 0.587 * g + 0.114 * b; // luminance

  let fitzpatrick, label;
  if (L > 200) { fitzpatrick = 'I'; label = 'very light'; }
  else if (L > 170) { fitzpatrick = 'II'; label = 'light'; }
  else if (L > 140) { fitzpatrick = 'III'; label = 'medium light'; }
  else if (L > 110) { fitzpatrick = 'IV'; label = 'medium'; }
  else if (L > 75) { fitzpatrick = 'V'; label = 'medium dark'; }
  else { fitzpatrick = 'VI'; label = 'dark'; }

  return { fitzpatrick, label, luminance: Math.round(L), rgb };
}

/**
 * Sample region above forehead for hair color.
 */
function sampleHairColor(pixels, imgW, imgH, box) {
  const sampleY = Math.max(0, box.y - box.height * 0.3);
  const centerX = box.x + box.width / 2;

  const samples = [];
  for (let dx = -15; dx <= 15; dx += 3) {
    for (let dy = 0; dy < 10; dy += 2) {
      const y = Math.min(sampleY + dy, imgH - 1);
      samples.push(getPixel(pixels, imgW, centerX + dx, y));
    }
  }

  if (samples.length === 0) return { color: 'unknown' };

  const avg = {
    r: samples.reduce((s, p) => s + p.r, 0) / samples.length,
    g: samples.reduce((s, p) => s + p.g, 0) / samples.length,
    b: samples.reduce((s, p) => s + p.b, 0) / samples.length,
  };

  return classifyHairColor(avg);
}

function classifyHairColor(rgb) {
  const { r, g, b } = rgb;
  const brightness = (r + g + b) / 3;

  if (brightness < 40) return { color: 'black', rgb };
  if (brightness < 80) {
    if (r > g + 10 && r > b + 15) return { color: 'dark auburn', rgb };
    return { color: 'dark brown', rgb };
  }
  if (brightness < 120) {
    if (r > g + 15 && r > b + 20) return { color: 'auburn', rgb };
    return { color: 'brown', rgb };
  }
  if (brightness < 160) {
    if (r > g + 10 && r > b + 20) return { color: 'red', rgb };
    return { color: 'light brown', rgb };
  }
  if (r > 180 && g > 160 && b < 120) return { color: 'blonde', rgb };
  if (brightness > 200) return { color: 'platinum/white', rgb };
  return { color: 'light brown', rgb };
}

/**
 * Detect glasses by analyzing brightness variance in the eye bridge region.
 * Glasses frames create distinct dark edges across the nose bridge.
 */
function detectGlasses(pixels, imgW, leftEye, rightEye) {
  const leftC = centerOf(leftEye);
  const rightC = centerOf(rightEye);

  // Sample along the bridge between eyes
  const bridgeSamples = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = leftC.x + (rightC.x - leftC.x) * t;
    const y = leftC.y + (rightC.y - leftC.y) * t;
    const p = getPixel(pixels, imgW, x, y);
    bridgeSamples.push((p.r + p.g + p.b) / 3);
  }

  // Also sample above and below the bridge for comparison
  const aboveSamples = [];
  const belowSamples = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = leftC.x + (rightC.x - leftC.x) * t;
    const y = leftC.y + (rightC.y - leftC.y) * t;
    const above = getPixel(pixels, imgW, x, y - 8);
    const below = getPixel(pixels, imgW, x, y + 8);
    aboveSamples.push((above.r + above.g + above.b) / 3);
    belowSamples.push((below.r + below.g + below.b) / 3);
  }

  // High variance in bridge region + dark dips suggest frames
  const variance = computeVariance(bridgeSamples);
  const aboveVar = computeVariance(aboveSamples);
  const bridgeMean = bridgeSamples.reduce((a, b) => a + b, 0) / bridgeSamples.length;
  const aboveMean = aboveSamples.reduce((a, b) => a + b, 0) / aboveSamples.length;

  // Glasses tend to create higher variance and darker bridge compared to above
  const likely = variance > aboveVar * 1.5 || (bridgeMean < aboveMean - 20 && variance > 100);

  return { detected: likely, confidence: likely ? 0.7 : 0.3 };
}

function computeVariance(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

/**
 * Detect facial hair by analyzing the region below the nose and along the jawline.
 * Compares darkness/texture of lower face vs. cheek regions.
 */
function detectFacialHair(pixels, imgW, pts) {
  const noseTip = pts[33]; // bottom of nose
  const chin = pts[8];
  const mouthBottom = pts[57];

  // Sample below-nose region (mustache area)
  const mustacheSamples = [];
  for (let dx = -10; dx <= 10; dx += 2) {
    for (let dy = 2; dy <= 8; dy += 2) {
      const p = getPixel(pixels, imgW, noseTip.x + dx, noseTip.y + dy);
      mustacheSamples.push((p.r + p.g + p.b) / 3);
    }
  }

  // Sample chin/beard area
  const beardSamples = [];
  const beardY = mouthBottom.y + (chin.y - mouthBottom.y) * 0.4;
  for (let dx = -12; dx <= 12; dx += 3) {
    for (let dy = -3; dy <= 3; dy += 2) {
      const p = getPixel(pixels, imgW, chin.x + dx, beardY + dy);
      beardSamples.push((p.r + p.g + p.b) / 3);
    }
  }

  // Sample cheek for comparison (should be smoother/lighter if clean-shaven)
  const cheekSamples = [];
  const cheekPt = { x: (pts[1].x + pts[31].x) / 2, y: (pts[1].y + pts[31].y) / 2 };
  for (let dx = -8; dx <= 8; dx += 2) {
    for (let dy = -4; dy <= 4; dy += 2) {
      const p = getPixel(pixels, imgW, cheekPt.x + dx, cheekPt.y + dy);
      cheekSamples.push((p.r + p.g + p.b) / 3);
    }
  }

  const mustacheMean = mustacheSamples.reduce((a, b) => a + b, 0) / mustacheSamples.length;
  const beardMean = beardSamples.reduce((a, b) => a + b, 0) / beardSamples.length;
  const cheekMean = cheekSamples.reduce((a, b) => a + b, 0) / cheekSamples.length;

  const mustacheVar = computeVariance(mustacheSamples);
  const beardVar = computeVariance(beardSamples);

  // Facial hair tends to be darker than cheeks and have higher texture variance
  const mustacheLikely = mustacheMean < cheekMean - 15 || mustacheVar > 200;
  const beardLikely = beardMean < cheekMean - 15 || beardVar > 200;

  return {
    mustache: mustacheLikely,
    beard: beardLikely,
    confidence: (mustacheLikely || beardLikely) ? 0.65 : 0.4,
  };
}

module.exports = { loadModels, analyzeFace };
