import { logger } from './logger.js';

/**
 * @typedef {import('./cache-config-store.js').CacheConfig} CacheConfig
 */

/**
 * A `WebSocket` client for receiving live updates of cache configuration.
 * Automatically attempts to reconnect with exponential backoff if disconnected.
 */
export class CacheConfigSyncClient {
  /**
   * The current `WebSocket` connection instance.
   * @type {WebSocket | null}
   */
  #socket = null;

  /**
   * Indicates whether the connection to the `WebSocket` is currently active.
   * @type {boolean}
   */
  #isConnected = false;

  /**
   * The delay in milliseconds before attempting the next reconnection.
   * @type {number}
   */
  reconnectBackoffMs = 0;

  /**
   * Timer ID for the scheduled reconnection attempt.
   * @type {number}
   */
  #reconnectTimeoutId = 0;

  /**
   * The last `CacheConfig` object received from the server.
   * @type {CacheConfig}
   */
  #currentCacheConfig = null;

  /**
   * Creates an instance of `CacheConfigSyncClient`.
   *
   * @typedef {Object} CacheConfigOptions
   *
   * @property {(newCacheConfig: CacheConfig) => void} [onReceiveNewCacheConfig]
   * Callback triggered when a new `cacheConfig` is received from the server.
   * Receives the new `CacheConfig` object as an argument.
   *
   * @property {() => void} [onConnect]
   * Callback triggered when the `WebSocket` connection is successfully established.
   *
   * @property {() => void} [onDisconnect]
   * Callback triggered when the `WebSocket` disconnects unexpectedly.
   *
   * @property {string} [fallbackPollingServerUrl]
   * The URL for fallback polling requests.
   *
   * @param {string | URL} url `WebSocket` server URL
   * @param {CacheConfigOptions} [options] configuration options for handling `WebSocket` events
   */
  constructor(url, { onReceiveNewCacheConfig, onConnect, onDisconnect, fallbackPollingServerUrl }) {
    this.onReceiveNewCacheConfig = onReceiveNewCacheConfig;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.url = url;
    this.fallbackPollingServerUrl = fallbackPollingServerUrl;
    this.resetReconnectBackoff();
  }

  /**
   * Resets the reconnection delay to its initial value (1 second).
   */
  resetReconnectBackoff = () => {
    this.reconnectBackoffMs = 1000;
  };

  /**
   * Doubles the current reconnection delay, up to a maximum of 30 seconds.
   */
  #incrementReconnectBackoffDelay = () => {
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, 30_000);
  };

  /**
   * Explicitly triggers a one-time config fetch from the server via HTTP polling.
   * This is used as a fallback when WebSocket is unavailable.
   *
   * @returns {Promise<void>} a promise that resolves when a config is successfully fetched and applied
   */
  async poll() {
    if (this.#isConnected) {
      logger.info('polling', 'Skipping fallback poll because WebSocket is connected');
      return;
    }

    if (!this.fallbackPollingServerUrl) {
      logger.warn('polling', 'Fallback polling server URL is not set');
      return;
    }

    try {
      const result = await fetch(this.fallbackPollingServerUrl);

      try {
        const cacheConfig = await result.json();

        if (cacheConfig) {
          this.#triggerReceiveNewCacheConfigIfHasChanges(cacheConfig);
          logger.log('polling', 'Received config via fallback HTTP poll');
        } else {
          logger.warn('polling', 'Invalid config response', cacheConfig);
        }
      } catch (error) {
        logger.error('polling', `Failed to parse config: ${error}`);
      }
    } catch (error) {
      logger.error('polling', `Failed to fetch config: ${error}`);
    }
  }

  /**
   * Establishes a `WebSocket` connection and listens for incoming messages.
   *
   * @returns {Promise<boolean>} a promise that resolves with `true` if the connection is already open,
   * @throws {Error} if an error occurs while connecting or handling messages
   */
  connect = () => {
    return new Promise((resolve, reject) => {
      if (this.#socket && this.#socket.readyState === WebSocket.OPEN) {
        resolve(true);
        return;
      }

      logger.log('cache-config-sync-client', 'Connecting to WebSocket...');

      this.#socket = new WebSocket(this.url);

      this.#socket.addEventListener('open', this.#handleOpen);
      this.#socket.addEventListener('close', this.#handleClose);
      this.#socket.addEventListener('error', this.#handleError);
      this.#socket.addEventListener('message', event => {
        try {
          this.#handleMessage(event);
          resolve(false);
        } catch {
          reject();
        }
      });
    });
  };

  /**
   * Triggered when the `WebSocket` connection is successfully opened.
   * Updates internal connection state and resets reconnection delay.
   */
  #handleOpen = () => {
    logger.log('cache-config-sync-client', 'WebSocket connected');
    this.#isConnected = true;
    this.resetReconnectBackoff();
    this.onConnect?.();
  };

  /**
   * Handles incoming `WebSocket` messages.
   * Parses the message and delegates handling based on its type.
   *
   * @param {MessageEvent<string>} event the message event object
   * @throws {Error} if the message is invalid JSON or has an unrecognized format
   */
  #handleMessage = event => {
    try {
      if (event.data) {
        const { type, data } = JSON.parse(event.data);

        if (type === 'CACHE_CONFIG') {
          try {
            this.#triggerReceiveNewCacheConfigIfHasChanges(data);
            logger.log('cache-config-sync-client', 'Got cacheConfig', data);
          } catch (error) {
            logger.error('cache-config-sync-client', `Failed to update cacheConfig: ${error}`);
            throw error;
          }
        } else {
          logger.warn('cache-config-sync-client', `Unknown message type: ${type}`);
        }
      } else {
        logger.warn('cache-config-sync-client', 'Empty message from WebSocket');
      }
    } catch (error) {
      logger.error('cache-config-sync-client', `Invalid JSON: ${error}`, event.data);
      throw error;
    }
  };

  /**
   * Triggered when the `WebSocket` connection is closed.
   * Notifies the consumer, logs the event, and schedules a reconnection attempt.
   */
  #handleClose = () => {
    if (this.#isConnected) {
      logger.warn('cache-config-sync-client', 'Disconnected from WebSocket');
    }

    this.#isConnected = false;
    this.onDisconnect?.();

    if (this.#reconnectTimeoutId) {
      clearTimeout(this.#reconnectTimeoutId);
    }

    this.#reconnectTimeoutId = setTimeout(async () => {
      try {
        await this.connect();
        logger.log('cache-config-sync-client', 'Reconnected and got fresh cacheConfig');
      } catch (error) {
        logger.error('cache-config-sync-client', `Reconnect failed: ${error}`);
      }
    }, this.reconnectBackoffMs);

    this.#incrementReconnectBackoffDelay();
  };

  /**
   * Triggered when an error occurs on the `WebSocket`.
   * Logs the error and closes the connection.
   *
   * @param {Event} error the error event object
   */
  #handleError = error => {
    logger.error('cache-config-sync-client', `WebSocket error: ${error}`);
    this.#socket?.close();
  };

  #triggerReceiveNewCacheConfigIfHasChanges = newCacheConfig => {
    if (!this.onReceiveNewCacheConfig) return;

    const hasChange = JSON.stringify(newCacheConfig) !== JSON.stringify(this.#currentCacheConfig);

    if (hasChange) {
      this.#currentCacheConfig = newCacheConfig;
      this.onReceiveNewCacheConfig?.(newCacheConfig);
    }
  };
}
