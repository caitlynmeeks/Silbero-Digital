/**
 * Thermal Printer — ESC/POS output via WebSerial or WebUSB
 *
 * Drives a standard ESC/POS thermal receipt printer (58mm or 80mm) for
 * physical message output. Each received message prints on the receipt
 * paper with source terminal ID and timestamp.
 *
 * Supported connection methods:
 * - WebSerial API (USB-to-serial adapters, most common)
 * - WebUSB API (direct USB thermal printers)
 *
 * The aesthetic: messages appear on curling thermal paper in a cistern.
 */

// ESC/POS command constants
const ESC = 0x1B;
const GS = 0x1D;
const LF = 0x0A;

const CMD = {
  INIT:           [ESC, 0x40],                    // Initialize printer
  ALIGN_LEFT:     [ESC, 0x61, 0x00],
  ALIGN_CENTER:   [ESC, 0x61, 0x01],
  BOLD_ON:        [ESC, 0x45, 0x01],
  BOLD_OFF:       [ESC, 0x45, 0x00],
  DOUBLE_HEIGHT:  [GS, 0x21, 0x01],              // Double height
  NORMAL_SIZE:    [GS, 0x21, 0x00],              // Normal size
  UNDERLINE_ON:   [ESC, 0x2D, 0x01],
  UNDERLINE_OFF:  [ESC, 0x2D, 0x00],
  FEED_LINES:     (n) => [ESC, 0x64, n],         // Feed n lines
  CUT_PARTIAL:    [GS, 0x56, 0x01],              // Partial cut
  INVERSE_ON:     [GS, 0x42, 0x01],              // White on black
  INVERSE_OFF:    [GS, 0x42, 0x00],
};

export class ThermalPrinter {
  constructor() {
    this.port = null;       // WebSerial port
    this.device = null;     // WebUSB device
    this.writer = null;
    this.connected = false;
    this.mode = null;       // 'serial' or 'usb'
  }

  /**
   * Connect to a thermal printer via WebSerial.
   * Prompts the user to select a serial port.
   */
  async connectSerial() {
    if (!('serial' in navigator)) {
      throw new Error('WebSerial not supported in this browser');
    }

    this.port = await navigator.serial.requestPort();
    await this.port.open({
      baudRate: 9600,       // Most common for thermal printers
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
    });

    this.writer = this.port.writable.getWriter();
    this.mode = 'serial';
    this.connected = true;

    // Initialize printer
    await this.sendBytes(CMD.INIT);
    return true;
  }

  /**
   * Connect to a thermal printer via WebUSB.
   * Prompts the user to select a USB device.
   */
  async connectUSB() {
    if (!('usb' in navigator)) {
      throw new Error('WebUSB not supported in this browser');
    }

    this.device = await navigator.usb.requestDevice({
      filters: [
        // Common thermal printer vendor IDs
        { vendorId: 0x0416 },  // Winbond (many generic printers)
        { vendorId: 0x0483 },  // STMicroelectronics
        { vendorId: 0x04B8 },  // Epson
        { vendorId: 0x0525 },  // Netchip
        { vendorId: 0x1FC9 },  // NXP (some Chinese printers)
      ]
    });

    await this.device.open();
    await this.device.selectConfiguration(1);
    await this.device.claimInterface(0);

    this.mode = 'usb';
    this.connected = true;

    await this.sendBytes(CMD.INIT);
    return true;
  }

  /**
   * Auto-detect and connect via either Serial or USB.
   */
  async connect() {
    // Try Serial first (more common for thermal printers)
    try {
      return await this.connectSerial();
    } catch (e) {
      // Serial failed or was cancelled — try USB
      try {
        return await this.connectUSB();
      } catch (e2) {
        throw new Error('No printer connected. Tried Serial and USB.');
      }
    }
  }

  /**
   * Send raw bytes to the printer.
   */
  async sendBytes(bytes) {
    if (!this.connected) return;

    const data = new Uint8Array(bytes);

    if (this.mode === 'serial') {
      await this.writer.write(data);
    } else if (this.mode === 'usb') {
      // Find the bulk OUT endpoint
      const iface = this.device.configuration.interfaces[0];
      const alt = iface.alternates[0];
      const endpoint = alt.endpoints.find(e => e.direction === 'out');
      if (endpoint) {
        await this.device.transferOut(endpoint.endpointNumber, data);
      }
    }
  }

  /**
   * Send a text string to the printer (encoded as ASCII/Latin-1).
   */
  async sendText(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      bytes.push(text.charCodeAt(i) & 0xFF);
    }
    await this.sendBytes(bytes);
  }

  /**
   * Print a received Silbo message on the thermal receipt.
   *
   * Format:
   *   ---- TERMINAL 03 ----
   *   18:42:07
   *
   *   the message text here
   *   displayed in large type
   *
   *   [confidence: 87%]
   *   ____________________
   *
   * @param {string} text - The decoded message
   * @param {number} sourceTerminal - Which terminal sent it
   * @param {number} confidence - Decode confidence 0-1
   */
  async printMessage(text, sourceTerminal, confidence = 1.0) {
    if (!this.connected) return;

    const now = new Date();
    const timeStr = now.toTimeString().slice(0, 8);
    const termStr = String(sourceTerminal).padStart(2, '0');
    const confStr = Math.round(confidence * 100);

    // Header
    await this.sendBytes(CMD.ALIGN_CENTER);
    await this.sendBytes(CMD.BOLD_ON);
    await this.sendText(`---- TERMINAL ${termStr} ----`);
    await this.sendBytes([LF]);
    await this.sendBytes(CMD.BOLD_OFF);
    await this.sendText(timeStr);
    await this.sendBytes([LF, LF]);

    // Message body — double height for readability
    await this.sendBytes(CMD.ALIGN_LEFT);
    await this.sendBytes(CMD.DOUBLE_HEIGHT);
    await this.sendText(text);
    await this.sendBytes([LF]);
    await this.sendBytes(CMD.NORMAL_SIZE);
    await this.sendBytes([LF]);

    // Confidence footer
    await this.sendBytes(CMD.ALIGN_CENTER);
    if (confidence < 0.6) {
      await this.sendText(`[signal weak: ${confStr}%]`);
    } else {
      await this.sendText(`[${confStr}%]`);
    }
    await this.sendBytes([LF]);

    // Separator
    await this.sendText('____________________');
    await this.sendBytes(CMD.FEED_LINES(3));

    // Partial cut if printer supports it
    try {
      await this.sendBytes(CMD.CUT_PARTIAL);
    } catch (_) {
      // Not all printers support auto-cut
    }
  }

  /**
   * Print a system status line (for startup, errors, etc).
   */
  async printStatus(statusText) {
    if (!this.connected) return;

    await this.sendBytes(CMD.ALIGN_CENTER);
    await this.sendBytes(CMD.BOLD_ON);
    await this.sendText(`[${statusText}]`);
    await this.sendBytes(CMD.BOLD_OFF);
    await this.sendBytes([LF, LF]);
  }

  /**
   * Print the modem gag indicator.
   */
  async printModemNoise() {
    if (!this.connected) return;

    await this.sendBytes(CMD.ALIGN_CENTER);
    await this.sendText('>>>NO CARRIER<<<');
    await this.sendBytes([LF, LF]);
  }

  /**
   * Disconnect from the printer.
   */
  async disconnect() {
    if (this.mode === 'serial' && this.writer) {
      this.writer.releaseLock();
      await this.port.close();
    } else if (this.mode === 'usb' && this.device) {
      await this.device.close();
    }
    this.connected = false;
    this.port = null;
    this.device = null;
    this.writer = null;
  }
}
