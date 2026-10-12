// Pi Video Kiosk — in-browser video checker & converter.
//
// Everything runs client-side: Mediabunny demuxes/muxes in JS and uses the
// browser's WebCodecs (hardware) encoders. Nothing is uploaded anywhere.

import {
  Input,
  Output,
  Mp4OutputFormat,
  BufferTarget,
  StreamTarget,
  Conversion,
  ConversionCanceledError,
  ALL_FORMATS,
  BlobSource,
  Quality,
  canEncodeVideo,
} from './vendor/mediabunny.min.mjs';

// ---------------------------------------------------------------------------
// Presets. Mirrors scripts/check-video.sh: HEVC decodes in hardware at any
// size on Pi 4/5; H.264 only up to 1080p (and only in software on the Pi 5,
// which copes fine at 1080p). Never upscale, never raise the frame rate.
// ---------------------------------------------------------------------------
const PRESETS = {
  'hevc-4k': {
    codec: 'hevc', maxHeight: 2160, maxWidth: 3840, maxFps: 60,
    hint: 'Best quality. Keeps 4K sources at 4K (capped at 60 fps). Needs a browser with an HEVC hardware encoder.',
  },
  'hevc-1080': {
    codec: 'hevc', maxHeight: 1080, maxWidth: 1920, maxFps: 60,
    hint: 'Downscales 4K sources to 1080p. Much smaller files, and the kiosk outputs 1080p anyway.',
  },
  'h264-1080': {
    codec: 'avc', maxHeight: 1080, maxWidth: 1920, maxFps: 60,
    hint: 'For Pi 3 / Zero 2 W, or when your browser cannot encode HEVC. Plays on every Pi.',
  },
};

// Target bitrate: bits per pixel per frame, clamped to a sensible range.
function targetBitrate(codec, width, height, fps) {
  const bpp = codec === 'hevc' ? 0.08 : 0.12;
  const raw = width * height * fps * bpp;
  return Math.round(Math.min(Math.max(raw, 5e6), 32e6));
}

// Verdict for a source file, same rules as check-video.sh.
function verdictFor(info) {
  if (!info.videoCodec) {
    return { level: 'bad', text: 'Unrecognised video codec. It will almost certainly software-decode on the Pi.', flagged: true };
  }
  if (info.videoCodec === 'hevc') {
    return { level: 'ok', text: `HEVC ${info.height}p decodes in hardware on Pi 4 / Pi 5.`, flagged: false, containerNote: containerNote(info) };
  }
  if (info.videoCodec === 'avc') {
    if (info.height <= 1080 && info.width <= 1920) {
      return { level: 'ok', text: `H.264 ${info.height}p plays fine on any Pi.`, flagged: false, containerNote: containerNote(info) };
    }
    return { level: 'bad', text: `${info.height}p H.264 has no hardware decode on any Pi and will play in slow motion.`, flagged: true };
  }
  return { level: 'bad', text: `${codecName(info.videoCodec)} is not hardware-decoded on the Pi and will likely stutter.`, flagged: true };
}

function containerNote(info) {
  const ok = ['mp4', 'mov', 'matroska'].some(k => info.container.toLowerCase().includes(k));
  return ok ? null : `The kiosk only picks up .mp4 / .mkv / .mov files, so this ${info.container} file needs remuxing.`;
}

