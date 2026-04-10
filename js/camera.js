/**
 * Camera — Guided selfie capture
 *
 * Instead of live surveillance, we ask the user to take a selfie
 * doing the Silbo Gomero whistle gesture. The guide shows them
 * a photo of a real whistler to imitate. They perform for us
 * willingly — and the resulting portrait becomes part of their
 * dossier and the installation's receipt output.
 */

/**
 * Show the selfie capture overlay and return the captured image.
 *
 * @param {string} guideImageUrl - URL of the whistler example image
 * @returns {Promise<{ blob: Blob, dataUrl: string } | null>}
 */
export async function captureSelfie(guideImageUrl) {
  return new Promise((resolve) => {
    // Build the overlay
    const overlay = document.createElement('div');
    overlay.id = 'selfie-overlay';
    overlay.innerHTML = `
      <div id="selfie-content">
        <div id="selfie-header">TAKE YOUR SILBERO SELFIE</div>

        <div id="selfie-guide">
          <img id="selfie-guide-img" src="${guideImageUrl}" alt="Silbo whistle pose">
          <p>Make the Silbo whistle gesture with your hands, like this.</p>
        </div>

        <div id="selfie-viewfinder">
          <video id="selfie-video" playsinline muted autoplay></video>
          <canvas id="selfie-canvas" style="display:none"></canvas>
          <img id="selfie-preview" style="display:none">
        </div>

        <div id="selfie-controls">
          <button id="selfie-capture" class="selfie-btn">CAPTURE</button>
          <button id="selfie-retake" class="selfie-btn" style="display:none">RETAKE</button>
          <button id="selfie-accept" class="selfie-btn" style="display:none">USE THIS PHOTO</button>
          <button id="selfie-skip" class="selfie-btn-skip">Skip (no avatar)</button>
        </div>
      </div>
    `;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #selfie-overlay {
        position: fixed; top: 0; left: 0; right: 0; bottom: 0;
        background: #050505; z-index: 1000;
        display: flex; align-items: center; justify-content: center;
        padding: 20px;
      }
      #selfie-content {
        max-width: 480px; width: 100%; text-align: center;
      }
      #selfie-header {
        color: #999; font-size: 14px; letter-spacing: 3px;
        margin-bottom: 20px;
        font-family: 'Courier New', monospace;
      }
      #selfie-guide {
        margin-bottom: 16px;
      }
      #selfie-guide-img {
        width: 120px; height: auto; border: 1px solid #222;
        filter: grayscale(100%) contrast(1.2);
        margin-bottom: 8px;
      }
      #selfie-guide p {
        color: #555; font-size: 13px;
        font-family: 'Courier New', monospace;
        line-height: 1.5;
      }
      #selfie-viewfinder {
        width: 100%; max-width: 320px; margin: 0 auto 16px auto;
        aspect-ratio: 4/3; background: #0a0a0a;
        border: 2px solid #222; position: relative;
        overflow: hidden;
      }
      #selfie-video {
        width: 100%; height: 100%; object-fit: cover;
        transform: scaleX(-1);
      }
      #selfie-preview {
        width: 100%; height: 100%; object-fit: cover;
      }
      #selfie-controls {
        display: flex; flex-direction: column; gap: 8px;
        align-items: center;
      }
      .selfie-btn {
        width: 100%; max-width: 320px; padding: 14px;
        background: #1a1a1a; border: 2px solid #333;
        color: #aaa; font-family: 'Courier New', monospace;
        font-size: 16px; letter-spacing: 3px; cursor: pointer;
      }
      .selfie-btn:hover {
        background: #222; border-color: #555; color: #ddd;
      }
      .selfie-btn-skip {
        background: none; border: none;
        color: #333; font-family: 'Courier New', monospace;
        font-size: 12px; cursor: pointer; margin-top: 8px;
      }
      .selfie-btn-skip:hover { color: #555; }
    `;

    document.head.appendChild(style);
    document.body.appendChild(overlay);

    const video = overlay.querySelector('#selfie-video');
    const canvas = overlay.querySelector('#selfie-canvas');
    const preview = overlay.querySelector('#selfie-preview');
    const btnCapture = overlay.querySelector('#selfie-capture');
    const btnRetake = overlay.querySelector('#selfie-retake');
    const btnAccept = overlay.querySelector('#selfie-accept');
    const btnSkip = overlay.querySelector('#selfie-skip');

    let stream = null;
    let capturedBlob = null;
    let capturedDataUrl = null;

    // Start camera at higher resolution for reliable server-side face detection
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    }).then(s => {
      stream = s;
      video.srcObject = s;
    }).catch(() => {
      // Camera denied — show skip only
      btnCapture.style.display = 'none';
      overlay.querySelector('#selfie-guide p').textContent =
        'Camera not available. You can skip this step.';
    });

    btnCapture.addEventListener('click', () => {
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 960;
      const ctx = canvas.getContext('2d');
      // Mirror the image (front camera is mirrored)
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0);

      canvas.toBlob((blob) => {
        capturedBlob = blob;
        capturedDataUrl = URL.createObjectURL(blob);
        preview.src = capturedDataUrl;
        preview.style.display = 'block';
        video.style.display = 'none';
        btnCapture.style.display = 'none';
        btnRetake.style.display = 'block';
        btnAccept.style.display = 'block';
      }, 'image/jpeg', 0.92);
    });

    btnRetake.addEventListener('click', () => {
      preview.style.display = 'none';
      video.style.display = 'block';
      btnCapture.style.display = 'block';
      btnRetake.style.display = 'none';
      btnAccept.style.display = 'none';
      capturedBlob = null;
      capturedDataUrl = null;
    });

    function cleanup() {
      if (stream) stream.getTracks().forEach(t => t.stop());
      overlay.remove();
      style.remove();
    }

    btnAccept.addEventListener('click', () => {
      cleanup();
      resolve({ blob: capturedBlob, dataUrl: capturedDataUrl });
    });

    btnSkip.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
  });
}
