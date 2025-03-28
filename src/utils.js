import { logger } from './logger.js';
import { getDedupedResponse } from './dedup-response-manager.js';

/**
 * @typedef {import('./cache-config-store.js').CacheConfig} CacheConfig
 * @typedef {import('./cache-config-store.js').CacheConfigStore} CacheConfigController
 */

/**
 * Removes leading and trailing slashes from the `pathname` of a given `URL`.
 *
 * @param {URL} url the `URL` object whose `pathname` will be cleaned
 * @returns {string} the cleaned `pathname` without leading or trailing slashes
 */
export function getNormalizedPathname(url) {
  return url.pathname.replace(/^\/|\/$/g, '');
}

/**
 * Reads the body of a given `Request` and returns it as a sorted string.
 *
 * - For `application/json`, the keys are sorted alphabetically.
 * - For `application/x-www-form-urlencoded`, parameters are sorted alphabetically.
 * - For other content types, the body is returned as-is.
 * - For HTTP methods that don't support a body (e.g. `GET`, `HEAD`), an empty string is returned.
 *
 * @param {Request} request the `Request` object to read the body from
 * @returns {Promise<string>} a promise that resolves to the sorted body string
 * @throws {Error} if the JSON body cannot be parsed
 */
async function serializeRequestBodyForKey(request) {
  const methodsWithoutBody = ['GET', 'HEAD'];

  if (methodsWithoutBody.includes(request.method)) {
    return '';
  }

  const clonedRequest = request.clone();
  const contentType = clonedRequest.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const bodyAsJson = await clonedRequest.json();
      if (bodyAsJson && typeof bodyAsJson === 'object') {
        const sortedBody = Object.keys(bodyAsJson)
          .sort()
          .reduce((acc, key) => {
            acc[key] = bodyAsJson[key];
            return acc;
          }, {});
        return JSON.stringify(sortedBody);
      }
    } catch (error) {
      logger.error('utils', `Failed to parse JSON body: ${error}`);
    }
  }

  const bodyAsText = await clonedRequest.text();

  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(bodyAsText);
    params.sort();
    return params.toString();
  }

  return bodyAsText;
}

/**
 * The prefix used to identify search parameters added to the cache key URL.
 */
const keySearchParamPrefix = '__';

/**
 * Creates a unique cache key for a given `Request` by normalizing the URL and
 * appending additional parameters based on the request body, method, and selected headers.
 *
 * This ensures that requests differing in body or specific headers are cached separately.
 *
 * @param {Request} request the `Request` object for which the cache key should be created
 * @param {string[]} keyHeaders the list of headers to include in the cache key
 * @returns {Promise<Request>} a promise that resolves to a new `Request` with a modified URL
 * @throws {Error} if an error occurs while reading the body or processing headers
 */
async function buildCacheKeyRequest(request, keyHeaders) {
  const clonedUrl = new URL(request.url);
  clonedUrl.pathname = getNormalizedPathname(clonedUrl);
  const body = await serializeRequestBodyForKey(request);
  clonedUrl.searchParams.set(`${keySearchParamPrefix}body`, body || 'none');
  clonedUrl.searchParams.set(`${keySearchParamPrefix}method`, request.method);

  for (const keyHeader of keyHeaders) {
    const headerValue = request.headers.get(keyHeader);
    clonedUrl.searchParams.set(`${keySearchParamPrefix}header-${keyHeader}`, headerValue || 'none');
  }

  clonedUrl.searchParams.sort();

  return new Request(clonedUrl, { headers: request.headers });
}

/**
 * Reverts a cache key `Request` back to its original form by removing the
 * added fake URL parameters (those with the prefix).
 *
 * @param {Request} request the `Request` object with the modified URL
 * @returns {Request} a new `Request` object with the original URL restored
 */
export function revertCacheKeyRequest(request) {
  const clonedUrl = new URL(request.url);

  // Remove all search parameters with the prefix
  for (const key of clonedUrl.searchParams.keys()) {
    if (key.startsWith(keySearchParamPrefix)) {
      clonedUrl.searchParams.delete(key);
    }
  }

  return new Request(clonedUrl, { headers: request.headers, method: request.method });
}

