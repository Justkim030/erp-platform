'use client';

/**
 * Offline clock-event queue.
 *
 * When the network is unavailable at the moment a worker taps Clock in/out, the
 * reading is captured and stored locally, and drained automatically when
 * connectivity returns. Design rules:
 *
 * - The captured timestamp (`capturedAt`) is the moment of the tap, never the
 *   moment of the retry. The server's staleness check will honestly flag old
 *   readings as review-worthy rather than the client fabricating fresh times.
 * - Every entry records which attempt(s) failed and the last HTTP status, so the
 *   UI can show the worker what is waiting and what happened.
 * - Entries are capped (20) to bound storage; the oldest are dropped first —
 *   realistically a worker has at most one or two pending events.
 * - This queue never holds credentials; requests are retried through the normal
 *   BFF route, which refreshes the session if needed.
 */

export type QueuedClockEvent = {
  id: string; // uuid for the queue entry
  kind: 'in' | 'out';
  siteId?: string;
  reading?: { lat: number; lng: number; accuracy: number; capturedAt: string };
  requestReview?: boolean;
  workSummary?: string; // clock-out only
  createdAt: number;    // queue entry creation (ms epoch)
  attempts: number;
  lastStatus?: number;  // last HTTP status from the server, if any
  lastErrorAt?: number;
};

const KEY = 'ph_clock_queue';
const MAX_ENTRIES = 20;

function read(): QueuedClockEvent[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
function write(list: QueuedClockEvent[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES))); } catch { /* private mode: queue unavailable, still shows online error */ }
}

export function enqueue(event: Omit<QueuedClockEvent, 'id' | 'attempts'>): QueuedClockEvent {
  const entry: QueuedClockEvent = { ...event, id: crypto.randomUUID(), attempts: 0 };
  const list = read();
  list.push(entry);
  write(list);
  return entry;
}

export function pending(): QueuedClockEvent[] {
  return read();
}

export function count(): number {
  return read().length;
}

export async function clear(): Promise<void> {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}

/** Marks an entry as attempted. `outcome: 'failed'` keeps it for the next drain. */
export async function markAttempted(id: string, outcome: 'succeeded' | 'failed', status?: number): Promise<void> {
  if (outcome === 'succeeded') {
    write(read().filter((e) => e.id !== id));
    return;
  }
  const list = read().map((e) => e.id === id
    ? { ...e, attempts: e.attempts + 1, lastStatus: status, lastErrorAt: Date.now() }
    : e);
  write(list);
}

/**
 * Network failure detection: distinguish "could not reach the server" (queue it)
 * from "the server answered" (show its decision; only 5xx may be queued).
 */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError; // fetch throws TypeError on network failure
}
