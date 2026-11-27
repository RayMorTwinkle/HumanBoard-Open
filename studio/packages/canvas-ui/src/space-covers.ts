/** Shared bounded queue: a large overview must not rasterize every Space at once. */
export class CoverQueue {
  private active = 0;
  private jobs: (() => void)[] = [];
  constructor(private readonly concurrency = 3) {}
  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push(() => {
        if (signal.aborted) {
          reject(new DOMException("Cancelled", "AbortError"));
          return;
        }
        this.active++;
        Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.pump();
          });
      });
      this.pump();
    });
  }
  private pump() {
    while (this.active < this.concurrency && this.jobs.length)
      this.jobs.shift()!();
  }
}
export const spaceCoverQueue = new CoverQueue();
