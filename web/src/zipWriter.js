import { downloadBlob } from './util.js';

const { JSZip } = window.Vendor;

// Bounds peak memory by flushing a zip part to disk every `partSize` files
// instead of holding one giant JSZip for the entire 50k+ run.
export class ChunkedZipWriter {
  constructor(baseName, partSize) {
    this.baseName = baseName;
    this.partSize = partSize;
    this.partIndex = 1;
    this.countInPart = 0;
    this.zip = new JSZip();
    this.totalParts = 0;
  }

  async add(filename, blob) {
    this.zip.file(filename, blob);
    this.countInPart++;
    if (this.countInPart >= this.partSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this.countInPart === 0) return;
    const blob = await this.zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(blob, `${this.baseName}-part${this.partIndex}.zip`);
    this.totalParts++;
    this.partIndex++;
    this.countInPart = 0;
    this.zip = new JSZip();
  }

  async finish() {
    await this.flush();
  }
}
