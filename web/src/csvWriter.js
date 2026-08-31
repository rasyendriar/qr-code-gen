import { csvEscape, downloadBlob } from './util.js';

// Used for the "Base64 CSV" output format: writes name,base64 rows either
// straight to a file in the chosen folder (streamed, so 50k+ rows never sit
// fully in memory) or as downloaded CSV parts capped at `partSize` rows.
export class StreamingCsvWriter {
  constructor({ baseName, headers, target, dirHandle, partSize }) {
    this.baseName = baseName;
    this.headers = headers;
    this.target = target;
    this.dirHandle = dirHandle;
    this.partSize = partSize;
    this.partIndex = 1;
    this.countInPart = 0;
    this.buffer = [];
    this.writable = null;
  }

  async init() {
    if (this.target === 'folder') {
      const fileHandle = await this.dirHandle.getFileHandle(`${this.baseName}.csv`, { create: true });
      this.writable = await fileHandle.createWritable();
      await this.writable.write(this.headers.map(csvEscape).join(',') + '\n');
    }
  }

  async addRow(row) {
    const line = row.map(csvEscape).join(',') + '\n';
    if (this.target === 'folder') {
      await this.writable.write(line);
      return;
    }
    this.buffer.push(line);
    this.countInPart++;
    if (this.countInPart >= this.partSize) {
      await this.flush();
    }
  }

  async flush() {
    if (this.target === 'folder' || this.buffer.length === 0) return;
    const content = this.headers.map(csvEscape).join(',') + '\n' + this.buffer.join('');
    const blob = new Blob([content], { type: 'text/csv' });
    downloadBlob(blob, `${this.baseName}-part${this.partIndex}.csv`);
    this.partIndex++;
    this.countInPart = 0;
    this.buffer = [];
  }

  async finish() {
    if (this.target === 'folder') {
      await this.writable.close();
      return;
    }
    await this.flush();
  }
}
