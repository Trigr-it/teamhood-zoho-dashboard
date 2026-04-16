// Zoho OAuth2 token management (EU region)

let accessToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) {
    return accessToken;
  }
  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${process.env.ZOHO_TOKEN_URL}?${params}`, { method: 'POST' });
  const data = await res.json();
  if (data.error) throw new Error(`Zoho token refresh failed: ${data.error}`);
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return accessToken;
}

let organizationId = null;

export async function getOrganizationId() {
  if (organizationId) return organizationId;
  const token = await getAccessToken();
  const res = await fetch(`${process.env.ZOHO_API_BASE}/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const data = await res.json();
  if (!data.organizations || data.organizations.length === 0) {
    throw new Error('No Zoho Invoice organizations found');
  }
  organizationId = data.organizations[0].organization_id;
  return organizationId;
}
