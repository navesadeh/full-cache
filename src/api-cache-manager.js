import { revertCacheKeyRequest } from './utils.js';
import { logger } from './logger.js';

/**
 * @typedef {import('./cache-config-store.js').CacheConfigStore} CacheConfigStore
 */

export class APICacheManager {
  /**
   * Creates an instance of `APICacheManager`.
   *
   * @param {CacheStorage} caches the `CacheStorage` object used for interacting with browser caches
   * @param {string} cacheName the name of the cache to be managed
   */
  constructor(caches, cacheName) {
    this.caches = caches;
    this.cacheName = cacheName;
  }

  /**
   * Clears all cached requests in the specified cache.
   *
   * This method opens the cache with the given `cacheName`, retrieves all stored requests,
   * and deletes them one by one. When complete, the cache is fully emptied.
   *
   * @returns {Promise<void>} a promise that resolves when all cached requests have been deleted
   *
   * @throws {Error} if an error occurs while opening the cache or deleting the requests
   */
  clear = async () => {
    const { requests, cache } = await this.#getCache();
    const promises = requests.map(request => cache.delete(request));

    await Promise.all(promises);
  };

  /**
   * Deletes all cache entries that are stale, based on their individual endpoint config.
   *
   * @param {CacheConfigStore} configStore the config store used to resolve endpoint configurations
   * @param {string} cacheTimestampHeader name of the header used to track timestamps
   */
  deleteStaleEntries = async (configStore, cacheTimestampHeader) => {
    const { requests, cache } = await this.#getCache();

    for (const request of requests) {
      const response = await cache.match(request);
      if (!response) continue;

      const originalRequest = revertCacheKeyRequest(request);
      const endpointConfig = configStore.resolveRequestSettings(originalRequest);

      if (!endpointConfig) continue;

      const timestampHeader = response.headers.get(cacheTimestampHeader);
      const responseTimestamp = +timestampHeader;

      if (isNaN(responseTimestamp)) {
        logger.warn('api-cache-manager', `Invalid timestamp for ${request.url}`);
      } else if (responseTimestamp < endpointConfig.lastModified) {
        const time = new Date(responseTimestamp).toISOString();
        logger.log(
          'api-cache-manager',
          `Deleting stale cache entry: ${request.url} (time: ${time})`
        );
      } else {
        continue;
      }

      await cache.delete(request);
    }
  };

  /**
   * Retrieves the cache storage and all requests stored within.
   *
   * @returns {Promise<{ cache: Cache, requests: Request[] }>} a promise that resolves to the cache and requests
   * @throws {Error} if an error occurs while opening the cache or retrieving the requests
   */
  #getCache = async () => {
    const cache = await this.caches.open(this.cacheName);
    const requests = await cache.keys();

    return { cache, requests };
  };
}