function codecName(c) {
  return { avc: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', prores: 'ProRes' }[c] || (c || 'unknown').toUpperCase();
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const dropzone = $('#dropzone');
const fileInput = $('#file-input');
const presetSel = $('#preset');
const fpsCapSel = $('#fps-cap');
const presetHint = $('#preset-hint');
const capsEl = $('#caps');
const capsHint = $('#caps-hint');
const results = $('#results');
const fileList = $('#file-list');
const convertAllBtn = $('#convert-all');
const clearAllBtn = $('#clear-all');
const saveModeEl = $('#save-mode');

const hasWebCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
const hasFSAccess = typeof window.showSaveFilePicker === 'function';

if (!hasWebCodecs) $('#unsupported').classList.remove('hidden');
saveModeEl.textContent = hasFSAccess
  ? 'Output streams directly to a file you choose.'
  : 'Output is held in memory until download. Large files work best in Chrome or Edge.';

// Browser capability check.
const caps = { hevc4k: false, hevc1080: false, avc1080: false };
async function detectCaps() {
  if (!hasWebCodecs) {
    capsEl.innerHTML = '<span class="pill bad">No WebCodecs</span>';
    presetSel.disabled = true;
    return;
  }
  const q = (b) => new Quality({ bitrate: b });
  [caps.hevc4k, caps.hevc1080, caps.avc1080] = await Promise.all([
    canEncodeVideo('hevc', { width: 3840, height: 2160, frameRate: 60, quality: q(30e6) }).catch(() => false),
    canEncodeVideo('hevc', { width: 1920, height: 1080, frameRate: 60, quality: q(10e6) }).catch(() => false),
    canEncodeVideo('avc', { width: 1920, height: 1080, frameRate: 60, quality: q(12e6) }).catch(() => false),
  ]);
  const pill = (ok, label) => `<span class="pill ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} ${label}</span>`;
  capsEl.innerHTML = pill(caps.hevc4k, 'HEVC 4K') + pill(caps.hevc1080, 'HEVC 1080p') + pill(caps.avc1080, 'H.264 1080p');

  if (!caps.hevc1080) {
    capsHint.textContent = 'No HEVC encoder here. Files that need converting will become H.264 at 1080p, which the Pi plays fine. For 4K HEVC use Chrome/Edge on macOS or Windows, or Safari on a Mac.';
  } else if (!caps.hevc4k) {
    capsHint.textContent = 'HEVC works, but not at 4K in this browser. 4K sources will be downscaled to 1080p.';
    presetSel.value = 'hevc-1080';
  } else {
    capsHint.textContent = 'All set for 4K HEVC.';
  }
  updatePresetHint();
}

function updatePresetHint() { presetHint.textContent = PRESETS[presetSel.value].hint; }
presetSel.addEventListener('change', () => { updatePresetHint(); for (const e of entries) refreshPlan(e); });
fpsCapSel.addEventListener('change', () => { for (const e of entries) refreshPlan(e); });
updatePresetHint();
detectCaps();

// Drag & drop.
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
// Allow dropping anywhere on the page too.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (e.target.closest('#dropzone')) return; addFiles(e.dataTransfer.files); });

clearAllBtn.addEventListener('click', () => {
  for (const e of entries) e.conversion?.cancel().catch(() => {});
  entries.length = 0;
  fileList.innerHTML = '';
  results.classList.add('hidden');
});

convertAllBtn.addEventListener('click', () => convertMany(entries.filter(e => e.info && e.verdict.flagged && e.plan?.encodable && !e.done && !e.running)));

// ---------------------------------------------------------------------------
// File entries
// ---------------------------------------------------------------------------
const entries = [];

async function addFiles(files) {
  const list = Array.from(files || []).filter(f => f.size > 0);
  if (!list.length) return;
  results.classList.remove('hidden');
  for (const file of list) {
    const entry = { file, el: null, info: null, verdict: null, running: false, done: false };
    entries.push(entry);
    renderEntry(entry);
    analyse(entry);
  }
}

function renderEntry(entry) {
  const el = document.createElement('div');
  el.className = 'file';
  el.innerHTML = `
    <div class="file-head">
      <span class="file-name"></span>
      <span class="file-meta"></span>
    </div>
    <div class="file-verdict muted">Reading file…</div>
    <div class="file-plan"></div>
    <div class="progress hidden"><div></div></div>
    <div class="file-actions">
      <button class="btn small primary act-convert hidden">Convert</button>
      <button class="btn small act-cancel hidden">Cancel</button>
      <a class="btn small primary act-download hidden" download>Download</a>
      <span class="status"></span>
    </div>`;
  el.querySelector('.file-name').textContent = entry.file.name;
  el.querySelector('.file-meta').textContent = fmtBytes(entry.file.size);
  el.querySelector('.act-convert').addEventListener('click', () => convertMany([entry]));
  el.querySelector('.act-cancel').addEventListener('click', () => entry.conversion?.cancel());
  fileList.appendChild(el);
  entry.el = el;
}

async function analyse(entry) {
  const vEl = entry.el.querySelector('.file-verdict');
  try {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(entry.file) });
    const format = await input.getFormat();
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('No video track found.');
    const audio = await input.getPrimaryAudioTrack();
    const [codec, width, height, fr, durationMeta, canDecode, audioCodec] = await Promise.all([
      video.getCodec(),
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.computeFrameRateMetrics().catch(() => null),
      input.getDurationFromMetadata().catch(() => null),
      video.canDecode().catch(() => false),
      audio ? audio.getCodec().catch(() => null) : Promise.resolve(null),
    ]);
    const duration = durationMeta ?? await input.computeDuration();
    entry.info = {
      container: format.name,
      videoCodec: codec,
      internalCodecId: video.internalCodecId,
      width, height,
      fps: fr?.bestGuessFrameRate || null,
      duration,
      canDecode,
      hasAudio: !!audio,
      audioCodec,
    };
    entry.verdict = verdictFor(entry.info);

    const parts = [
      `${format.name}`,
      `${codecName(codec ?? entry.info.internalCodecId)}`,
      `${width}×${height}`,
      entry.info.fps ? `${fmtFps(entry.info.fps)} fps` : null,
      duration ? fmtDuration(duration) : null,
      audio ? `audio: ${(audioCodec || 'unknown').toUpperCase()}` : 'no audio',
    ].filter(Boolean);
    entry.el.querySelector('.file-meta').textContent = `${fmtBytes(entry.file.size)} · ${parts.join(' · ')}`;

    const v = entry.verdict;
    vEl.className = 'file-verdict';
    vEl.innerHTML = `<span class="pill ${v.level}">${v.level === 'ok' ? 'OK' : 'Needs converting'}</span> ${v.text}`
      + (v.containerNote ? ` <span class="muted">${v.containerNote}</span>` : '');
    if (v.containerNote) v.flagged = true;

    refreshPlan(entry);
    entry.el.querySelector('.act-convert').classList.remove('hidden');
  } catch (err) {
    vEl.className = 'file-verdict err';
    vEl.textContent = `Couldn't read this file: ${err?.message || err}`;
  }
}

