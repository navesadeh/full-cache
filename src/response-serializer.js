/**
 * Serializes a `Response` object into a plain transferable object,
 * allowing it to be sent across tabs via `BroadcastChannel` or `postMessage`.
 *
 * @param {Response} response The `Response` object to serialize
 * @returns {Promise<{
 *   body: string,
 *   status: number,
 *   statusText: string,
 *   headers: [string, string][]
 * }>} A promise that resolves to a plain object containing all serializable parts of the response
 */
export async function serializeResponse(response) {
  const cloned = response.clone();
  const body = await cloned.text();
  const headers = [...cloned.headers.entries()];

  return {
    body,
    status: cloned.status,
    statusText: cloned.statusText,
    headers,
  };
}

/**
 * Reconstructs a `Response` object from a plain object that was previously serialized.
 * Useful for receiving responses across tabs or threads.
 *
 * @param {{
 *   body: string,
 *   status: number,
 *   statusText: string,
 *   headers: [string, string][]
 * }} data The serialized response object
 * @returns {Response} A new `Response` instance based on the provided data
 */
export function deserializeResponse(data) {
  const clonedData = data instanceof Response && data.bodyUsed ? data.clone() : data;
  const { body, status, statusText, headers } = clonedData;

  return new Response(body, { status, statusText, headers });
}
