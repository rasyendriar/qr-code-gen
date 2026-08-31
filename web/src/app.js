import { parseInputFile } from './fileParser.js';
import { WorkerPool } from './workerPool.js';
import { ChunkedZipWriter } from './zipWriter.js';
import { StreamingCsvWriter } from './csvWriter.js';
import { sanitizeName, formatDuration, rowsToCsv, downloadBlob, loadSettings, saveSettings } from './util.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'qrgen-settings-v1';
const THEME_KEY = 'qrgen-theme';
const SUPPORTS_FOLDER_SAVE = 'showDirectoryPicker' in window;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let rawRows = []; // array of arrays, straight from the parser
let uploadedFileBaseName = 'qrcodes';
let records = []; // built after column mapping + validation: {rowIndex, name, value}
let validated = false;
let activePool = null;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
(function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME_KEY, next);
  });
})();

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------
const SETTINGS_FIELDS = [
  ['output-format', 'value'],
  ['error-correction', 'value'],
  ['box-size', 'value'],
  ['border', 'value'],
  ['fg-color', 'value'],
  ['bg-color', 'value'],
  ['upscale-factor', 'value'],
  ['worker-count', 'value'],
  ['batch-size', 'value'],
  ['zip-part-size', 'value'],
];

function restoreSettings() {
  const defaults = {
    'output-format': 'svg',
    'error-correction': 'H',
    'box-size': '10',
    border: '4',
    'fg-color': '#000000',
    'bg-color': '#ffffff',
    'upscale-factor': '10',
    'worker-count': String(Math.max(1, (navigator.hardwareConcurrency || 4) - 1)),
    'batch-size': '250',
    'zip-part-size': '5000',
  };
  const saved = loadSettings(SETTINGS_KEY, defaults);
  for (const [id] of SETTINGS_FIELDS) {
    if ($(id) && saved[id] !== undefined) $(id).value = saved[id];
  }
}

function persistSettings() {
  const values = {};
  for (const [id] of SETTINGS_FIELDS) values[id] = $(id).value;
  saveSettings(SETTINGS_KEY, values);
}

for (const [id] of SETTINGS_FIELDS) {
  $(id).addEventListener('change', persistSettings);
}

restoreSettings();

if (!SUPPORTS_FOLDER_SAVE) {
  $('target-folder').disabled = true;
  $('folder-unsupported').classList.remove('hidden');
  $('target-zip').checked = true;
}

// ---------------------------------------------------------------------------
// Step 1: Upload
// ---------------------------------------------------------------------------
const dropzone = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

$('sample-template-btn').addEventListener('click', () => {
  const csv = rowsToCsv(['name', 'url'], [
    ['item-001', 'https://example.com/product/001'],
    ['item-002', 'https://example.com/product/002'],
    ['item-003', 'https://example.com/product/003'],
  ]);
  downloadBlob(new Blob([csv], { type: 'text/csv' }), 'qr-sample-template.csv');
});

async function handleFile(file) {
  $('file-info').textContent = `Reading ${file.name}...`;
  try {
    rawRows = await parseInputFile(file);
    uploadedFileBaseName = file.name.replace(/\.[^.]+$/, '') || 'qrcodes';
    if (!rawRows.length) throw new Error('The file has no rows.');
    $('file-info').textContent = `${file.name} — ${rawRows.length.toLocaleString()} rows loaded.`;
    populateColumnStep();
    show('step-columns');
    show('step-options');
    show('step-generate');
    resetValidation();
  } catch (err) {
    $('file-info').textContent = `Error: ${err.message}`;
  }
}

