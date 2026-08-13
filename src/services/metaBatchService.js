/**
 * Meta Batch API Service
 * 
 * Wraps Meta's Batch API to send up to 50 requests in a single HTTP call.
 * This dramatically reduces network round-trips when fetching metrics for
 * many posts simultaneously.
 * 
 * Meta Batch API docs: https://developers.facebook.com/docs/graph-api/making-multiple-requests
 */

const MAX_BATCH_SIZE = 50;

/**
 * Sends batch requests to Meta Graph API.
 * 
 * @param {string} accessToken - The access token to use for all requests in the batch
 * @param {Array<{ id: string, relativeUrl: string }>} requests - Array of request items.
 *   Each item has:
 *     - id: A local identifier to map responses back to requests
 *     - relativeUrl: The Graph API relative URL (e.g., "{postId}/insights?metric=views")
 * @param {string} [graphHost='graph.facebook.com'] - The Graph API host to use
 * @returns {Promise<Map<string, object>>} - Map of request id → parsed response body (or null on error)
 */
export const sendBatchRequests = async (accessToken, requests, graphHost = 'graph.facebook.com') => {
  const results = new Map();

  if (!requests || requests.length === 0) {
    return results;
  }

  // Chunk requests into groups of MAX_BATCH_SIZE
  const chunks = [];
  for (let i = 0; i < requests.length; i += MAX_BATCH_SIZE) {
    chunks.push(requests.slice(i, i + MAX_BATCH_SIZE));
  }

  for (const chunk of chunks) {
    try {
      const batchPayload = chunk.map(req => ({
        method: 'GET',
        relative_url: req.relativeUrl,
      }));

      const response = await fetch(`https://${graphHost}/v20.0/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          access_token: accessToken,
          batch: JSON.stringify(batchPayload),
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const metaError = errorBody?.error || {};
        console.error('[Meta Batch] Request failed', {
          graphHost,
          status: response.status,
          code: metaError.code,
          subcode: metaError.error_subcode,
          type: metaError.type,
          message: metaError.message || response.statusText,
          requestCount: chunk.length,
        });
        if (response.status === 429 || response.status >= 500) {
          const error = new Error(metaError.message || `Meta Batch request failed (${response.status}).`);
          error.status = response.status;
          error.error = metaError;
          error.retryAfterMs = Number(response.headers.get('retry-after') || 0) * 1000;
          throw error;
        }
        // Mark all items in this chunk as failed
        for (const req of chunk) {
          results.set(req.id, null);
        }
        continue;
      }

      const batchResponses = await response.json();

      // Map responses back to request IDs (responses are in same order as requests)
      for (let i = 0; i < chunk.length; i++) {
        const reqId = chunk[i].id;
        const batchRes = batchResponses[i];

        if (!batchRes) {
          results.set(reqId, null);
          continue;
        }

        try {
          const body = JSON.parse(batchRes.body);

          if (batchRes.code >= 200 && batchRes.code < 300) {
            results.set(reqId, body);
          } else {
            console.warn('[Meta Batch] Sub-request failed', {
              requestId: reqId,
              status: batchRes.code,
              code: body?.error?.code,
              subcode: body?.error?.error_subcode,
              message: body?.error?.message || 'Unknown error',
            });
            results.set(reqId, null);
          }
        } catch (parseErr) {
          console.error(`❌ [Meta Batch] Failed to parse response for "${reqId}":`, parseErr.message);
          results.set(reqId, null);
        }
      }
    } catch (err) {
      console.error(`❌ [Meta Batch] Network/fetch error:`, err.message);
      if (err.status === 429 || err.status >= 500) throw err;
      if (err instanceof TypeError || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code)) {
        err.retryable = true;
        throw err;
      }
      // Mark all items in this chunk as failed
      for (const req of chunk) {
        results.set(req.id, null);
      }
    }
  }

  return results;
};
