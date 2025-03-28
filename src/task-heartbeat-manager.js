/**
 * Broadcast-based heartbeat manager for cross-tab coordination.
 * Tracks task "liveness" (e.g. in-flight fetches) by emitting periodic signals over BroadcastChannel.
 * Allows other tabs to detect if a task is still active or abandoned.
 *
 * This module ensures only one unique task per cache key is running at a time, even across tabs.
 *
 * @typedef {Object} HeartbeatInfo
 * @property {number} timestamp Last heartbeat timestamp (ms since epoch)
 * @property {string} ownerId Unique ID of the task owner
 */

export const channel = new BroadcastChannel('api-cache-dedup');

/** @type {Map<string, HeartbeatInfo>} */
const heartbeats = new Map();

/** Unique ID for this tab instance */
const tabId = `${Date.now()}-${Math.random()}`;

/** @type {Map<string, number>} */
const intervals = new Map();

/** Interval in milliseconds between heartbeat pings */
const heartbeatIntervalMs = 500;

channel.addEventListener('message', event => {
  const { type, key, ownerId, timestamp } = event.data ?? {};

  switch (type) {
    case 'task-heartbeat':
      heartbeats.set(key, { timestamp, ownerId });
      break;
    case 'task-end':
      heartbeats.delete(key);
      break;
  }
});

/**
 * Starts broadcasting heartbeat messages for a specific task key.
 * Does nothing if a heartbeat is already running for the key in this tab.
 *
 * @param {string} key Unique task key (usually the cache key)
 */
export function startHeartbeat(key) {
  if (intervals.has(key)) return;

  heartbeats.set(key, { timestamp: Date.now(), ownerId: tabId });

  const intervalId = setInterval(() => {
    const timestamp = Date.now();

    channel.postMessage({
      type: 'task-heartbeat',
      key,
      ownerId: tabId,
      timestamp,
    });

    heartbeats.set(key, { timestamp, ownerId: tabId });
  }, heartbeatIntervalMs);

  intervals.set(key, intervalId);
}

/**
 * Stops broadcasting heartbeat messages for a given key.
 * Also informs other tabs that this task has ended.
 *
 * @param {string} key Task key whose heartbeat should stop
 */
export function endHeartbeat(key) {
  const id = intervals.get(key);
  if (id != null) {
    clearInterval(id);
    intervals.delete(key);
    channel.postMessage({ type: 'task-end', key });
  }
}

/**
 * Checks whether the task associated with a given key is still alive
 * (i.e. a heartbeat has been received recently).
 *
 * @param {string} key The task key to check
 * @returns {boolean} `true` if the task owner is considered alive, otherwise `false`
 */
export function isOwnerAlive(key) {
  const entry = heartbeats.get(key);
  return !!entry && Date.now() - entry.timestamp < heartbeatIntervalMs * 2;
}

/**
 * Disposes the heartbeat manager:
 * - Stops all heartbeats running in this tab
 * - Notifies other tabs that these tasks have ended
 * - Clears all internal state
 * - Closes the BroadcastChannel
 *
 * Call this when cleaning up (e.g. before tab unload)
 */
export function dispose() {
  for (const key of intervals.keys()) {
    endHeartbeat(key);
  }

  intervals.clear();
  heartbeats.clear();
  channel.close();
}