// Work out what conversion would do for this entry under the current preset.
// `?codec=vp9` etc. forces the output codec; only useful for testing the
// pipeline in browsers without an H.264/HEVC encoder.
const CODEC_OVERRIDE = new URLSearchParams(location.search).get('codec');

function planFor(entry) {
  const preset = PRESETS[presetSel.value];
  const info = entry.info;
  let codec = preset.codec;
  let maxH = preset.maxHeight, maxW = preset.maxWidth;
  let note = null;
  let encodable = true;

  if (CODEC_OVERRIDE) {
    codec = CODEC_OVERRIDE;
    note = `codec forced to ${codec} via URL`;
  } else if (codec === 'hevc' && !caps.hevc1080) {
    codec = 'avc'; maxH = 1080; maxW = 1920;
    note = 'browser has no HEVC encoder, using H.264 1080p';
    encodable = caps.avc1080;
  } else if (codec === 'hevc' && maxH > 1080 && !caps.hevc4k) {
    maxH = 1080; maxW = 1920;
    note = 'browser cannot encode 4K HEVC, capping at 1080p';
  } else if (codec === 'avc') {
    encodable = caps.avc1080;
  }

  // Scale down (never up), keeping aspect ratio.
  let { width, height } = info;
  const scale = Math.min(1, maxW / width, maxH / height);
  if (scale < 1) {
    width = Math.round(width * scale / 2) * 2;
    height = Math.round(height * scale / 2) * 2;
  }
  const srcFps = info.fps || 30;
  const fps = Math.min(srcFps, preset.maxFps, Number(fpsCapSel.value) || 60);
  const bitrate = targetBitrate(codec, width, height, fps);

  // A file the Pi already plays fine keeps its video stream unless the user
  // explicitly asked for a different codec or a smaller size. In particular a
  // browser falling back to H.264 must never downgrade an HEVC file.
  const alreadyFine = entry.verdict && !entry.verdict.flagged && preset.codec === 'hevc' && !CODEC_OVERRIDE;
  const codecChange = alreadyFine ? false : info.videoCodec !== codec;
  const transcode = codecChange || scale < 1 || fps < srcFps - 0.01;
  return { codec, width, height, fps, bitrate, transcode, note, encodable: !transcode || encodable };
}

