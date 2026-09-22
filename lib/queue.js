// Bounded local queue for payloads the node could not take (unreachable, 5xx, auth refused after
// one refresh). One JSON file per item in <home>/queue/. Bounds, both enforced on every enqueue:
//   - age:  items older than 7 days are dropped
//   - size: the queue never exceeds 50 MB; the oldest items are dropped until it fits
// "Oldest" is by file name, which starts with the enqueue time in ms zero-padded plus a counter,
// so ordering survives a clock that steps backwards within one process and degrades gracefully
// across processes. A dropped item is lost by design: the node's picture is a best-effort mirror,
// not a ledger, and an unbounded queue on a laptop is worse than a gap.

import { mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BYTES = 50 * 1024 * 1024;

let counter = 0;

function listItems(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const st = statSync(path);
      return { name, path, size: st.size, enqueuedAt: Number(name.slice(0, 15)) };
    });
}

/** Drops expired items, then the oldest until the size budget holds. Returns what was dropped. */
export function prune(dir, { now = Date.now(), maxAgeMs = MAX_AGE_MS, maxBytes = MAX_BYTES } = {}) {
  const dropped = [];
  let items = listItems(dir);
  for (const it of items) {
    if (now - it.enqueuedAt > maxAgeMs) {
      unlinkSync(it.path);
      dropped.push({ name: it.name, reason: 'age' });
    }
  }
  items = listItems(dir);
  let total = items.reduce((s, it) => s + it.size, 0);
  for (const it of items) {
    if (total <= maxBytes) break;
    unlinkSync(it.path);
    total -= it.size;
    dropped.push({ name: it.name, reason: 'size' });
  }
  return dropped;
}

/** Appends an item. The item itself is pruned away if it alone exceeds the size budget. */
export function enqueue(dir, item, opts = {}) {
  mkdirSync(dir, { recursive: true });
  const now = opts.now ?? Date.now();
  counter = (counter + 1) % 1000;
  const name = `${String(now).padStart(15, '0')}-${String(counter).padStart(3, '0')}-${randomBytes(3).toString('hex')}.json`;
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(item));
  const dropped = prune(dir, { ...opts, now });
  return { name, path, dropped };
}

/**
 * Hands items to `send(item)` oldest first. A truthy result removes the item; a falsy result
 * stops the drain (the node is still not taking them). A thrown error also stops the drain and
 * propagates. Returns { sent, remaining }.
 */
export async function drain(dir, send) {
  let sent = 0;
  const items = listItems(dir);
  for (const it of items) {
    const item = JSON.parse(readFileSync(it.path, 'utf8'));
    const ok = await send(item);
    if (!ok) return { sent, remaining: items.length - sent };
    unlinkSync(it.path);
    sent += 1;
  }
  return { sent, remaining: 0 };
}

export function size(dir) {
  const items = listItems(dir);
  return { count: items.length, bytes: items.reduce((s, it) => s + it.size, 0) };
}
