'use strict';

// ── IndexedDB storage ────────────────────────────────────────────────────────
const DB_NAME = 'filmcam';
const DB_VER  = 1;
const STORE   = 'photos';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbGetAll(db) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result.reverse());
    req.onerror   = () => rej(req.error);
  });
}

async function dbAdd(db, record) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).add(record);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function dbDelete(db, id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ── ISO → grain mapping ───────────────────────────────────────────────────────
// grain: half-range of pixel noise applied at capture
// wobble: per-channel colour variation on top of the base noise
// liveOpacity: opacity of the grain-canvas overlay on the viewfinder
const ISO_MAP = {
  100:  { grain: 8,   wobble: 2,  liveOpacity: 0.18 },
  200:  { grain: 18,  wobble: 4,  liveOpacity: 0.28 },
  400:  { grain: 32,  wobble: 8,  liveOpacity: 0.42 },
  800:  { grain: 52,  wobble: 13, liveOpacity: 0.58 },
  1600: { grain: 72,  wobble: 18, liveOpacity: 0.72 },
  3200: { grain: 96,  wobble: 24, liveOpacity: 0.88 },
};

// ── Film Effect ──────────────────────────────────────────────────────────────
/**
 * Kodak 400-style film look:
 *  - Lifted blacks (no crush to pure black)
 *  - Slight warm shadow / neutral highlight
 *  - Mild desaturation
 *  - S-curve contrast
 *  - ISO-driven grain + radial vignette
 */

// Pre-build a lookup table for the tone curve so we don't recalculate per-pixel.
const CURVE = new Uint8Array(256);
(function buildCurve() {
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    // Lift blacks: floor at ~8%
    v = v * 0.88 + 0.08;
    // S-curve for contrast (smoothstep variant)
    v = v * v * (3 - 2 * v);
    CURVE[i] = Math.round(Math.min(255, Math.max(0, v * 255)));
  }
})();

