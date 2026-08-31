// QR generation worker. One instance runs per CPU core (see pool size in app.js).
// Talks to the main thread with plain postMessage batches to keep overhead low at 50k+ scale.
importScripts('../vendor/qrcode.bundle.js');
const { QRCode } = self.Vendor;

const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

function sanitizeName(nameTag) {
  return String(nameTag)
    .split('')
    .filter((c) => /[a-zA-Z0-9_-]/.test(c))
    .join('')
    .trim();
}

async function renderSvg(text, opts) {
  // The SVG renderer ignores `scale` entirely (only the canvas/PNG renderer
  // uses it) — it only sizes itself from an explicit `width`, so compute one
  // from the box-size setting to keep SVG and PNG output visually consistent.
  const qrData = QRCode.create(text, { errorCorrectionLevel: opts.errorCorrection });
  const width = (qrData.modules.size + opts.border * 2) * opts.boxSize;
  const svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: opts.errorCorrection,
    margin: opts.border,
    width,
    color: { dark: opts.fgColor, light: opts.bgColor },
  });
  return new Blob([svg], { type: 'image/svg+xml' });
}

async function renderPng(text, opts) {
  if (!hasOffscreenCanvas) throw new Error('PNG rendering needs OffscreenCanvas, which this browser worker does not support. Use SVG instead.');
  // qrcode's canvas renderer just needs .getContext('2d'); OffscreenCanvas satisfies that.
  const probe = new OffscreenCanvas(1, 1);
  const canvas = await QRCode.toCanvas(probe, text, {
    errorCorrectionLevel: opts.errorCorrection,
    margin: opts.border,
    scale: opts.boxSize,
    color: { dark: opts.fgColor, light: opts.bgColor },
  });
  return await canvas.convertToBlob({ type: 'image/png' });
}

async function renderBase64(text, opts) {
  const pngBlob = await renderPng(text, opts);
  const buf = await pngBlob.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  return `data:image/png;base64,${b64}`;
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function decodeAndUpscaleBase64(b64String, scale) {
  if (!hasOffscreenCanvas) throw new Error('Base64 image decoding needs OffscreenCanvas, which this browser worker does not support.');
  let raw = b64String;
  const commaIdx = raw.indexOf(',');
  if (commaIdx !== -1) raw = raw.slice(commaIdx + 1);
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width * scale, bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return await canvas.convertToBlob({ type: 'image/png' });
}

async function processRecord(record, opts) {
  const { name, value, rowIndex } = record;
  const safeName = sanitizeName(name);
  if (!safeName) {
    return { rowIndex, name, ok: false, error: `Invalid or empty name: '${name}'` };
  }
  if (value === undefined || value === null || value === '') {
    return { rowIndex, name: safeName, ok: false, error: 'Missing data value' };
  }

  try {
    if (opts.inputType === 'base64_image') {
      const blob = await decodeAndUpscaleBase64(String(value), opts.scale);
      return { rowIndex, name: safeName, ok: true, filename: `${safeName}.png`, blob };
    }

    if (opts.outputFormat === 'svg') {
      const blob = await renderSvg(String(value), opts);
      return { rowIndex, name: safeName, ok: true, filename: `${safeName}.svg`, blob };
    }
    if (opts.outputFormat === 'png') {
      const blob = await renderPng(String(value), opts);
      return { rowIndex, name: safeName, ok: true, filename: `${safeName}.png`, blob };
    }
    if (opts.outputFormat === 'base64') {
      const dataUri = await renderBase64(String(value), opts);
      return { rowIndex, name: safeName, ok: true, base64: dataUri };
    }
    throw new Error(`Unknown output format: ${opts.outputFormat}`);
  } catch (err) {
    return { rowIndex, name: safeName, ok: false, error: err && err.message ? err.message : String(err) };
  }
}

let currentDirHandle = null;

self.onmessage = async (evt) => {
  const { type } = evt.data;

  if (type === 'capabilities') {
    self.postMessage({ type: 'capabilities', hasOffscreenCanvas });
    return;
  }

  if (type === 'setDirHandle') {
    currentDirHandle = evt.data.dirHandle;
    return;
  }

  if (type === 'batch') {
    const { batchId, records, opts, target } = evt.data;
    const results = [];

    for (const record of records) {
      const result = await processRecord(record, opts);

      if (result.ok && target === 'folder' && result.blob) {
        // Write directly to the chosen directory to avoid ever holding the whole
        // dataset's files in memory at once — the point of the folder-save path.
        try {
          await writeToDirectory(currentDirHandle, result.filename, result.blob);
          result.blob = null; // already flushed to disk
        } catch (err) {
          result.ok = false;
          result.error = `Failed to write file: ${err.message}`;
        }
      }

      results.push(result);
    }

    self.postMessage({ type: 'batchDone', batchId, results });
  }
};

async function writeToDirectory(dirHandle, filename, blob) {
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}
