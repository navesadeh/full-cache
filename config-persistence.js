/* global indexedDB */
/**
 * Provides utilities for storing and retrieving cache configuration
 * from IndexedDB, with support for TTL-based expiration.
 */

const dbName = 'api-cache-config';
const storeName = 'config';
const configKey = 'latest';

/**
 * Opens the IndexedDB database used for cache configuration.
 *
 * @returns {Promise<IDBDatabase>} A promise that resolves with the opened database instance
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(storeName);
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Saves the provided cache config to IndexedDB with the current timestamp.
 *
 * @param {import('./cache-config-store.js').CacheConfig} config - The cache configuration object to persist
 * @returns {Promise<void>}
 */
export async function saveConfigToIndexedDB(config) {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);

  store.put({ config, savedAt: Date.now() }, configKey);
  await tx.complete;
}

/**
 * Loads the cached config from IndexedDB, if available.
 *
 * @returns {Promise<{ config: import('./cache-config-store.js').CacheConfig, savedAt: number } | null>}
 * Returns the stored config with timestamp, or null if not found
 */
export async function loadConfigFromIndexedDB() {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);

  const result = store.get(configKey);
  return result || null;
}

/**
 * Deletes the cached config from IndexedDB.
 *
 * @returns {Promise<void>}
 */
export async function clearConfigFromIndexedDB() {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);

  store.delete(configKey);
  await tx.complete;
}
