import { getNormalizedPathname } from './utils.js';
import {
  saveConfigToIndexedDB,
  loadConfigFromIndexedDB,
  clearConfigFromIndexedDB,
} from './config-persistence.js';
import { logger } from './logger.js';

/**
 * @typedef {'always' | 'on-load' | 'on-update' | 'never'} PrefetchMode
 */

/**
 * Common cache configuration fields that can be defined globally,
 * per host, per controller, or per endpoint/method.
 *
 * @typedef {Object} CacheSettings
 * @property {number} [lastModified] Optional timestamp indicating the last data update (in milliseconds since epoch)
 * @property {string[]} [keyHeaders] Optional list of request headers used to compute the cache key. Defaults to `[]`
 * @property {PrefetchMode} [prefetch] Optional prefetch behavior. Defaults to `'never'`
 */

/**
 * Controller-level configuration (e.g. `/users`), consisting of:
 * - Optional `settings` for controller-level defaults
 * - Optional `methods` map per HTTP method (e.g. `GET`, `POST`)
 *
 * @typedef {Object} EndpointConfig
 * @property {CacheSettings} [settings]
 * @property {{ [method in string]?: CacheSettings }} [methods]
 */

/**
 * Host-level configuration (e.g. `'localhost:3000'`), consisting of:
 * - Optional `settings` for host-level defaults
 * - Optional `controllers` map per path (e.g. `'users'`)
 *
 * @typedef {Object} HostConfig
 * @property {CacheSettings} [settings]
 * @property {{ [controllerPath: string]: EndpointConfig }} [endpoints]
 */

/**
 * Root-level cache configuration, with:
 * - Optional global `settings`
 * - Required `endpoints` map per host
 * - Optional `cacheTTL` to persist the config
 *
 * @typedef {Object} CacheConfig
 * @property {CacheSettings} [settings] Global settings
 * @property {{ [host: string]: HostConfig }} hosts
 * @property {number} [cacheTTL] Optional time-to-live in milliseconds for persisting the config
 * @property {number} [fallbackPollingIntervalMs] Optional polling interval in milliseconds to fetch config updates if WebSocket is disconnected. If omitted, polling is disabled.
 */

/**
 * Default prefetch mode for requests that don't specify a mode.
 * @type {PrefetchMode}
 */
const defaultPrefetchMode = 'never';

export class CacheConfigStore {
  /**
   * The current active `CacheConfig`, or `null` if no configuration has been loaded.
   * @type {CacheConfig | null}
   */
  #current = null;

  /**
   * Timer ID for scheduled config cleanup after TTL expires.
   * @type {number | null}
   */
  #cleanupTimeoutId = null;

  /**
   * Creates an instance of `CacheConfigStore`.
   *
   * @typedef {Object} CacheConfigOptions
   * @property {() => void} [onSet] Callback triggered whenever the cache configuration is updated
   * @property {() => void} [onReset] Callback triggered whenever the cache configuration is cleared
   *
   * @param {CacheConfigOptions} [options] Configuration options for the controller instance
   */
  constructor({ onSet, onReset } = {}) {
    this.onSet = onSet;
    this.onReset = onReset;
  }

  /**
   * The currently loaded `CacheConfig`, or `null` if none exists
   */
  get current() {
    return this.#current;
  }

  /**
   * Updates the current cache configuration with a new value.
   * Triggers the `onSet` callback if the new value is not `null`,
   * or the `onReset` callback if the new value is `null`.
   *
   * @param {CacheConfig | null} newCacheConfig the new cache configuration to set
   */
  set = async newCacheConfig => {
    this.#clearScheduledCleanup();
    this.#current = newCacheConfig;

    if (newCacheConfig) {
      if (newCacheConfig.cacheTTL) {
        await saveConfigToIndexedDB(newCacheConfig);
        this.#scheduleCleanup(newCacheConfig.cacheTTL);
      }
      this.onSet?.();
    } else {
      await clearConfigFromIndexedDB();
      this.onReset?.();
    }
  };

  /**
   * Clears the entire cache configuration.
   * Equivalent to calling `set(null)`.
   */
  reset = () => {
    return this.set(null);
  };

