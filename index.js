/* global globalThis */
/// <reference lib="webworker" />

import { logger } from './logger.js';
import { CacheConfigStore } from './cache-config-store.js';
import { CacheConfigSyncClient } from './cache-config-sync-client.js';
import { APICacheManager } from './api-cache-manager.js';
import { getResponse, debounce, singleton } from './utils.js';
import { FallbackPollingManager } from './fallback-polling-manager.js';
import { dispose } from './task-heartbeat-manager.js';

/**
 * The `ServiceWorkerGlobalScope` context for this service worker.
 * @type {ServiceWorkerGlobalScope}
 */
const self = globalThis.self;

/**
 * The name of the custom response header used to store the cache timestamp.
 */
const cacheTimestampHeader = 'x-cache-timestamp';

/**
 * @typedef {Object} Environment
 * @property {string} cacheName the name of the cache to be managed
 * @property {string} websocketServerUrl the URL of the WebSocket server for cache config updates
 * @property {string[]} [ignoreOrigins]
 * @property {string} [fallbackPollingServerUrl] the URL for fallback polling requests
 * @property {number} [fallbackPollingIntervalMs] the interval for fallback polling in milliseconds
 */

/**
 * @type {Environment | null}
 */
let env = null;

/**
 * Manages the underlying `CacheStorage` using the provided `cacheName`.
 * @type {() => APICacheManager}
 */
const getApiCacheManager = singleton(() => new APICacheManager(globalThis.caches, env.cacheName));

/**
 * Handles the current in-memory cache configuration and updates via `WebSocket`.
 * Clears the cache whenever the configuration is reset or becomes invalid.
 */
const cacheConfigStore = new CacheConfigStore({
  onReset: async () => {
    const apiCacheManager = getApiCacheManager();
    await apiCacheManager.clear();
    getPollingManager()?.stop();
  },
  onSet: async () => {
    const apiCacheManager = getApiCacheManager();
    await apiCacheManager.deleteStaleEntries(cacheConfigStore, cacheTimestampHeader);
    await debouncedWarmUpCache(['on-update', 'always']);
  },
});

/**
 * Manages fallback polling when WebSocket is unavailable.
 * @type {() => FallbackPollingManager}
 */
const getPollingManager = singleton(() => {
  if (env.fallbackPollingIntervalMs && env.fallbackPollingServerUrl) {
    logger.info('polling', 'Fallback polling is enabled');
    return new FallbackPollingManager({
      pollingIntervalMs: env.fallbackPollingIntervalMs,
      onPoll: () => {
        logger.info('polling', 'Triggered fallback polling for config update');
        return getCacheConfigSyncClient().poll();
      },
    });
  } else {
    logger.info('polling', 'Fallback polling is disabled');
  }
});

/**
 * Establishes a `WebSocket` connection to receive live updates to the cache configuration.
 * Updates the cache config controller when new configurations are received.
 * @type {() => CacheConfigSyncClient}
 */
const getCacheConfigSyncClient = singleton(
  () =>
    new CacheConfigSyncClient(env.websocketServerUrl, {
      onReceiveNewCacheConfig: cacheConfigStore.set,
      onDisconnect: async () => {
        await cacheConfigStore.reset();
        getPollingManager()?.start();
      },
      onConnect: async () => {
        getPollingManager()?.stop();
        await debouncedWarmUpCache(['on-update', 'always']);
      },
      fallbackPollingServerUrl: env.fallbackPollingServerUrl,
    })
);

/**
 * Handles the `install` lifecycle event of the service worker.
 * Forces the service worker to become active immediately.
 * This is useful for updating the service worker without waiting for the next page load.
 */
self.addEventListener('install', event => {
  const { searchParams } = new URL(self.location);

  try {
    env = JSON.parse(searchParams.get('env') || '{}');

    if (!env.cacheName || !env.websocketServerUrl) {
      logger.error('install', 'Missing required environment variables');
    } else {
      event.waitUntil(connect().then(() => self.skipWaiting()));
      return;
    }
  } catch (error) {
    logger.error('install', `Failed to parse environment variables: ${error}`);
  }

  event.waitUntil(self.skipWaiting());
});

/**
 * Handles the `activate` lifecycle event of the service worker.
 * Initializes the `WebSocket` connection to start receiving cache configuration updates.
 */
self.addEventListener('activate', event => {
  event.waitUntil(connect());
});

async function connect() {
  try {
    await getCacheConfigSyncClient().connect();

    if (!cacheConfigStore.current) {
      await cacheConfigStore.loadFromCacheIfValid();
    }
  } catch (error) {
    logger.error('activate', `Failed to connect via WebSocket: ${error}`);
    getPollingManager()?.start();
  }
}

/**
 * Handles the `message` event from the client.
 * Used to trigger cache warm-up requests.
 * @param {Request} request the request to warm up the cache for
 * @returns {Promise<Response>} a promise that resolves to the response for the given request
 */
async function connectAndFetch(request) {
  await connect();
  const endpointCacheConfig = cacheConfigStore.resolveRequestSettings(request, env.ignoreOrigins);

  if (endpointCacheConfig) {
    const cache = await globalThis.caches.open(env.cacheName);
    return await getResponse(request, cacheTimestampHeader, cacheConfigStore, cache);
  }

  return await fetch(request);
}

/**
 * Intercepts `fetch` events and attempts to serve matching requests from the cache.
 * If the request is configured to be cached, a response will be served from cache
 * (if available and valid) or fetched from the network and cached.
 */
self.addEventListener('fetch', event => {
  event.respondWith(connectAndFetch(event.request));
});

self.addEventListener('deactivate', event => {
  event.waitUntil(dispose());
});

/**
 * Prefetches and caches requests based on the current config and given prefetch modes.
 *
 * @param {PrefetchMode[]} modes list of prefetch modes to include (e.g. ['on-load'])
 * @returns {Promise<void>}
 */
async function warmUpCache(modes) {
  const prefetchRequests = cacheConfigStore.getPrefetchRequests(modes);
  const cache = await globalThis.caches.open(env.cacheName);
  const promises = prefetchRequests.map(request =>
    getResponse(request, cacheTimestampHeader, cacheConfigStore, cache)
  );

  const results = await Promise.allSettled(promises);

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.warn('warm-up', `Prefetch failed for ${prefetchRequests[i].url}: ${result.reason}`);
    }
  });
}

const debouncedWarmUpCache = debounce(warmUpCache, 500);
