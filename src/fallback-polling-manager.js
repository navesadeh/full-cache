import { logger } from './logger.js';

/**
 * Manages fallback polling when WebSocket is unavailable.
 * Automatically adjusts polling interval based on incoming cache config.
 * Ensures only one interval is active at a time.
 */
export class FallbackPollingManager {
  /**
   * @type {number | null}
   */
  #intervalId = undefined;

  /**
   * @param {{
   *   onPoll: () => void | Promise<void>,
   *   pollingIntervalMs: number | undefined
   * }} options
   *
   * @property {() => void | Promise<void>} options.onPoll Callback to run on each polling tick.
   * @property {number | undefined} options.pollingIntervalMs The polling interval from environment variables.
   */
  constructor({ onPoll, pollingIntervalMs }) {
    this.onPoll = onPoll;
    this.pollingIntervalMs = pollingIntervalMs;

    this.#intervalId = null;
  }

  /**
   * Starts polling if polling is enabled.
   * If already polling, this will do nothing.
   */
  start = () => {
    if (this.#intervalId == null) {
      this.#startInterval();
    }
  };

  /**
   * Stops polling if currently running.
   */
  stop = () => {
    if (this.#intervalId != null) {
      clearInterval(this.#intervalId);
      this.#intervalId = null;
    }
  };

  /**
   * Starts a new interval with the current polling interval.
   */
  #startInterval = () => {
    if (this.pollingIntervalMs) {
      this.#intervalId = setInterval(() => {
        void this.onPoll();
      }, this.pollingIntervalMs);
    } else {
      logger.error('polling', 'Polling interval is not defined');
    }
  };
}