  /**
   * Attempts to load config from IndexedDB if still valid.
   *
   * @returns {Promise<boolean>} true if fallback config was used
   */
  loadFromCacheIfValid = async () => {
    const saved = await loadConfigFromIndexedDB();
    if (!saved?.config || typeof saved.savedAt !== 'number') return false;

    const { cacheTTL } = saved.config;
    if (!cacheTTL) return false;

    const expiresAt = saved.savedAt + cacheTTL;
    const now = Date.now();

    if (now < expiresAt) {
      this.#current = saved.config;
      this.#scheduleCleanup(expiresAt - now);
      this.onSet?.();
      return true;
    }

    await clearConfigFromIndexedDB();
    return false;
  };

  /**
   * Schedules cleanup of config once TTL expires.
   *
   * @param {number} ms time in milliseconds until cleanup
   */
  #scheduleCleanup(ms) {
    this.#cleanupTimeoutId = setTimeout(async () => {
      if (this.#current === null) return;
      await clearConfigFromIndexedDB();
      await this.reset();
    }, ms);
  }

  /**
   * Cancels any pending cleanup task scheduled by TTL.
   */
  #clearScheduledCleanup() {
    if (this.#cleanupTimeoutId) {
      clearTimeout(this.#cleanupTimeoutId);
      this.#cleanupTimeoutId = null;
    }
  }

  /**
   * Retrieves the merged cache configuration for a specific `Request` object.
   * The resolution merges values from global, host, controller and endpoint levels,
   * with deeper levels overriding higher ones.
   *
   * If no relevant configuration exists, returns `undefined`.
   *
   * @param {Request} request the `Request` for which cache configuration should be retrieved
   * @param {string[]} blackList list of origins to exclude from
   * @returns {CacheSettings | undefined} the merged cache settings object
   */
  resolveRequestSettings = (request, blackList) => {
    if (!this.#current) {
      logger.warn('cache-config-store', 'Trying to resolve settings without a config');
      return;
    }

    const url = new URL(request.url);
    const { origin } = url;

    if (blackList?.includes(origin)) {
      return;
    }

    const hostConfig = this.#current.hosts?.[origin];

    if (!hostConfig) {
      logger.info('cache-config-store', `No host config found for ${origin}`);
      return;
    }

    const cleanedPathname = getNormalizedPathname(url);
    const endpointConfig = hostConfig.endpoints?.[cleanedPathname];
    const method = request.method.toUpperCase();
    const methodConfig = endpointConfig?.methods?.[method];

    const levels = [
      this.#current.settings,
      hostConfig.settings,
      endpointConfig?.settings,
      methodConfig,
    ].filter(Boolean);

    if (!levels.length) {
      logger.info('cache-config-store', `No config found for ${request.url}`);
      return;
    }

    const merged = levels.reduce(
      (acc, level) => ({
        ...acc,
        ...level,
      }),
      {}
    );

    return {
      keyHeaders: [],
      prefetch: defaultPrefetchMode,
      ...merged,
    };
  };

  /**
   * Returns a list of prefetchable requests according to the config.
   * Can be filtered by specific `PrefetchMode` values.
   *
   * @param {PrefetchMode[]} modes list of modes to include (e.g. ['on-load'])
   * @returns {Request[]} list of requests to prefetch
   */
  getPrefetchRequests = modes => {
    const requests = [];

    for (const [request] of this.iterateConfigEntries()) {
      const settings = this.resolveRequestSettings(request);

      if (settings && modes.includes(settings.prefetch ?? defaultPrefetchMode)) {
        requests.push(request);
      }
    }

    return requests;
  };

  /**
   * Iterates over all defined endpoint entries in the cache config.
   * Yields a tuple of: [request, methodConfig, fullHierarchy]
   *
   * @returns {Generator<[Request, CacheSettings, {
   *   host: string,
   *   path: string,
   *   method: string,
   *   hostConfig: HostConfig,
   *   endpointConfig: EndpointConfig
   * }]>}
   */
  *iterateConfigEntries() {
    if (!this.#current) return;

    for (const [host, hostConfig] of Object.entries(this.#current.hosts || {})) {
      for (const [path, endpointConfig] of Object.entries(hostConfig.endpoints || {})) {
        for (const [method, methodConfig] of Object.entries(endpointConfig.methods || {})) {
          const url = `${host}/${path}`;
          const request = new Request(url, { method: method.toUpperCase() });

          yield [
            request,
            methodConfig,
            {
              host,
              path,
              method,
              hostConfig,
              endpointConfig,
            },
          ];
        }
      }
    }
  }
}
