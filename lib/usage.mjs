// Subscription usage per token. setup-token tokens can't call the usage API
// (it needs user:profile), but every model response carries the unified
// rate-limit headers Claude Code itself reads. A 1-output-token Haiku request
// is the cheapest call that returns them, so each check spends a tiny amount
// of the account's usage.
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const TIMEOUT_MS = 20_000
// Subscription tokens are only accepted for Claude Code requests.
const SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

function readWindow(headers, name) {
  const utilization = Number.parseFloat(headers.get(`anthropic-ratelimit-unified-${name}-utilization`))
  const reset = Number.parseInt(headers.get(`anthropic-ratelimit-unified-${name}-reset`), 10)
  if (!Number.isFinite(utilization)) return null
  return {
    // 0–100, as Claude.ai shows it.
    percent: Math.round(utilization * 1000) / 10,
    resetsAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null,
    status: headers.get(`anthropic-ratelimit-unified-${name}-status`) ?? null
  }
}

/**
 * `{ at, ok, fiveHour, sevenDay, status, limitedBy, error? }`. `status` is
 * 'allowed' or 'rejected' (limit reached); `limitedBy` names the window that
 * decides (five_hour / seven_day).
 */
export async function fetchUsage(token) {
  const at = new Date().toISOString()
  let response
  try {
    response = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: 'hi' }]
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    return { at, ok: false, error: `could not reach api.anthropic.com (${error?.message ?? error})` }
  }
  // Read the headers whatever the status: a rate-limited (429) answer still
  // reports how full each window is and when it resets.
  const headers = response.headers
  const usage = {
    at,
    ok: true,
    fiveHour: readWindow(headers, '5h'),
    sevenDay: readWindow(headers, '7d'),
    status: headers.get('anthropic-ratelimit-unified-status'),
    limitedBy: headers.get('anthropic-ratelimit-unified-representative-claim')
  }
  if (usage.fiveHour || usage.sevenDay) return usage
  let detail = ''
  try {
    detail = (await response.json())?.error?.message ?? ''
  } catch {
    // body is optional
  }
  return { at, ok: false, error: detail || `no usage data (HTTP ${response.status})` }
}
