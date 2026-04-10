/**
 * Face Detection — Yellow targeting overlay on selfie photos
 *
 * Uses Chrome's built-in FaceDetector API when available.
 * Falls back to a simulated detection (assumes face is centered
 * in a selfie). Either way, the yellow box appears.
 *
 * The overlay includes:
 *   - Yellow bounding rectangle around each face
 *   - Corner brackets (targeting reticle style)
 *   - Crosshairs on detected features
 *   - Clinical labels with coordinates
 */

/**
 * Detect faces and draw targeting overlay on a canvas.
 * Returns the annotated canvas as a blob + detection metadata.
 *
 * @param {Blob} imageBlob - The selfie JPEG
 * @returns {{ blob: Blob, dataUrl: string, detections: Array }}
 */
export async function annotateWithFaceDetection(imageBlob) {
  const bmp = await createImageBitmap(imageBlob);
  const w = bmp.width;
  const h = bmp.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Draw the original image
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  // Detect faces
  let detections = [];
  try {
    if ('FaceDetector' in window) {
      const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 5 });
      const faces = await detector.detect(canvas);
      detections = faces.map(f => ({
        x: Math.round(f.boundingBox.x),
        y: Math.round(f.boundingBox.y),
        width: Math.round(f.boundingBox.width),
        height: Math.round(f.boundingBox.height),
        landmarks: (f.landmarks || []).map(lm => ({
          type: lm.type,
          x: Math.round(lm.locations[0]?.x || 0),
          y: Math.round(lm.locations[0]?.y || 0),
        })),
      }));
    }
  } catch (e) {
    // FaceDetector not supported or failed
  }

  // If no detections, find the face by skin-tone analysis
  if (detections.length === 0) {
    detections = [detectFaceBySkinTone(ctx, w, h)];
  }

  // Draw targeting overlays
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i];
    drawTargetingBox(ctx, d.x, d.y, d.width, d.height, i, w, h);
    drawLandmarks(ctx, d.landmarks);
    drawLabel(ctx, d, i, w);
  }

  // Scan line overlay for extra surveillance feel
  drawScanLines(ctx, w, h);

  // Convert to blob
  const annotatedBlob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

  return { blob: annotatedBlob, dataUrl, detections };
}

/**
 * Detect face region by scanning for skin-tone colored pixels.
 * Works across a range of skin tones by checking HSV ranges.
 * Returns a detection object with bounding box and estimated landmarks.
 */
function detectFaceBySkinTone(ctx, w, h) {
  // Downsample for speed
  const sw = 80;
  const sh = 60;
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  sctx.drawImage(ctx.canvas, 0, 0, sw, sh);
  const data = sctx.getImageData(0, 0, sw, sh).data;

  // Build a skin-tone heat map
  // Skin detection in RGB: R > 80, G > 40, B > 20, R > G, R > B,
  // (R - G) > 15, max(R,G,B) - min(R,G,B) > 15
  const skinMap = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (r > 80 && g > 40 && b > 20 && r > g && r > b &&
        (r - g) > 15 && (maxC - minC) > 15) {
      skinMap[i] = 1;
    }
  }

  // Find bounding box of the largest skin-tone cluster
  // Scan rows and columns to find the densest region
  let minX = sw, maxX = 0, minY = sh, maxY = 0;
  let skinCount = 0;

  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (skinMap[y * sw + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        skinCount++;
      }
    }
  }

  // Scale back to full image coords
  const scaleX = w / sw;
  const scaleY = h / sh;

  let faceX, faceY, faceW, faceH;

  if (skinCount > (sw * sh * 0.05)) {
    // Found enough skin pixels — use the bounding box with some padding
    const pad = 3;
    faceX = Math.max(0, (minX - pad)) * scaleX;
    faceY = Math.max(0, (minY - pad)) * scaleY;
    faceW = (maxX - minX + pad * 2) * scaleX;
    faceH = (maxY - minY + pad * 2) * scaleY;

    // Selfie faces are usually taller than wide — if the detection
    // is very wide (includes hands/body), narrow it
    if (faceW > faceH * 1.2) {
      const center = faceX + faceW / 2;
      faceW = faceH * 0.85;
      faceX = center - faceW / 2;
    }
  } else {
    // Very few skin pixels (dark environment, unusual lighting)
    // Fall back to centered assumption
    faceW = w * 0.42;
    faceH = h * 0.52;
    faceX = (w - faceW) / 2;
    faceY = h * 0.06;
  }

  // Estimate landmark positions within the face box
  const landmarks = [
    { type: 'eye',   x: Math.round(faceX + faceW * 0.32), y: Math.round(faceY + faceH * 0.33) },
    { type: 'eye',   x: Math.round(faceX + faceW * 0.68), y: Math.round(faceY + faceH * 0.33) },
    { type: 'nose',  x: Math.round(faceX + faceW * 0.50), y: Math.round(faceY + faceH * 0.52) },
    { type: 'mouth', x: Math.round(faceX + faceW * 0.50), y: Math.round(faceY + faceH * 0.72) },
  ];

  return {
    x: Math.round(faceX),
    y: Math.round(faceY),
    width: Math.round(faceW),
    height: Math.round(faceH),
    landmarks,
    skinPixels: skinCount,
    simulated: false,
  };
}