/**
 * Retrieves a `Response` for a given `Request`, either from the cache or from the network.
 * If a matching configuration exists in the `cacheConfigController`, the function attempts
 * to serve a cached response. If the cache is missing or expired, it fetches a fresh response
 * and stores it in the cache.
 *
 * @param {Request} request the incoming `Request` to handle
 * @param {string} cacheTimestampHeader the header name used to store the cache timestamp
 * @param {CacheConfigController} cacheConfigController the controller managing cache settings
 * @param {Cache} cache the `Cache` object used for storage and lookup
 * @returns {Promise<Response>} a promise that resolves to a cached or freshly fetched `Response`
 * @throws {Error} if an error occurs during cache key creation or network fetch
 */
export async function getResponse(request, cacheTimestampHeader, cacheConfigController, cache) {
  const endpointConfig = cacheConfigController.resolveRequestSettings(request);
  if (!endpointConfig) {
    return fetch(request);
  }

  const requestCacheKey = await buildCacheKeyRequest(request, endpointConfig.keyHeaders);
  const cachedResponse = await cache.match(requestCacheKey);

  if (cachedResponse) {
    const currentTimestamp = Date.now();
    const cachedTimestamp = +cachedResponse.headers.get(cacheTimestampHeader);

    if (cachedTimestamp <= currentTimestamp) {
      logger.log('get-response', `Serving from cache: ${request.url}`);
      return cachedResponse;
    } else {
      await cache.delete(requestCacheKey);
      logger.log('get-response', `Cache expired: ${request.method} ${request.url}`);
    }
  } else {
    logger.log('get-response', `Fetching from network: ${request.method} ${request.url}`);
  }

  const response = await getDedupedResponse(requestCacheKey.url, () =>
    fetchAndStoreInCache(request, requestCacheKey, cache, cacheTimestampHeader)
  );

  return response;
}

/**
 * Fetches a resource from the network and stores the response in the cache
 * using a provided cache key, while also tagging it with a timestamp header.
 *
 * @param {Request | string} request the request or URL to fetch
 * @param {string} requestCacheKey the cache key to use when storing the response
 * @param {Cache} cache the `Cache` object where the response will be stored
 * @param {string} cacheTimestampHeader the header name to use for storing the timestamp
 * @returns {Promise<Response>} a promise that resolves to the original network `Response`
 * @throws {TypeError} if the request or cache is invalid
 * @throws {Error} if the fetch operation fails
 */
async function fetchAndStoreInCache(request, requestCacheKey, cache, cacheTimestampHeader) {
  const networkResponse = await fetch(request);

  if (!networkResponse.ok) {
    return networkResponse; // Do not cache if response is not ok (status 2xx)
  }

  const clonedResponse = networkResponse.clone();

  const modifiedResponse = new Response(clonedResponse.body, {
    status: clonedResponse.status,
    statusText: clonedResponse.statusText,
    headers: new Headers({
      ...Object.fromEntries(clonedResponse.headers),
      [cacheTimestampHeader]: Date.now(),
    }),
  });

  await cache.put(requestCacheKey, modifiedResponse);
  return networkResponse;
}

/**
 * A utility function that debounces a given function with a default delay of 300ms.
 * This version supports TypeScript generics for better type inference.
 * The debounced function will only be called once after the last invocation.
 *
 * @template T
 * @template R
 * @param {(args: T) => Promise<R>} fn the function to debounce
 * @param {number} delayMs the delay in milliseconds before invoking the function
 * @returns {(args: T) => Promise<R>} a debounced function that can be called repeatedly
 */
export function debounce(fn, delayMs = 300) {
  let timerId = null;
  return args => {
    if (timerId) {
      clearTimeout(timerId);
    }
    return new Promise((resolve, reject) => {
      timerId = setTimeout(async () => {
        try {
          const result = await fn(args);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, delayMs);
    });
  };
}

/**
 * Creates a singleton instance of a generic type `T` using a factory function.
 *
 * @template T
 * @param {() => T} factoryFn - A function that creates and returns an instance of type `T`.
 * @returns {() => T} A function that returns the singleton instance of type `T`.
 */
export function singleton(factoryFn) {
  /** @type {T | undefined} */
  let instance;

  return function getInstance() {
    if (!instance) {
      instance = factoryFn();
    }
    return instance;
  };
}