function applyFilmEffect(ctx, w, h, isoConfig = ISO_MAP[400]) {
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const len = d.length;

  // 1 – Colour grading (Kodak 400 warmth)
  for (let i = 0; i < len; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];

    // Slight warm cast: boost red/green, pull blue in shadows
    r = Math.min(255, r + 6);
    g = Math.min(255, g + 2);
    b = Math.max(0, b - 8);

    // Mild desaturation (blend toward luminance)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = 0.82;
    r = lum * (1 - sat) + r * sat;
    g = lum * (1 - sat) + g * sat;
    b = lum * (1 - sat) + b * sat;

    // Tone curve (lift blacks + contrast)
    d[i]     = CURVE[Math.round(r)];
    d[i + 1] = CURVE[Math.round(g)];
    d[i + 2] = CURVE[Math.round(b)];
  }

  // 2 – Film grain (monochromatic with slight colour wobble, ISO-driven)
  const GRAIN  = isoConfig.grain;
  const WOBBLE = isoConfig.wobble;
  for (let i = 0; i < len; i += 4) {
    const base = (Math.random() - 0.5) * GRAIN * 2;
    const cr   = base + (Math.random() - 0.5) * WOBBLE;
    const cg   = base + (Math.random() - 0.5) * WOBBLE;
    const cb   = base + (Math.random() - 0.5) * WOBBLE;
    d[i]     = Math.min(255, Math.max(0, d[i]     + cr));
    d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + cg));
    d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + cb));
  }

  ctx.putImageData(imageData, 0, 0);

  // 3 – Vignette (radial gradient, drawn after pixel pass)
  const cx = w / 2, cy = h / 2;
  const r0 = Math.min(w, h) * 0.28;
  const r1 = Math.max(w, h) * 0.85;
  const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.18)');
  grad.addColorStop(1, 'rgba(0,0,0,0.72)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

// ── Live grain overlay ───────────────────────────────────────────────────────
// Renders random noise to a small canvas each frame, scaled to the viewfinder.
// Using mix-blend-mode: soft-light so the effect brightens mids like real grain.
const GRAIN_TILE = 192; // px – small tile, scaled up for speed

let grainCtx = null;
let grainBuffer = null;
let rafId = null;

function startGrain(canvas) {
  canvas.width  = GRAIN_TILE;
  canvas.height = GRAIN_TILE;
  grainCtx    = canvas.getContext('2d');
  grainBuffer = grainCtx.createImageData(GRAIN_TILE, GRAIN_TILE);

  function tick() {
    const d = grainBuffer.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255 | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    grainCtx.putImageData(grainBuffer, 0, 0);
    rafId = requestAnimationFrame(tick);
  }
  tick();
}

function stopGrain() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ── App ──────────────────────────────────────────────────────────────────────
class FilmCam {
  constructor(db) {
    this.db          = db;
    this.stream      = null;
    this.facingMode  = 'environment';
    this.photos      = [];           // [{id, dataUrl, ts}]
    this.viewerIdx   = -1;
    this.iso         = 400;

    // DOM refs
    this.$ = id => document.getElementById(id);

    this.cameraScreen  = this.$('camera-screen');
    this.galleryScreen = this.$('gallery-screen');
    this.viewerScreen  = this.$('viewer-screen');

    this.video          = this.$('viewfinder');
    this.grainCanvas    = this.$('grain-canvas');
    this.captureCanvas  = this.$('capture-canvas');
    this.captureCtx     = this.captureCanvas.getContext('2d');

    this.counterNum     = this.$('counter-num');
    this.galleryThumb   = this.$('gallery-thumb');
    this.galleryGrid    = this.$('gallery-grid');
    this.galleryEmpty   = this.$('gallery-empty');
    this.photoCountLbl  = this.$('photo-count-label');
    this.viewerImg      = this.$('viewer-img');
    this.flash          = this.$('flash');

    this._bindEvents();
    this._initCamera();
    startGrain(this.grainCanvas);
  }

  // ── Camera ──────────────────────────────────────
  async _initCamera() {
    try {
      if (this.stream) {
        this.stream.getTracks().forEach(t => t.stop());
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.facingMode },
          width:  { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
    } catch (err) {
      console.error('Camera access denied:', err);
      alert('Camera permission required. Please allow camera access and reload.');
    }
  }

  _flipCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    this._initCamera();
  }

  // ── Capture ─────────────────────────────────────
  async _capture() {
    const v = this.video;
    if (!v.videoWidth) return;

    // Flash
    this.flash.classList.add('active');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    this.flash.classList.remove('active');

    // Draw video frame
    const w = v.videoWidth, h = v.videoHeight;
    this.captureCanvas.width  = w;
    this.captureCanvas.height = h;
    this.captureCtx.drawImage(v, 0, 0, w, h);

    // Apply film look (ISO-driven)
    applyFilmEffect(this.captureCtx, w, h, ISO_MAP[this.iso]);

    // Export
    const dataUrl = this.captureCanvas.toDataURL('image/jpeg', 0.90);
    const record  = { dataUrl, ts: Date.now() };

    try {
      const id = await dbAdd(this.db, record);
      record.id = id;
      this.photos.unshift(record);
      this._updateCounter();
      this._updateThumb();
      this._renderGrid();
    } catch (e) {
      console.error('Save failed:', e);
      alert('Storage full. Delete some photos first.');
    }
  }

  // ── Gallery ─────────────────────────────────────
  async _openGallery() {
    // Reload from DB each time so we're always fresh
    this.photos = await dbGetAll(this.db);
    this._renderGrid();
    this.cameraScreen.classList.add('hidden');
    this.galleryScreen.classList.remove('hidden');
  }

  _closeGallery() {
    this.galleryScreen.classList.add('hidden');
    this.cameraScreen.classList.remove('hidden');
  }

  _renderGrid() {
    const count = this.photos.length;
    this.photoCountLbl.textContent = count ? `${count} frames` : '';
    this.galleryEmpty.classList.toggle('hidden', count > 0);
    this.galleryGrid.innerHTML = '';

    this.photos.forEach((p, idx) => {
      const img = document.createElement('img');
      img.src  = p.dataUrl;
      img.alt  = `Frame ${idx + 1}`;
      img.loading = 'lazy';
      img.addEventListener('click', () => this._openViewer(idx));
      this.galleryGrid.appendChild(img);
    });
  }

  // ── Viewer ──────────────────────────────────────
  _openViewer(idx) {
    this.viewerIdx = idx;
    this.viewerImg.src = this.photos[idx].dataUrl;
    this.galleryScreen.classList.add('hidden');
    this.viewerScreen.classList.remove('hidden');
  }

  _closeViewer() {
    this.viewerScreen.classList.add('hidden');
    this.galleryScreen.classList.remove('hidden');
  }

  async _downloadPhoto() {
    const p   = this.photos[this.viewerIdx];
    const a   = document.createElement('a');
    a.href     = p.dataUrl;
    a.download = `filmcam_${p.id}.jpg`;
    a.click();
  }

  async _deletePhoto() {
    const p = this.photos[this.viewerIdx];
    await dbDelete(this.db, p.id);
    this.photos.splice(this.viewerIdx, 1);
    this._updateCounter();
    this._updateThumb();
    this._closeViewer();
    this._renderGrid();

    // If no more photos go back to camera
    if (this.photos.length === 0) {
      this._closeViewer();
      this.galleryScreen.classList.add('hidden');
      this.cameraScreen.classList.remove('hidden');
    }
  }

  // ── ISO ─────────────────────────────────────────
  _setISO(value) {
    this.iso = value;
    // Update live grain opacity
    this.grainCanvas.style.opacity = ISO_MAP[value].liveOpacity;
    // Update active button
    document.querySelectorAll('.iso-opt').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.iso) === value);
    });
  }

  // ── UI helpers ──────────────────────────────────
  _updateCounter() {
    this.counterNum.textContent = String(this.photos.length).padStart(2, '0');
  }

  _updateThumb() {
    if (this.photos.length > 0) {
      this.galleryThumb.src = this.photos[0].dataUrl;
      this.galleryThumb.classList.add('has-photo');
    } else {
      this.galleryThumb.src = '';
      this.galleryThumb.classList.remove('has-photo');
    }
  }

  // ── Events ──────────────────────────────────────
  _bindEvents() {
    this.$('shutter-btn').addEventListener('click', () => this._capture());
    this.$('flip-btn').addEventListener('click',    () => this._flipCamera());
    this.$('gallery-btn').addEventListener('click', () => this._openGallery());

    // ISO buttons
    document.querySelectorAll('.iso-opt').forEach(btn => {
      btn.addEventListener('click', () => this._setISO(Number(btn.dataset.iso)));
    });
    this.$('close-gallery-btn').addEventListener('click', () => this._closeGallery());
    this.$('close-viewer-btn').addEventListener('click',  () => this._closeViewer());
    this.$('download-btn').addEventListener('click', () => this._downloadPhoto());
    this.$('delete-btn').addEventListener('click',   () => this._deletePhoto());

    // Keyboard: space = shutter, Escape = close
    document.addEventListener('keydown', e => {
      if (e.code === 'Space' && !this.galleryScreen.offsetParent && !this.viewerScreen.offsetParent) {
        e.preventDefault();
        this._capture();
      }
      if (e.code === 'Escape') {
        if (!this.viewerScreen.classList.contains('hidden'))   this._closeViewer();
        else if (!this.galleryScreen.classList.contains('hidden')) this._closeGallery();
      }
    });
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  const db  = await openDB();
  const app = new FilmCam(db);

  // Load persisted photos for counter + thumb
  app.photos = await dbGetAll(db);
  app._updateCounter();
  app._updateThumb();

  // Service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
