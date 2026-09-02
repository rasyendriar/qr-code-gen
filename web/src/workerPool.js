// A small pull-based pool: idle workers ask for the next batch, so fast and
// slow batches (e.g. base64 decode vs plain SVG) naturally load-balance
// instead of a fixed static split running some workers dry early.
export class WorkerPool {
  constructor(size, workerUrl) {
    this.workers = Array.from({ length: size }, () => new Worker(workerUrl));
    this.busy = new Set();
    this.paused = false;
    this.aborted = false;
  }

  async ready() {
    return Promise.all(
      this.workers.map(
        (w) =>
          new Promise((resolve) => {
            const onMsg = (evt) => {
              if (evt.data.type === 'capabilities') {
                w.removeEventListener('message', onMsg);
                resolve(evt.data);
              }
            };
            w.addEventListener('message', onMsg);
            w.postMessage({ type: 'capabilities' });
          })
      )
    );
  }

  setDirHandle(dirHandle) {
    for (const w of this.workers) w.postMessage({ type: 'setDirHandle', dirHandle });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this._pump();
  }

  abort() {
    this.aborted = true;
    for (const w of this.workers) w.terminate();
    if (this._resolveRun) {
      this._resolveRun();
      this._resolveRun = null;
    }
  }

  // batches: array of { batchId, records }; opts/target apply to all batches.
  // onBatchDone(results) is called as each batch completes.
  // Returns a promise that resolves once every batch has been processed (or aborted).
  run(batches, opts, target, onBatchDone) {
    return new Promise((resolve) => {
      this._resolveRun = resolve;
      let nextIndex = 0;
      let remaining = batches.length;
      if (remaining === 0) {
        resolve();
        return;
      }

      const dispatch = (worker) => {
        if (this.aborted) return;
        if (this.paused) return;
        if (nextIndex >= batches.length) return;
        const batch = batches[nextIndex++];
        this.busy.add(worker);
        worker.postMessage({ type: 'batch', batchId: batch.batchId, records: batch.records, opts, target });
      };

      for (const worker of this.workers) {
        // Wait for onBatchDone (writing/zipping this batch) before handing the
        // worker another one. Without this, generation — which is fast and
        // parallel — races far ahead of archiving — which is slower and
        // serialized — so results pile up and the UI only sees them in a
        // burst whenever a ZIP part finally finishes compressing. Awaiting
        // here caps how far ahead generation can get, which both bounds
        // memory and keeps progress updates arriving smoothly.
        const handler = async (evt) => {
          if (evt.data.type !== 'batchDone') return;
          // Stay marked busy through the await so a pause/resume in the
          // meantime can't have _pump() hand this worker a second batch
          // before its current one has actually finished writing.
          await onBatchDone(evt.data.results);
          this.busy.delete(worker);
          remaining--;
          if (remaining <= 0) {
            for (const w of this.workers) w.removeEventListener('message', w.__poolHandler);
            resolve();
            return;
          }
          if (!this.aborted) dispatch(worker);
        };
        worker.__poolHandler = handler;
        worker.addEventListener('message', handler);
        dispatch(worker);
      }

      this._pumpFn = () => {
        for (const worker of this.workers) {
          if (!this.busy.has(worker)) dispatch(worker);
        }
      };
    });
  }

  _pump() {
    if (this._pumpFn) this._pumpFn();
  }

  terminate() {
    for (const w of this.workers) w.terminate();
  }
}
