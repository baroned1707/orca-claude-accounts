// Token check that costs no usage: listing models needs a valid inference
// token (`claude setup-token` grants only user:inference) but runs no model.
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1'
const TIMEOUT_MS = 10_000

/**
 * `{ state: 'valid' | 'invalid' | 'unknown', message, at, orgId? }`. 'unknown' means
 * the check itself failed (offline, API down) and says nothing about the token.
 */
export async function checkToken(token) {
  const at = new Date().toISOString()
  let response
  try {
    response = await fetch(MODELS_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20'
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    return { state: 'unknown', message: `could not reach api.anthropic.com (${error?.message ?? error})`, at }
  }
  // Each Claude account has its own organization; the id tells accounts apart
  // even though inference-only tokens can't read the profile (email).
  const orgId = response.headers.get('anthropic-organization-id') || null
  if (response.ok) return { state: 'valid', message: 'token accepted by api.anthropic.com', at, orgId }
  let detail = ''
  try {
    detail = (await response.json())?.error?.message ?? ''
  } catch {
    // body is optional
  }
  if (response.status === 401 || response.status === 403) {
    return { state: 'invalid', message: detail || `rejected with HTTP ${response.status}`, at }
  }
  return { state: 'unknown', message: `api.anthropic.com answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`, at }
}
