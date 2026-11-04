// A keyed background queue for sidecar writes. The catalogue hooks run inside the
// core's commit under a timeout, so they hand their work here and return. One
// job per key runs at a time (two writers on one sidecar would each read the
// other's stale copy), and a job queued again before it starts is folded into
// the waiting one instead of writing twice.

export interface QueueFailure<T> {
  job: T;
  error: unknown;
}

export interface KeyedQueueOptions<T> {
  concurrency: number;
  run(job: T): Promise<void>;
  /** Fold a newly queued job into the one still waiting under its key. */
  merge(waiting: T, next: T): T;
  /** Called each time the queue drains, with the jobs that threw since the last drain. */
  onDrain(failures: QueueFailure<T>[]): void;
}

export interface KeyedQueue<T> {
  push(key: string, job: T): void;
  /** Drop a job that hasn't started; one already running finishes. */
  cancel(key: string): void;
  /** Resolves once no job for `key` is running. */
  settled(key: string): Promise<void>;
}

export function createKeyedQueue<T>(opts: KeyedQueueOptions<T>): KeyedQueue<T> {
  const waiting = new Map<string, T>();
  const running = new Map<string, Promise<void>>();
  let failures: QueueFailure<T>[] = [];

  const start = (key: string, job: T) => {
    const done = Promise.resolve()
      .then(() => opts.run(job))
      .catch((error: unknown) => {
        failures.push({ job, error });
      })
      .finally(() => {
        running.delete(key);
        pump();
        if (running.size === 0 && waiting.size === 0) {
          const drained = failures;
          failures = [];
          opts.onDrain(drained);
        }
      });
    running.set(key, done);
  };

  const pump = () => {
    for (const [key, job] of waiting) {
      if (running.size >= opts.concurrency) return;
      if (running.has(key)) continue;
      waiting.delete(key);
      start(key, job);
    }
  };

  return {
    push(key, job) {
      const prev = waiting.get(key);
      waiting.set(key, prev === undefined ? job : opts.merge(prev, job));
      pump();
    },
    cancel(key) {
      waiting.delete(key);
    },
    async settled(key) {
      for (let job = running.get(key); job; job = running.get(key)) await job;
    },
  };
}