function refreshPlan(entry) {
  if (!entry.info || entry.done || entry.running) return;
  const p = planFor(entry);
  entry.plan = p;
  const est = entry.info.duration ? ` · about ${fmtBytes(p.bitrate * entry.info.duration / 8 + (entry.info.hasAudio ? 24e3 * entry.info.duration : 0))}` : '';
  const what = p.transcode && !p.encodable
    ? `Cannot convert here: this browser has no ${codecName(p.codec)} encoder`
    : p.transcode
    ? `Will re-encode to ${codecName(p.codec)} ${p.width}×${p.height} @ ${fmtFps(p.fps)} fps, ~${(p.bitrate / 1e6).toFixed(0)} Mbps${est}`
    : `Already ${codecName(entry.info.videoCodec)} within limits: will remux into a clean MP4 without re-encoding (fast, lossless)`;
  entry.el.querySelector('.file-plan').textContent = what + (p.note && p.transcode ? ` (${p.note})` : '') + '.';
  const btn = entry.el.querySelector('.act-convert');
  btn.textContent = p.transcode ? 'Convert' : 'Remux';
  btn.disabled = !hasWebCodecs || !p.encodable;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
let dirHandle = null;

// Must be called synchronously-ish from a click so the picker is allowed.
async function convertMany(list) {
  if (!list.length || !hasWebCodecs) return;
  const outputs = [];
  if (hasFSAccess) {
    try {
      if (list.length === 1) {
        const handle = await window.showSaveFilePicker({
          suggestedName: outName(list[0].file.name),
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        outputs.push(handle);
      } else {
        dirHandle = dirHandle || await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'videos' });
        for (const e of list) outputs.push(await dirHandle.getFileHandle(outName(e.file.name), { create: true }));
      }
    } catch (err) {
      if (err?.name === 'AbortError') return; // user cancelled the picker
      // Fall back to in-memory output.
      outputs.length = 0;
    }
  }
  for (let i = 0; i < list.length; i++) {
    await convertOne(list[i], outputs[i] || null);
  }
}

function outName(name) {
  return name.replace(/\.[^.]+$/, '') + '-pi.mp4';
}

async function convertOne(entry, fileHandle) {
  if (entry.running || entry.done) return;
  const el = entry.el;
  const status = el.querySelector('.status');
  const bar = el.querySelector('.progress');
  const barFill = bar.querySelector('div');
  const btnConvert = el.querySelector('.act-convert');
  const btnCancel = el.querySelector('.act-cancel');
  const btnDl = el.querySelector('.act-download');

  entry.running = true;
  btnConvert.classList.add('hidden');
  btnCancel.classList.remove('hidden');
  bar.classList.remove('hidden');
  barFill.style.width = '0%';
  status.textContent = 'Starting…';

  const plan = entry.plan || planFor(entry);
  let writable = null;
  try {
    if (plan.transcode && !plan.encodable) {
      throw new Error(`This browser has no ${codecName(plan.codec)} encoder.`);
    }
    if (plan.transcode && !entry.info.canDecode) {
      throw new Error(`This browser can't decode ${codecName(entry.info.videoCodec || entry.info.internalCodecId)} video, so it can't be re-encoded here.`);
    }

    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(entry.file) });

    let target;
    if (fileHandle) {
      writable = await fileHandle.createWritable();
      target = new StreamTarget(writable, { chunked: true });
    } else {
      target = new BufferTarget();
    }
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: fileHandle ? false : 'in-memory' }),
      target,
    });

    const videoOpts = plan.transcode
      ? {
          codec: plan.codec,
          width: plan.width,
          height: plan.height,
          fit: 'fill', // dims above already preserve aspect ratio
          frameRate: plan.fps,
          quality: new Quality({ bitrate: plan.bitrate }),
          keyFrameInterval: 2,
          forceTranscode: true,
        }
      : {}; // copy video packets as-is

    const conversion = await Conversion.init({ input, output, video: videoOpts });
    entry.conversion = conversion;

    const droppedVideo = conversion.discardedTracks.find(d => d.track.type === 'video');
    if (!conversion.isValid || droppedVideo) {
      const reasons = conversion.discardedTracks.map(d => `${d.track.type}: ${d.reason.replace(/_/g, ' ')}`).join('; ');
      await conversion.cancel().catch(() => {});
      throw new Error(`Can't convert in this browser (${reasons}).`);
    }
    const droppedAudio = conversion.discardedTracks.find(d => d.track.type === 'audio');

    const started = performance.now();
    const duration = entry.info.duration || 0;
    conversion.onProgress = (p) => {
      barFill.style.width = `${(p * 100).toFixed(1)}%`;
      const elapsed = (performance.now() - started) / 1000;
      if (duration && p > 0.01 && elapsed > 1) {
        const speed = (p * duration) / elapsed;
        const eta = (duration * (1 - p)) / speed;
        status.textContent = `${(p * 100).toFixed(0)}% · ${speed.toFixed(1)}× realtime · ${fmtDuration(eta)} left`;
      } else {
        status.textContent = `${(p * 100).toFixed(0)}%`;
      }
    };

    await conversion.execute();

    entry.done = true;
    entry.running = false;
    btnCancel.classList.add('hidden');
    barFill.style.width = '100%';
    const audioNote = droppedAudio ? ' Audio track was dropped: no suitable encoder in this browser.' : '';

    if (fileHandle) {
      status.textContent = `Saved as ${fileHandle.name}.` + audioNote;
    } else {
      const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      btnDl.href = url;
      btnDl.download = outName(entry.file.name);
      btnDl.textContent = `Download (${fmtBytes(blob.size)})`;
      btnDl.classList.remove('hidden');
      btnDl.click();
      status.textContent = 'Done.' + audioNote;
    }
  } catch (err) {
    entry.running = false;
    btnCancel.classList.add('hidden');
    bar.classList.add('hidden');
    btnConvert.classList.remove('hidden');
    if (writable && err instanceof ConversionCanceledError === false) {
      try { await writable.abort(); } catch { /* ignore */ }
    }
    if (err instanceof ConversionCanceledError) {
      status.textContent = 'Cancelled.';
      if (fileHandle) try { await fileHandle.remove?.(); } catch { /* ignore */ }
    } else {
      console.error(err);
      status.innerHTML = `<span class="err">${escapeHtml(err?.message || String(err))}</span>`;
    }
  } finally {
    entry.conversion = null;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(2) : n < 100 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function fmtDuration(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
}
function fmtFps(f) {
  return Math.abs(f - Math.round(f)) < 0.05 ? String(Math.round(f)) : f.toFixed(2);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
