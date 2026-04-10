SILBERO DIGITAL
===============

An interactive art installation by Caitlyn Meeks / noodlings.ai


VISION
------

Silbero Digital is a live performance piece that exists simultaneously
as three things:

  1. A digital reimagining of Silbo Gomero, the UNESCO-recognized
     whistled language of La Gomera, Canary Islands. Participants
     type messages to each other on their phones. Their words are
     encoded into whistled melodies -- microtonal, haunting, built
     on a 31-tone equal temperament scale rooted in E major.

  2. A commentary on surveillance and social media. Every participant
     consents to data collection. Their device fingerprint, typing
     biometrics, face photograph, and behavioral patterns are harvested
     and analyzed in real time. The participants see none of this.
     The operator sees all of it. A thermal receipt printer continuously
     outputs dossiers into a vitrine, which is labelled and sealed after 
     each performance.

  3. A collaborative music sequencer. The operator console transforms
     incoming text messages into a live electronic music performance.
     Each user's voice is shaped by their biometric data -- face shape
     determines waveform, age shifts pitch, symmetry controls vibrato,
     facial hair adds harmonic buzz. The operator conducts this
     orchestra with mute, solo, loop, quantize, and scale controls,
     routing signals to Logic Pro through MIDI for full studio-grade
     sound design.

These layers are not separate modes. They coexist. The MUTE button
sits next to the biometric dossier. Surveillance is curation. Data
collection is composition. The participants think they are having
conversations. The operator is conducting a symphony from their data.

In an era where generative AI makes it difficult to distinguish
"authentic" music, Silbero Digital is a system where every note
traces back to a real human choosing to say something to another
human. The AI shapes and frames, but the raw signal is irreducibly
human. Anyone at the event can participate in creating beautiful music
simply by typing on their phone. The console operator both collects
their data and conducts their voices into something sublime.


HISTORY
-------

Silbero Digital began as a simple text-to-whistle encoder inspired by
the real Silbo Gomero -- a whistled register of Spanish developed by
inhabitants of La Gomera to communicate across the island's deep
ravines. Whistled messages can travel up to 5 kilometers. UNESCO
declared it a Masterpiece of the Oral and Intangible Heritage of
Humanity in 2009.

The first iteration was a WebSocket relay: participants type messages,
the text is encoded as audio (originally FSK modem tones, later Silbo-
inspired whistle synthesis), and relayed to all other connected
terminals. An operator station watches silently.

The surveillance layer emerged from the consent flow. Participants
explicitly agree to data collection. The system harvests everything a
browser can access without special permissions: IP geolocation, GPU
renderer, screen dimensions, installed fonts, battery level, canvas
fingerprint, audio fingerprint, typing cadence, ToS scroll depth,
time to consent. A composite device hash uniquely identifies each
device. The selfie capture adds face imagery. All of this is displayed
only on the operator console -- the participants see a clean chat
interface with no indication of what is being collected.

The music sequencer emerged from the synthesis engine. As the Silbo
whistle system evolved from simple FSK modem tones into a proper
31-TET microtonal scale with per-character frequency mapping, SID chip
percussion for punctuation, and biometric voice profiling, the
operator console naturally became a mixing desk. MIDI output to Logic
Pro completed the transformation into a performance instrument.


ARCHITECTURE
------------

Three components, all served from a single Node.js process:

  CLIENT (index.html, js/app.js)
    The participant's interface. Runs on any phone or computer
    with a browser. Presents a language selector (EN/ES/DE/NL/AR),
    consent flow, name prompt, selfie capture, and IRC-style chat.
    Messages are encoded into Silbo whistle audio and played locally.
    The client collects device fingerprints and typing biometrics
    silently and sends them to the server with registration.

  OPERATOR CONSOLE (operator.html, js/operator.js)
    The surveillance dashboard and music sequencer. Shows per-user
    subject cards with face analysis, biometric dossier, and mixer
    controls (Mute/Solo/Loop/PB/MIDI channel). Incoming messages
    appear as swim lanes with face thumbnails, waveforms, and
    decoded text. The footer toolbar provides global controls:
    Quantize, BPM, Bass Engine (7 patterns), MIDI Output, Internal
    Mute, Pitch Bend, Scale, and Root selectors.

  SERVER (server.js, face-analysis.js)
    HTTPS + HTTP static file server with WebSocket relay. Terminals
    connect to the default WebSocket endpoint. Operators connect to
    /operator-ws. The server relays text messages between terminals,
    relays face snap images to operators and other terminals (for
    avatars), and runs server-side face analysis using TensorFlow.js.
    When an operator connects, the server replays all current state
    (dossiers, face snaps, face analysis) so the console populates
    immediately.


