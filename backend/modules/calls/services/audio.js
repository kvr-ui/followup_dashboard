// TeleCMI records at MPEG 2.5 / 8kHz / 16kbps — VLC plays it, but browsers and
// most default players cannot decode it. We transcode to a standard MP3 so the
// dashboard's audio player works, and cache the result so we only do it once.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_DIR = process.env.CALL_AUDIO_CACHE || path.join(os.tmpdir(), 'focas-call-audio');
fs.mkdirSync(CACHE_DIR, { recursive: true });

let ffmpegAvailable = null;

/** Is ffmpeg installed? Checked once. */
function hasFfmpeg() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const r = require('child_process').spawnSync('ffmpeg', ['-version']);
    ffmpegAvailable = r.status === 0;
  } catch {
    ffmpegAvailable = false;
  }
  if (!ffmpegAvailable) {
    console.warn('ffmpeg not found — call audio will be served raw (may not play in browsers)');
  }
  return ffmpegAvailable;
}

function cachePath(key) {
  return path.join(CACHE_DIR, `${key}.mp3`);
}

/**
 * Transcode a raw TeleCMI buffer into a browser-playable MP3.
 * 22.05kHz mono @ 64kbps — small, and plays everywhere.
 *
 * ffmpeg reads stdin and writes stdout: we never ask it to touch the
 * filesystem, so this works even when ffmpeg is sandboxed (e.g. a snap build,
 * which cannot write to /tmp). Node writes the cache file itself.
 */
function transcodeToBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ar', '22050',
      '-ac', '1',
      '-b:a', '64k',
      '-f', 'mp3',
      'pipe:1',
    ]);

    const chunks = [];
    let err = '';
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', reject);
    ff.on('close', (code) => {
      const out = Buffer.concat(chunks);
      if (out.length > 0) return resolve(out); // ffmpeg may warn but still succeed
      reject(new Error(`ffmpeg failed (${code}): ${err.slice(0, 200)}`));
    });

    ff.stdin.on('error', () => {}); // ignore EPIPE
    ff.stdin.end(buffer);
  });
}

/**
 * Return a path to a browser-playable MP3 for this call, transcoding + caching
 * on first request. Falls back to the raw file if ffmpeg isn't installed.
 */
async function getPlayableFile(key, fetchBuffer) {
  const out = cachePath(key);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { path: out, transcoded: true };

  const raw = await fetchBuffer();

  if (!hasFfmpeg()) {
    fs.writeFileSync(out, raw); // raw passthrough (may not play in browsers)
    return { path: out, transcoded: false };
  }

  const mp3 = await transcodeToBuffer(raw);
  fs.writeFileSync(out, mp3);
  return { path: out, transcoded: true };
}

module.exports = { getPlayableFile, hasFfmpeg, CACHE_DIR };
