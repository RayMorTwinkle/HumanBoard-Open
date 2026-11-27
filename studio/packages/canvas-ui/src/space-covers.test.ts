import { expect, test } from "bun:test";
import { CoverQueue } from "./space-covers";
test("Space cover loading is bounded and cancelled queued covers never start", async () => {
  const queue = new CoverQueue(2),
    signal = new AbortController(),
    cancel = new AbortController();
  let running = 0,
    peak = 0,
    started = 0;
  const releases: (() => void)[] = [];
  const work = () =>
    new Promise<number>((resolve) => {
      started++;
      running++;
      peak = Math.max(peak, running);
      releases.push(() => {
        running--;
        resolve(started);
      });
    });
  const jobs = [
    queue.run(work, signal.signal),
    queue.run(work, signal.signal),
    queue.run(work, cancel.signal),
    queue.run(work, signal.signal),
  ];
  const all = Promise.allSettled(jobs);
  cancel.abort();
  await Promise.resolve();
  expect(started).toBe(2);
  expect(peak).toBe(2);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toBe(3);
  expect(peak).toBe(2);
  releases.splice(0).forEach((release) => release());
  expect((await all).filter((r) => r.status === "rejected")).toHaveLength(1);
});
