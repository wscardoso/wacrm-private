import type { EnrichmentResult } from './types'

const GRAPH_API_BASE = 'https://graph.facebook.com/v22.0'

export interface GraphApiResponse {
  id?: string
  name?: string
  campaign_id?: string
  campaign_name?: string
  adset_id?: string
  adset_name?: string
  ad_id?: string
  ad_name?: string
  placement?: string
  effective_status?: string
}

interface ApiErrorResponse {
  error?: {
    message?: string
    type?: string
    code?: number
    error_subcode?: number
    fbtrace_id?: string
  }
}

export class GraphApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly errorType?: string,
  ) {
    super(message)
    this.name = 'GraphApiError'
  }
}

async function graphRequest<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${GRAPH_API_BASE}${path}`)
  url.searchParams.set('access_token', token)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }

  let response: Response
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new GraphApiError('Request timed out', 0, 'timeout')
    }
    throw new GraphApiError(`Network error: ${(err as Error).message}`, 0, 'network_error')
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as ApiErrorResponse
    const fbError = body.error
    if (fbError) {
      throw new GraphApiError(
        fbError.message ?? `HTTP ${response.status}`,
        response.status,
        fbError.type,
      )
    }
    throw new GraphApiError(
      `HTTP ${response.status}`,
      response.status,
      undefined,
    )
  }

  return response.json() as Promise<T>
}

export async function fetchAdData(
  token: string,
  adSourceId: string,
): Promise<EnrichmentResult> {
  const fields = [
    'campaign_id',
    'campaign{name}',
    'adset_id',
    'adset{name}',
    'id',
    'name',
    'adlabels',
  ].join(',')

  const response = await graphRequest<GraphApiResponse>(
    token,
    `/${adSourceId}`,
    { fields },
  )

  const result: EnrichmentResult = {}

  if (response.campaign_id) result.campaign_id = response.campaign_id
  if (response.campaign_name) result.campaign_name = response.campaign_name
  if (response.adset_id) result.adset_id = response.adset_id
  if (response.adset_name) result.adset_name = response.adset_name
  if (response.id) result.ad_id = response.id
  if (response.name) result.ad_name = response.name

  return result
}
