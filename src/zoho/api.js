import { getAccessToken, getOrganizationId } from './auth.js';

export async function zohoRequest(method, path, body) {
  const token = await getAccessToken();
  const orgId = await getOrganizationId();
  const url = `${process.env.ZOHO_API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      'X-com-zoho-invoice-organizationid': orgId,
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  // Handle rate limiting
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '60', 10);
    console.warn(`[zoho] Rate limited, waiting ${retryAfter}s...`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return zohoRequest(method, path, body);
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

export function buildQueryString(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function err(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}