/**
 * Draw a targeting reticle box with corner brackets.
 */
function drawTargetingBox(ctx, x, y, w, h, idx, canvasW, canvasH) {
  const bracketLen = Math.min(w, h) * 0.2;
  const lineWidth = Math.max(1, Math.round(canvasW / 200));

  ctx.strokeStyle = '#ffcc00';
  ctx.lineWidth = lineWidth;
  ctx.shadowColor = 'rgba(255, 204, 0, 0.3)';
  ctx.shadowBlur = 4;

  // Main rectangle (thin)
  ctx.strokeRect(x, y, w, h);

  // Corner brackets (thick)
  ctx.lineWidth = lineWidth * 2;
  ctx.shadowBlur = 6;

  // Top-left
  ctx.beginPath();
  ctx.moveTo(x, y + bracketLen);
  ctx.lineTo(x, y);
  ctx.lineTo(x + bracketLen, y);
  ctx.stroke();

  // Top-right
  ctx.beginPath();
  ctx.moveTo(x + w - bracketLen, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + bracketLen);
  ctx.stroke();

  // Bottom-left
  ctx.beginPath();
  ctx.moveTo(x, y + h - bracketLen);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x + bracketLen, y + h);
  ctx.stroke();

  // Bottom-right
  ctx.beginPath();
  ctx.moveTo(x + w - bracketLen, y + h);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w, y + h - bracketLen);
  ctx.stroke();

  // Center crosshair
  const cx = x + w / 2;
  const cy = y + h / 2;
  const crossSize = Math.min(w, h) * 0.06;
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = 'rgba(255, 204, 0, 0.5)';
  ctx.beginPath();
  ctx.moveTo(cx - crossSize, cy);
  ctx.lineTo(cx + crossSize, cy);
  ctx.moveTo(cx, cy - crossSize);
  ctx.lineTo(cx, cy + crossSize);
  ctx.stroke();

  ctx.shadowBlur = 0;
}

/**
 * Draw crosshairs on facial landmarks (eyes, mouth, nose).
 */
function drawLandmarks(ctx, landmarks) {
  if (!landmarks) return;

  ctx.strokeStyle = 'rgba(255, 100, 100, 0.7)';
  ctx.lineWidth = 1;

  for (const lm of landmarks) {
    const size = 6;
    // Small crosshair
    ctx.beginPath();
    ctx.moveTo(lm.x - size, lm.y);
    ctx.lineTo(lm.x + size, lm.y);
    ctx.moveTo(lm.x, lm.y - size);
    ctx.lineTo(lm.x, lm.y + size);
    ctx.stroke();

    // Small circle
    ctx.beginPath();
    ctx.arc(lm.x, lm.y, size * 0.7, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * Draw clinical label with coordinates beneath the face box.
 */
function drawLabel(ctx, detection, idx, canvasW) {
  const fontSize = Math.max(9, Math.round(canvasW / 40));
  ctx.font = `${fontSize}px monospace`;
  ctx.fillStyle = 'rgba(255, 204, 0, 0.9)';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 3;

  const label = `FACE_${idx} [${detection.x},${detection.y} ${detection.width}x${detection.height}]`;
  ctx.fillText(label, detection.x, detection.y + detection.height + fontSize + 4);

  // Confidence (fake but unsettling)
  const conf = detection.simulated ? '87.3%' : '96.1%';
  ctx.fillStyle = 'rgba(255, 204, 0, 0.6)';
  ctx.fillText(`CONF: ${conf}`, detection.x, detection.y + detection.height + fontSize * 2 + 8);

  ctx.shadowBlur = 0;
}

/**
 * Subtle scan lines for surveillance camera aesthetic.
 */
function drawScanLines(ctx, w, h) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  for (let y = 0; y < h; y += 3) {
    ctx.fillRect(0, y, w, 1);
  }
}
