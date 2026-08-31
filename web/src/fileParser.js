// Reads the vendor libs exposed as globals by vendor/main-libs.bundle.js
// (loaded via a classic <script> tag in index.html before this module runs).
const { Papa, XLSX } = window.Vendor;

export function parseInputFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
    return parseCsv(file);
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return parseXlsx(file);
  }
  return Promise.reject(new Error('Unsupported file type. Please upload a .csv or .xlsx/.xls file.'));
}

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    // Note: intentionally not using Papa's `worker: true` mode — it relies on
    // locating its own script via document.currentScript to spin up a worker,
    // which doesn't resolve reliably once Papa is bundled into libs.bundle.js.
    // Parsing 50k+ rows here still only takes a second or two on the main thread.
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

async function parseXlsx(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
}