AUDIO SYSTEM
------------

  31-TET Microtonal Scale (js/silbo-synth.js)

    31 equal divisions of the octave. Each step is ~38.71 cents.
    Provides excellent just intonation approximations, "neutral"
    intervals that sound North African / Middle Eastern, and enough
    resolution that every ASCII character gets a unique pitch.

    Vowels land on E major scale degrees (E, F#, G#, A, B, C#, D#)
    to anchor the listener in familiar harmony. Consonants occupy
    microtonal positions between those degrees. Digits get their own
    positions in the upper register. Spaces trigger a soft E major
    power chord (E4 + B4 + E5) that refreshes the tonal center at
    every word boundary.

    Uppercase letters play with a sawtooth buzz and extra harmonics.

  SID Chip Percussion

    Punctuation triggers Commodore 64-style percussive hits:
      .  kick drum        ,  closed hi-hat     !  snare
      ?  open hi-hat      ;  rim shot          :  cowbell
      '  click            "  clap              -  tom
      (  upward blip      )  downward zap      /  buzz

    Each hit uses pulse waves with variable duty cycle, noise,
    and fast ADSR envelopes -- the signature sounds of 8-bit
    chiptune drums.

  Biometric Voice Profiles (deriveVoiceProfile)

    Face analysis data maps to synthesis parameters:
      Face shape    -> waveform type (oval=sine, round=bell,
                       square=sawtooth, heart=softsaw, oblong=triangle)
      Age           -> pitch shift (younger=higher, older=lower)
      Symmetry      -> vibrato depth (asymmetric = more wobble)
      Facial hair   -> harmonic overtones (more hair = buzzier)
      Glasses       -> slight metallic edge
      Expression    -> breathiness (fearful=breathy, happy=clear)

  Bass Engine

    Continuous backing track synced to global BPM. Sawtooth + sub
    sine through a resonant lowpass with fast filter envelope sweep.
    Seven patterns: PSY (classic psytrance), DRIVE (relentless 16ths),
    OFFBEAT (dub 8ths), ARP (pentatonic rolling), ARP UP, ARP DN,
    ACID (303-style). Octave selectable E0-E3.

    Uses the canonical Web Audio precision scheduler: a 25ms JS
    interval looks 100ms ahead and schedules notes via
    audioCtx.currentTime for sample-accurate timing.


FACE ANALYSIS
-------------

  Server-side (face-analysis.js) using @vladmandic/face-api
  (TensorFlow.js, SSD MobileNet v1). Runs in Node.js with
  @tensorflow/tfjs-node for native CPU acceleration. ~150ms per
  image, zero API cost.

  ML model outputs:
    - Age (estimated)
    - Gender + confidence
    - Expression (7 emotions with scores)
    - 68 facial landmarks
    - 128-dimensional face descriptor (cross-session matching)

  Custom pixel analysis on top of landmarks:
    - Eye color (iris region sampling, classified)
    - Hair color (forehead region sampling)
    - Skin tone (cheek/forehead sampling, Fitzpatrick I-VI)
    - Glasses detection (bridge brightness variance)
    - Facial hair (lower face darkness vs. cheek baseline)
    - Face shape (jawline/cheekbone/height ratios)
    - Facial symmetry score (left/right landmark distances)
    - Head pose (yaw, pitch, roll from 2D landmarks)
    - Interpupillary distance

  Results are sent only to the operator console. Participants
  never see their own analysis.


MIDI BRIDGE
-----------

  js/midi-bridge.js routes all audio signals to external DAWs
  via the WebMIDI API through macOS IAC Driver (or any virtual
  MIDI port).

  Channel mapping:
    1-8:  Terminal whistle melodies (assignable per user)
    9:    Bass engine
    10:   Percussion (SID hits -> GM drum map)
    11:   Space chord anchor

  Microtonal pitch bend: each 31-TET note sends a Note On for the
  nearest 12-TET MIDI note plus a pitch bend message to tune it to
  the exact microtonal frequency. Assumes +/-2 semitone bend range.

  Scale quantizer: when pitch bend is disabled (globally or per
  user), notes snap to the nearest degree in the selected scale.
  15 scales available: Chromatic, Major, Minor, Dorian, Mixolydian,
  Phrygian, Lydian, Locrian, Pentatonic Major/Minor, Blues,
  Harmonic Minor, Whole Tone, Hungarian, Arabic. Root selectable
  C through B.

  MIDI clock output (24 ppqn) syncs the DAW transport to the
  operator console's BPM grid.


DEVICE FINGERPRINTING
---------------------

  js/fingerprint.js collects ~30 data points without requiring
  any permissions beyond what the browser provides by default:

    Network:    IP, city, region, country, ISP, coordinates
    Connection: type (4g/wifi), downlink Mbps, RTT
    Device:     user agent, platform, vendor, touch points
    Hardware:   CPU cores, RAM, screen dimensions, pixel ratio
    GPU:        vendor, renderer, max texture size (via WebGL)
    Preferences: dark mode, reduced motion, Do Not Track
    Battery:    level, charging status
    Canvas:     rendering test -> SHA-256 hash
    Audio:      OfflineAudioContext -> output hash
    Fonts:      28 common fonts detected via width measurement
    Storage:    quota and usage estimates
    Composite:  deviceHash = SHA-256 of all above

  Also includes:
    - Fake MAC address derived from device hash
    - Handedness estimation from selfie brightness variance
    - TypingBiometrics class (key timing, hold times, WPM)
    - BehaviorTracker (ToS scroll depth, consent timing, patterns)

  All data is sent to the server with terminal registration and
  forwarded to the operator console as a dossier. The client UI
  does not display any of this.


THERMAL PRINTER
---------------

  js/thermal-printer.js drives an ESC/POS thermal receipt printer
  via WebSerial (USB-to-serial) or WebUSB. Outputs face images as
  Floyd-Steinberg dithered 1-bit bitmaps (384px wide for 80mm
  paper), decoded text in double-height, confidence scores, and
  face analysis summaries. Partial cut between receipts.

  In the installation, the printer feeds directly into a shredder.


OPERATOR CONSOLE CONTROLS
--------------------------

  Per-user (on each subject card):
    M        Mute (red) -- silences playback, loop keeps running
    S        Solo (yellow) -- only hear this user
    LOOP     Loop last phrase (green) -- repeats with MIDI output
    PB       Pitch bend toggle (blue) -- per-user override
    1-8      MIDI channel assignment

  Global (footer toolbar):
    QUANTIZE   Snap incoming messages to beat grid
    -/+        BPM control (40-300)
    BASS       Toggle bass engine
    Pattern    PSY / DRIVE / OFFBEAT / ARP / ARP UP / ARP DN / ACID
    Octave     E0 / E1 / E2 / E3
    MIDI OUT   Connect to IAC Driver / virtual MIDI port
    INT MUTE   Silence internal Web Audio (MIDI keeps flowing)
    PB         Global pitch bend on/off
    Scale      15 scales (Chromatic through Arabic)
    Root       C through B
    CONNECT PRINTER   Thermal receipt printer
    DISCONNECT ALL    Close all terminal connections


SETUP
-----

  Requirements:
    Node.js 18+
    npm

  Install:
    npm install

  Run:
    node server.js

  The server starts on:
    HTTPS:  https://localhost:8443
    HTTP:   http://localhost:8080 (for Tailscale Funnel)

  Self-signed certificates are auto-generated on first run.
  For Tailscale, place tailscale.crt and tailscale.key in .certs/.

  Client:     https://localhost:8443
  Operator:   https://localhost:8443/operator.html

  For MIDI output to Logic Pro:
    1. Open Audio MIDI Setup (/Applications/Utilities/)
    2. Window -> Show MIDI Studio
    3. Double-click IAC Driver, check "Device is online"
    4. In Logic Pro, create tracks receiving from IAC Driver
    5. In the operator console, click MIDI OUT and select the port


FILE MANIFEST
-------------

  index.html              Client terminal (participant interface)
  operator.html           Operator surveillance + sequencer console
  server.js               HTTPS/HTTP server + WebSocket relay
  face-analysis.js        Server-side face analysis (TensorFlow.js)

  css/style.css           Client styling (dark monochrome)
  css/operator.css        Operator console styling

  js/app.js               Client application logic
  js/operator.js          Operator console logic + mixer + sequencer
  js/silbo-synth.js       31-TET microtonal synthesis + SID percussion
  js/midi-bridge.js       WebMIDI output + scale quantizer
  js/camera.js            Guided selfie capture
  js/face-detect.js       Client-side face annotation (targeting overlays)
  js/fingerprint.js       Device fingerprinting + typing biometrics
  js/glitch.js            VHS/CRT glitch effects for whistler images
  js/thermal-printer.js   ESC/POS thermal printer driver
  js/modem.js             FSK modem encoder/decoder (legacy)
  js/i18n.js              Internationalization (EN/ES/DE/NL/AR)
  js/chirp-encoder.js     Chirp encoding (experimental)
  js/chirp-decoder.js     Chirp decoding (experimental)
  js/fhss.js              Frequency-hopping spread spectrum (experimental)
  js/modem-gag.js         Modem sound effects

  images/whistler*.jpg    Silbo Gomero whistler reference photos


LICENSE
-------

  Copyright 2024-2026 Caitlyn Meeks / noodlings.ai
  All rights reserved.
