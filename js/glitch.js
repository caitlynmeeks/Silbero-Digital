/**
 * Glitch Visuals — VHS/CRT corruption effects for Silbo whistler imagery
 *
 * Renders glitched images/video of Silbo Gomero whistlers on a canvas.
 * Effects triggered during modem transmission/reception:
 *   - Scan lines (CRT phosphor rows)
 *   - Horizontal slice displacement (VHS tracking errors)
 *   - RGB channel separation
 *   - Block corruption (random rectangles copied to wrong positions)
 *   - Static/snow bursts
 *   - Brightness flicker synced to modem audio
 *
 * When idle, displays a slowly drifting, lightly glitched still image.
 * During transmission, glitch intensity increases dramatically.
 */

export class GlitchRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.width = canvas.width;
    this.height = canvas.height;
    this.sourceImage = null;
    this.sourceImages = [];   // Array of loaded images to cycle through
    this.currentImageIdx = 0;
    this.intensity = 0;       // 0 = idle, 1 = full glitch
    this.targetIntensity = 0;
    this.animFrame = null;
    this.time = 0;
    this.lastSwapTime = 0;

    // Load real whistler images, fall back to placeholder
    this.loadWhistlerImages();
  }

  /**
   * Load the real Silbo Gomero whistler photographs.
   * Falls back to procedural placeholder if images can't be loaded.
   */
  async loadWhistlerImages() {
    const imagePaths = [
      'images/whistler1.jpg',
      'images/whistler3.jpg',
      'images/whistler4.jpg',
    ];

    for (const path of imagePaths) {
      try {
        await this.loadImage(path);
      } catch (e) {
        console.warn(`Failed to load ${path}:`, e);
      }
    }

    if (this.sourceImages.length > 0) {
      this.sourceImage = this.sourceImages[0];
    } else {
      this.generatePlaceholder();
    }
  }

  /**
   * Swap to the next image in the collection.
   * Called during high-intensity glitch for dramatic effect.
   */
  nextImage() {
    if (this.sourceImages.length <= 1) return;
    this.currentImageIdx = (this.currentImageIdx + 1) % this.sourceImages.length;
    this.sourceImage = this.sourceImages[this.currentImageIdx];
  }

  /**
   * Generate a procedural silhouette image — a figure in profile
   * with hands cupped around mouth (whistling pose).
   */
  generatePlaceholder() {
    const w = this.width;
    const h = this.height;
    const offscreen = new OffscreenCanvas(w, h);
    const ctx = offscreen.getContext('2d');

    // Dark background with subtle gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#0a0a0a');
    grad.addColorStop(1, '#151515');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Mountain/landscape silhouette at bottom
    ctx.fillStyle = '#0d0d0d';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 20) {
      const y = h - 40 - Math.sin(x * 0.01) * 30 - Math.sin(x * 0.037) * 15;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.fill();

    // Whistler figure — simple geometric silhouette
    const cx = w * 0.5;
    const cy = h * 0.4;

    ctx.fillStyle = '#222';

    // Head
    ctx.beginPath();
    ctx.arc(cx, cy - 40, 22, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy - 18);
    ctx.lineTo(cx + 15, cy - 18);
    ctx.lineTo(cx + 20, cy + 50);
    ctx.lineTo(cx - 22, cy + 50);
    ctx.fill();

    // Arms raised to mouth (whistling pose)
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#222';
    ctx.lineCap = 'round';

    // Left arm
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.quadraticCurveTo(cx - 35, cy - 20, cx - 8, cy - 42);
    ctx.stroke();

    // Right arm
    ctx.beginPath();
    ctx.moveTo(cx + 13, cy);
    ctx.quadraticCurveTo(cx + 32, cy - 20, cx + 5, cy - 42);
    ctx.stroke();

    // Hands near mouth
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(cx - 4, cy - 44, 6, 0, Math.PI * 2);
    ctx.arc(cx + 4, cy - 44, 6, 0, Math.PI * 2);
    ctx.fill();

    // "SILBO" text — partially degraded
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('S I L B O', cx, h - 15);

    this.sourceImage = offscreen.transferToImageBitmap();
  }

  /**
   * Load an external image and add it to the image collection.
   */
  async loadImage(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    return new Promise((resolve, reject) => {
      img.onload = () => {
        const offscreen = new OffscreenCanvas(this.width, this.height);
        const ctx = offscreen.getContext('2d');

        // Desaturate to grayscale for monochrome aesthetic
        ctx.filter = 'grayscale(100%) contrast(1.2) brightness(0.8)';

        // Fill canvas, maintaining aspect ratio (cover mode)
        const scale = Math.max(this.width / img.width, this.height / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const x = (this.width - w) / 2;
        const y = (this.height - h) / 2;
        ctx.drawImage(img, x, y, w, h);

        const bitmap = offscreen.transferToImageBitmap();
        this.sourceImages.push(bitmap);
        resolve();
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  /**
   * Set glitch intensity. Ramps smoothly to target.
   * 0 = gentle idle drift, 1 = full chaos during transmission.
   */
  setIntensity(value) {
    this.targetIntensity = Math.max(0, Math.min(1, value));
  }

  /**
   * Start the render loop.
   */
  start() {
    const render = () => {
      this.time += 0.016; // ~60fps
      // Smooth intensity ramp
      this.intensity += (this.targetIntensity - this.intensity) * 0.08;
      this.render();
      this.animFrame = requestAnimationFrame(render);
    };
    render();
  }

  /**
   * Stop rendering.
   */
  stop() {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = null;
    }
  }

  /**
   * Main render pass.
   */
  render() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const t = this.time;
    const intensity = this.intensity;

    // Draw source image
    if (this.sourceImage) {
      ctx.drawImage(this.sourceImage, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);
    }

    // ---- GLITCH EFFECTS ----

    // Swap images during intense glitch (every ~2 seconds)
    if (intensity > 0.7 && t - this.lastSwapTime > 2) {
      this.nextImage();
      this.lastSwapTime = t;
    }

    // Always-on: subtle scan lines
    this.drawScanLines(ctx, w, h, 0.15 + intensity * 0.3);

    // Idle drift: slow horizontal displacement
    if (intensity < 0.3) {
      this.drawSliceDisplacement(ctx, w, h, 2 + intensity * 5, 0.02);
    }

    // Active: heavy slice displacement (VHS tracking)
    if (intensity > 0.2) {
      const sliceIntensity = (intensity - 0.2) / 0.8;
      this.drawSliceDisplacement(ctx, w, h, sliceIntensity * 40, sliceIntensity * 0.3);
    }

    // Active: RGB channel separation
    if (intensity > 0.3) {
      const rgbAmount = (intensity - 0.3) / 0.7;
      this.drawRGBSplit(ctx, w, h, rgbAmount * 8);
    }

    // Active: block corruption
    if (intensity > 0.5) {
      const blockIntensity = (intensity - 0.5) / 0.5;
      this.drawBlockCorruption(ctx, w, h, Math.floor(blockIntensity * 6));
    }

    // Active: static/snow bursts
    if (intensity > 0.4) {
      const snowIntensity = (intensity - 0.4) / 0.6;
      this.drawStaticBurst(ctx, w, h, snowIntensity * 0.4);
    }

    // Active: brightness flicker
    if (intensity > 0.1) {
      const flicker = Math.sin(t * 30) * intensity * 0.15;
      ctx.fillStyle = `rgba(${flicker > 0 ? 255 : 0},${flicker > 0 ? 255 : 0},${flicker > 0 ? 255 : 0},${Math.abs(flicker)})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Occasional full-frame white flash during intense glitch
    if (intensity > 0.8 && Math.random() < 0.03) {
      ctx.fillStyle = `rgba(200,200,200,${0.1 + Math.random() * 0.15})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /**
   * CRT scan lines — horizontal dark bands.
   */
  drawScanLines(ctx, w, h, opacity) {
    ctx.fillStyle = `rgba(0,0,0,${opacity})`;
    for (let y = 0; y < h; y += 3) {
      ctx.fillRect(0, y, w, 1);
    }
  }

  /**
   * VHS tracking error — horizontal slices displaced sideways.
   */
  drawSliceDisplacement(ctx, w, h, maxShift, probability) {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    for (let y = 0; y < h; y++) {
      if (Math.random() > probability) continue;

      const sliceHeight = 1 + Math.floor(Math.random() * 4);
      const shift = Math.floor((Math.random() - 0.5) * maxShift * 2);

      for (let dy = 0; dy < sliceHeight && y + dy < h; dy++) {
        const row = y + dy;
        // Shift this row
        const rowStart = row * w * 4;
        const temp = new Uint8ClampedArray(w * 4);
        for (let x = 0; x < w; x++) {
          const srcX = ((x - shift) % w + w) % w;
          temp[x * 4] = data[rowStart + srcX * 4];
          temp[x * 4 + 1] = data[rowStart + srcX * 4 + 1];
          temp[x * 4 + 2] = data[rowStart + srcX * 4 + 2];
          temp[x * 4 + 3] = data[rowStart + srcX * 4 + 3];
        }
        data.set(temp, rowStart);
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /**
   * RGB channel separation — offset red and blue channels.
   */
  drawRGBSplit(ctx, w, h, amount) {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const copy = new Uint8ClampedArray(data);
    const shift = Math.floor(amount);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        // Shift red channel left
        const srcR = (y * w + Math.min(x + shift, w - 1)) * 4;
        data[idx] = copy[srcR];
        // Shift blue channel right
        const srcB = (y * w + Math.max(x - shift, 0)) * 4;
        data[idx + 2] = copy[srcB + 2];
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /**
   * Block corruption — random rectangles copied to wrong positions.
   */
  drawBlockCorruption(ctx, w, h, count) {
    for (let i = 0; i < count; i++) {
      const bw = 20 + Math.floor(Math.random() * 80);
      const bh = 5 + Math.floor(Math.random() * 30);
      const srcX = Math.floor(Math.random() * (w - bw));
      const srcY = Math.floor(Math.random() * (h - bh));
      const dstX = srcX + Math.floor((Math.random() - 0.5) * 60);
      const dstY = srcY + Math.floor((Math.random() - 0.5) * 20);

      try {
        const block = ctx.getImageData(srcX, srcY, bw, bh);
        ctx.putImageData(block, dstX, dstY);
      } catch (e) {
        // Out of bounds, skip
      }
    }
  }

  /**
   * Static/snow — random white noise pixels.
   */
  drawStaticBurst(ctx, w, h, density) {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      if (Math.random() < density) {
        const v = Math.floor(Math.random() * 180);
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }
}