function show(id) {
  $(id).classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Step 2: Columns & preview
// ---------------------------------------------------------------------------
function maxColumnCount(rows) {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function populateColumnStep() {
  const colCount = maxColumnCount(rawRows);
  const nameSelect = $('name-col');
  const dataSelect = $('data-col');
  nameSelect.innerHTML = '';
  dataSelect.innerHTML = '';

  const headerRow = $('has-header').checked ? rawRows[0] : null;
  for (let i = 0; i < colCount; i++) {
    const label = headerRow && headerRow[i] !== undefined && headerRow[i] !== '' ? `${headerRow[i]} (col ${i + 1})` : `Column ${i + 1}`;
    const optA = new Option(label, String(i));
    const optB = new Option(label, String(i));
    nameSelect.add(optA);
    dataSelect.add(optB);
  }
  nameSelect.value = '0';
  dataSelect.value = colCount > 1 ? '1' : '0';

  renderPreviewTable();
  autoDetectInputType();
}

function renderPreviewTable() {
  const table = $('preview-table');
  const hasHeader = $('has-header').checked;
  const dataRows = hasHeader ? rawRows.slice(1) : rawRows;
  const previewRows = dataRows.slice(0, 15);
  const colCount = maxColumnCount(rawRows);

  const headerCells = hasHeader
    ? rawRows[0]
    : Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);

  table.innerHTML = '';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (let i = 0; i < colCount; i++) {
    const th = document.createElement('th');
    th.textContent = headerCells[i] ?? `Column ${i + 1}`;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of previewRows) {
    const tr = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
      const td = document.createElement('td');
      td.textContent = row[i] ?? '';
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const total = dataRows.length;
  $('row-count-note').textContent = `Showing ${Math.min(15, total).toLocaleString()} of ${total.toLocaleString()} data rows.`;
}

$('has-header').addEventListener('change', () => {
  populateColumnStep();
  resetValidation();
});
$('name-col').addEventListener('change', resetValidation);
$('data-col').addEventListener('change', () => {
  autoDetectInputType();
  resetValidation();
});

function applyInputTypeVisibility() {
  const isBase64Image = $('input-type').value === 'base64_image';
  $('output-format-field').classList.toggle('hidden', isBase64Image);
  $('box-size-field').classList.toggle('hidden', isBase64Image);
  $('fg-color-field').classList.toggle('hidden', isBase64Image);
  $('bg-color-field').classList.toggle('hidden', isBase64Image);
  $('upscale-field').classList.toggle('hidden', !isBase64Image);
}

$('input-type').addEventListener('change', () => {
  applyInputTypeVisibility();
  $('input-type-note').classList.add('hidden'); // manual choice overrides the auto-detect hint
  resetValidation();
});

// A base64 data: URI is unmistakable and unencodable as new QR data (a QR code
// tops out around 4,296 characters, these run into the thousands), so if the
// data column looks like one, switch modes automatically instead of making
// every user learn to flip this dropdown themselves.
function looksLikeBase64Image(value) {
  if (typeof value !== 'string') return false;
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim());
}

function autoDetectInputType() {
  const dataColIdx = Number($('data-col').value);
  const hasHeader = $('has-header').checked;
  const dataRows = hasHeader ? rawRows.slice(1) : rawRows;
  const sample = dataRows.slice(0, 10).map((row) => row[dataColIdx]);
  if (!sample.length) return;

  const matchCount = sample.filter(looksLikeBase64Image).length;
  const note = $('input-type-note');
  if (matchCount / sample.length >= 0.5) {
    $('input-type').value = 'base64_image';
    applyInputTypeVisibility();
    note.textContent = '🔎 Detected base64 image data in this column — switched "Data column contains" to base64 image decode mode automatically.';
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
}

$('output-format').addEventListener('change', resetValidation);

for (const radio of document.querySelectorAll('input[name="target"]')) {
  radio.addEventListener('change', updateTargetVisibility);
}
function updateTargetVisibility() {
  const isZip = $('target-zip').checked;
  $('zip-part-size-field').classList.toggle('hidden', !isZip);
}
updateTargetVisibility();

// ---------------------------------------------------------------------------
// Building & validating records
// ---------------------------------------------------------------------------
function buildRecords() {
  const nameColIdx = Number($('name-col').value);
  const dataColIdx = Number($('data-col').value);
  const hasHeader = $('has-header').checked;
  const dataRows = hasHeader ? rawRows.slice(1) : rawRows;

  return dataRows.map((row, i) => ({
    rowIndex: hasHeader ? i + 2 : i + 1, // 1-based, human-friendly, header-aware
    name: row[nameColIdx],
    value: row[dataColIdx],
  }));
}

function resetValidation() {
  validated = false;
  $('validation-summary').classList.add('hidden');
  $('preview-output').classList.add('hidden');
}

$('validate-btn').addEventListener('click', () => {
  records = buildRecords();
  const seen = new Map();
  let missing = 0;
  let duplicates = 0;

  for (const rec of records) {
    const safe = sanitizeName(rec.name);
    if (!safe || rec.value === undefined || rec.value === null || rec.value === '') {
      missing++;
      continue;
    }
    seen.set(safe, (seen.get(safe) || 0) + 1);
  }
  for (const count of seen.values()) {
    if (count > 1) duplicates += count;
  }

  const valid = records.length - missing;
  validated = true;

  const summary = $('validation-summary');
  summary.classList.remove('hidden');
  summary.classList.toggle('has-errors', missing > 0 || duplicates > 0);
  summary.innerHTML = `
    <strong>${records.length.toLocaleString()}</strong> rows checked &middot;
    <strong>${valid.toLocaleString()}</strong> ready to generate
    ${missing ? ` &middot; <strong>${missing.toLocaleString()}</strong> missing name/data (will be skipped)` : ''}
    ${duplicates ? ` &middot; <strong>${duplicates.toLocaleString()}</strong> rows share a duplicate name (later ones will overwrite earlier files with the same name)` : ''}
  `;
});

$('preview-btn').addEventListener('click', async () => {
  const recs = buildRecords().filter((r) => sanitizeName(r.name) && r.value);
  if (!recs.length) {
    alert('No valid rows to preview yet. Check your column mapping.');
    return;
  }
  const opts = readGenerationOptions();
  const previewOutput = $('preview-output');
  previewOutput.classList.remove('hidden');
  previewOutput.innerHTML = '<span class="muted">Rendering preview…</span>';

  try {
    const result = await renderSinglePreview(recs[0], opts);
    if (!result.ok) throw new Error(result.error);
    let imgSrc;
    if (result.base64) {
      imgSrc = result.base64;
    } else {
      imgSrc = URL.createObjectURL(result.blob);
    }
    previewOutput.innerHTML = '';
    const img = document.createElement('img');
    img.src = imgSrc;
    const label = document.createElement('span');
    label.className = 'muted';
    label.textContent = `Preview for "${recs[0].name}"`;
    previewOutput.appendChild(img);
    previewOutput.appendChild(label);
  } catch (err) {
    previewOutput.innerHTML = `<span class="warning">${err.message}</span>`;
  }
});

function renderSinglePreview(record, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./qrWorker.js', import.meta.url));
    worker.onmessage = (evt) => {
      if (evt.data.type === 'batchDone') {
        worker.terminate();
        resolve(evt.data.results[0]);
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage({ type: 'batch', batchId: 0, records: [record], opts, target: 'preview' });
  });
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
function readGenerationOptions() {
  return {
    inputType: $('input-type').value,
    outputFormat: $('output-format').value,
    errorCorrection: $('error-correction').value,
    boxSize: Number($('box-size').value) || 10,
    border: Number($('border').value) || 4,
    fgColor: $('fg-color').value,
    bgColor: $('bg-color').value,
    scale: Number($('upscale-factor').value) || 10,
  };
}

// ---------------------------------------------------------------------------
// Step 4: Generate
// ---------------------------------------------------------------------------
const generateBtn = $('generate-btn');
const pauseBtn = $('pause-btn');
const cancelBtn = $('cancel-btn');
const progressWrap = $('progress-wrap');
const resultPanel = $('result-panel');

pauseBtn.addEventListener('click', () => {
  if (!activePool) return;
  if (activePool.paused) {
    activePool.resume();
    pauseBtn.textContent = 'Pause';
  } else {
    activePool.pause();
    pauseBtn.textContent = 'Resume';
  }
});

cancelBtn.addEventListener('click', () => {
  if (activePool) activePool.abort();
});

generateBtn.addEventListener('click', async () => {
  const allRecords = buildRecords();
  if (!allRecords.length) {
    alert('Upload a file first.');
    return;
  }

  const target = $('target-zip').checked ? 'zip' : 'folder';
  let dirHandle = null;

  // Must request the directory picker synchronously in the click handler
  // (before any other awaits) so the browser still treats it as user-initiated.
  if (target === 'folder') {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
      return; // user cancelled the picker
    }
  }

  const opts = readGenerationOptions();
  const workerCount = Math.max(1, Math.min(32, Number($('worker-count').value) || 4));
  const batchSize = Math.max(1, Number($('batch-size').value) || 250);
  const zipPartSize = Math.max(1, Number($('zip-part-size').value) || 5000);

  setRunningUiState(true);
  resultPanel.classList.add('hidden');
  progressWrap.classList.remove('hidden');

  const pool = new WorkerPool(workerCount, new URL('./qrWorker.js', import.meta.url));
  activePool = pool;

  const caps = await pool.ready();
  const canUseCanvas = caps.some((c) => c.hasOffscreenCanvas);
  const needsCanvas = opts.inputType === 'base64_image' || opts.outputFormat === 'png' || opts.outputFormat === 'base64';
  if (needsCanvas && !canUseCanvas) {
    pool.terminate();
    activePool = null;
    setRunningUiState(false);
    showResult({ cancelled: false, error: 'This browser does not support PNG rendering in a background worker (needs OffscreenCanvas). Please use SVG output, or switch to Chrome/Edge/Firefox (current version).' });
    return;
  }

  if (target === 'folder') pool.setDirHandle(dirHandle);

  const validRecords = allRecords.filter((r) => sanitizeName(r.name) && r.value !== undefined && r.value !== null && r.value !== '');
  const batches = [];
  for (let i = 0; i < validRecords.length; i += batchSize) {
    batches.push({ batchId: i, records: validRecords.slice(i, i + batchSize) });
  }

  let zipWriter = null;
  let csvWriter = null;
  if (opts.outputFormat === 'base64' && opts.inputType !== 'base64_image') {
    csvWriter = new StreamingCsvWriter({
      baseName: `${uploadedFileBaseName}_base64_output`,
      headers: ['name_tag', 'base64_qr'],
      target,
      dirHandle,
      partSize: zipPartSize,
    });
    await csvWriter.init();
  } else if (target === 'zip') {
    zipWriter = new ChunkedZipWriter(uploadedFileBaseName, zipPartSize);
  }

  const manifestRows = [];
  const errorRows = [];
  let success = 0;
  let errors = 0;
  const total = validRecords.length;
  const skipped = allRecords.length - total;
  const startTime = performance.now();

  const onBatchDone = async (results) => {
    for (const r of results) {
      if (r.ok) {
        success++;
        if (r.base64 !== undefined) {
          await csvWriter.addRow([r.name, r.base64]);
          manifestRows.push([r.rowIndex, r.name, '(base64 csv)', 'success', '']);
        } else {
          if (zipWriter) await zipWriter.add(r.filename, r.blob);
          manifestRows.push([r.rowIndex, r.name, r.filename, 'success', '']);
        }
      } else {
        errors++;
        errorRows.push([r.rowIndex, r.name ?? '', r.error]);
        manifestRows.push([r.rowIndex, r.name ?? '', '', 'error', r.error]);
      }
    }
    updateProgress(success + errors, total, success, errors, startTime);
  };

  // Batches from different workers can complete in overlapping ticks; chaining
  // every onBatchDone call through one promise keeps zip/CSV writes strictly
  // sequential so a flush never races an add() into the archive it just reset.
  let writeQueue = Promise.resolve();
  updateProgress(0, total, 0, 0, startTime);
  await pool.run(batches, opts, target, (results) => {
    writeQueue = writeQueue.then(() => onBatchDone(results));
  });
  await writeQueue;

  if (zipWriter) await zipWriter.finish();
  if (csvWriter) await csvWriter.finish();

  pool.terminate();
  activePool = null;
  setRunningUiState(false);

  const cancelled = pool.aborted;
  const elapsed = (performance.now() - startTime) / 1000;
  showResult({
    cancelled,
    total: allRecords.length,
    processed: success + errors,
    success,
    errors,
    skipped,
    elapsed,
    manifestRows,
    errorRows,
  });
});

function setRunningUiState(running) {
  generateBtn.disabled = running;
  pauseBtn.disabled = !running;
  cancelBtn.disabled = !running;
  pauseBtn.textContent = 'Pause';
  if (!running) progressWrap.classList.add('hidden');
}

function updateProgress(processed, total, success, errors, startTime) {
  const pct = total ? Math.min(100, (processed / total) * 100) : 0;
  $('progress-fill').style.width = `${pct}%`;
  $('stat-progress').textContent = `${processed.toLocaleString()} / ${total.toLocaleString()}`;
  $('stat-success').textContent = `✅ ${success.toLocaleString()}`;
  $('stat-errors').textContent = `⚠️ ${errors.toLocaleString()}`;

  const elapsedSec = (performance.now() - startTime) / 1000;
  const speed = elapsedSec > 0 ? processed / elapsedSec : 0;
  $('stat-speed').textContent = `${speed.toFixed(1)} codes/s`;
  const remaining = total - processed;
  $('stat-eta').textContent = speed > 0 ? `ETA ${formatDuration(remaining / speed)}` : 'ETA --';
}

function showResult({ cancelled, error, total, processed, success, errors, skipped, elapsed, manifestRows, errorRows }) {
  resultPanel.classList.remove('hidden');

  if (error) {
    resultPanel.innerHTML = `<h3>Couldn't run</h3><p class="warning">${error}</p>`;
    return;
  }

  resultPanel.innerHTML = `
    <h3>${cancelled ? 'Cancelled' : 'Done'}</h3>
    <p>
      Processed <strong>${processed.toLocaleString()}</strong> of ${total.toLocaleString()} rows in ${formatDuration(elapsed)}
      (${(processed / Math.max(elapsed, 0.001)).toFixed(1)} codes/s).<br/>
      ✅ ${success.toLocaleString()} succeeded &middot; ⚠️ ${errors.toLocaleString()} errors ${skipped ? `&middot; ${skipped.toLocaleString()} skipped (missing name/data)` : ''}
    </p>
  `;

  const manifestBtn = document.createElement('button');
  manifestBtn.className = 'btn btn-secondary';
  manifestBtn.textContent = 'Download manifest CSV';
  manifestBtn.addEventListener('click', () => {
    const csv = rowsToCsv(['row', 'name', 'filename', 'status', 'error'], manifestRows);
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `${uploadedFileBaseName}_manifest.csv`);
  });
  resultPanel.appendChild(manifestBtn);

  if (errorRows.length) {
    const errBtn = document.createElement('button');
    errBtn.className = 'btn btn-secondary';
    errBtn.textContent = `Download error report (${errorRows.length.toLocaleString()})`;
    errBtn.addEventListener('click', () => {
      const csv = rowsToCsv(['row', 'name', 'error'], errorRows);
      downloadBlob(new Blob([csv], { type: 'text/csv' }), `${uploadedFileBaseName}_errors.csv`);
    });
    resultPanel.appendChild(errBtn);
  }
}
