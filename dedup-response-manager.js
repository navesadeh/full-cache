import { startHeartbeat, endHeartbeat, isOwnerAlive, channel } from './task-heartbeat-manager.js';
import { serializeResponse, deserializeResponse } from './response-serializer.js';
import { logger } from './logger.js';

/**
 * A wrapper around a promise that allows manual control over resolve/reject.
 *
 * @typedef {Object} Deferred
 * @property {Promise<Response>} promise - The promise to await
 * @property {(res: Response) => void} resolve - Resolves the promise with a `Response`
 * @property {(err: Error) => void} reject - Rejects the promise with an `Error`
 */

/**
 * Tracks all in-flight requests by cache key.
 * Each request is identified by a unique string key.
 *
 * @type {Map<string, Deferred>}
 */
const inFlightRequests = new Map();

/**
 * Deduplicates in-flight requests across tabs using a shared `BroadcastChannel`.
 *
 * If another tab already triggered the same request (identified by `key`), this function will
 * wait for that result. Otherwise, it will initiate the request using the provided `fetcher`.
 *
 * A heartbeat mechanism is used to monitor whether the original requester is still alive,
 * and a timeout is applied to avoid waiting indefinitely for abandoned requests.
 *
 * @param {string} key - Unique identifier for the request (usually a cache key)
 * @param {() => Promise<Response>} fetcher - Function that triggers the actual network request
 * @param {number} [timeoutMs=10000] - Timeout (in milliseconds) after which the request is aborted if the owner is unresponsive
 * @returns {Promise<Response>} Promise that resolves to the deduplicated response
 */
export async function getDedupedResponse(key, fetcher, timeoutMs = 10000) {
  if (inFlightRequests.has(key)) {
    logger.log('dedup', `Waiting for existing request with key '${key}'`);
    return inFlightRequests.get(key).promise;
  }

  const deferred = Promise.withResolvers();
  inFlightRequests.set(key, deferred);
  startHeartbeat(key);

  const timeoutId = setTimeout(() => {
    if (!isOwnerAlive(key)) {
      logger.log('dedup', `Aborting request with key '${key}' due to timeout`);
      inFlightRequests.delete(key);
      endHeartbeat(key);
      deferred.reject(new Error(`Timeout: no owner alive for key '${key}'`));
    }
    // If the owner is still alive, we let it resolve eventually.
  }, timeoutMs);

  try {
    const response = await fetcher();
    const serialized = await serializeResponse(response);

    channel.postMessage({ type: 'response-ready', key, response: serialized });

    deferred.resolve(response);
    return response;
  } catch (error) {
    logger.error('dedup', `Failed to fetch response for key '${key}': ${error}`);
    throw error;
  } finally {
    inFlightRequests.delete(key);
    endHeartbeat(key);
    clearTimeout(timeoutId);
  }
}

channel.addEventListener('message', event => {
  const { type, key, response: serialized } = event.data ?? {};

  if (type === 'response-ready' && inFlightRequests.has(key)) {
    try {
      const response = deserializeResponse(serialized);
      resolveFromOtherTab(key, response);
    } catch (error) {
      logger.error('dedup', `Failed to deserialize response for key '${key}': ${error}`);
    }
  }
});

/**
 * Resolves a pending request from another tab with a response that was sent via BroadcastChannel.
 * Used when a tab receives a message of type `'response-ready'`.
 *
 * @param {string} key - The key of the request to resolve
 * @param {Response} response - The `Response` object to resolve with
 */
export function resolveFromOtherTab(key, response) {
  const deferred = inFlightRequests.get(key);
  if (deferred) {
    deferred.resolve(response.clone());
    inFlightRequests.delete(key);
  }
}
