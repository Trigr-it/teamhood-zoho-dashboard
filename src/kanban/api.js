/**
 * Node Kanban card client — same function names and card shape as ./teamhood/api.js, backed by the
 * board's pricing API (node-kanban: src/lib/pricing-api.ts, routes under /api/pricing).
 *
 * Selected by CARD_SOURCE=kanban (see ../cards/source.js). Until the team is fully live on the
 * board the source stays "teamhood" and this module is not used.
 *
 * Env: KANBAN_API_URL (default https://kanban.nodegroup.co.uk), KANBAN_API_KEY (= PRICING_API_KEY on the board).
 */

const BASE_URL = (process.env.KANBAN_API_URL || 'https://kanban.nodegroup.co.uk').replace(/\/+$/, '');
const API_KEY = process.env.KANBAN_API_KEY;

function authHeaders() {
  if (!API_KEY) throw new Error('KANBAN_API_KEY environment variable is not set');
  return { Authorization: `Bearer ${API_KEY}` };
}

async function apiFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), 'Content-Type': 'application/json', ...options.headers },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kanban API error ${res.status}: ${body || res.statusText}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * The board already returns cards in the Teamhood-like shape (id, displayId, "[CODE - Site] scope"
 * title, plain-text description, statusName, assignedUserName, tags, customFields [{name, value}],
 * completed, url, createdAt, updatedAt). Normalise the few fields the dashboard reads defensively.
 */
function formatCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    displayId: card.displayId || null,
    title: card.title || '',
    description: card.description || '',
    statusId: card.statusId || null,
    statusName: card.statusName || null,
    assignedUserId: card.assignedUserId || null,
    assignedUserName: card.assignedUserName || null,
    rowId: null,
    parentId: card.parentId || null,
    completed: !!card.completed,
    archived: !!card.archived,
    url: card.url || null,
    tags: Array.isArray(card.tags) ? card.tags : [],
    customFields: (card.customFields || []).map(f => ({ name: f.name, value: f.value ?? null })),
    createdAt: card.createdAt || null,
    updatedAt: card.updatedAt || null,
    // Extra, harmless for callers that only know the Teamhood fields
    projectCode: card.projectCode || null,
    projectName: card.projectName || null,
    scope: card.scope || '',
    notes: card.notes || '',
    hasAttachments: !!card.hasAttachments,
  };
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export async function getCard(cardId) {
  const data = await apiFetch(`/api/pricing/cards/${encodeURIComponent(cardId)}`);
  if (!data?.card) throw new Error(`Card not found: ${cardId}`);
  return formatCard(data.card);
}

export async function getCardRaw(cardId) {
  const data = await apiFetch(`/api/pricing/cards/${encodeURIComponent(cardId)}`);
  if (!data?.card) throw new Error(`Card not found: ${cardId}`);
  return data.card;
}

/**
 * filters: { serverTag, tags: [..], completed, archived, status, assignee_id, parent_only, search }
 * Same semantics as the Teamhood client: parents only unless parent_only === false; `completed`
 * and `archived` default to excluded; `serverTag` is the board-side tag filter and `tags` an
 * extra client-side any-of filter.
 */
export async function listCards(filters = {}) {
  const params = new URLSearchParams();
  // An explicit empty serverTag means "every card"; omitted means the board's default (Price Required).
  if (filters.serverTag !== undefined) params.set('tag', filters.serverTag || '');
  else if (filters.tags?.length === 1) params.set('tag', filters.tags[0]);
  else if (filters.tags?.length) params.set('tag', '');
  if (filters.completed !== undefined) params.set('completed', String(filters.completed));
  if (filters.archived !== undefined) params.set('archived', String(filters.archived));
  if (filters.status) params.set('status', filters.status);
  if (filters.assignee_id) params.set('assignee', filters.assignee_id);
  if (filters.parent_only === false) params.set('parents_only', 'false');
  if (filters.search) params.set('search', filters.search);

  const data = await apiFetch(`/api/pricing/cards?${params}`);
  let cards = (data?.cards || []).map(formatCard);

  if (filters.tags && filters.tags.length > 0) {
    const tagSet = new Set(filters.tags.map(t => t.toLowerCase()));
    cards = cards.filter(c => c.tags.some(t => tagSet.has(t.toLowerCase())));
  }
  return cards;
}

export async function searchCards(query, filters = {}) {
  if (!query || !query.trim()) throw new Error('Search query is required');
  return listCards({ ...filters, serverTag: '', search: query.trim() });
}

export async function addTag(cardId, tag) {
  const data = await apiFetch(`/api/pricing/cards/${encodeURIComponent(cardId)}/tags`, {
    method: 'POST',
    body: JSON.stringify({ tag }),
  });
  if (!data?.card) throw new Error(`Card not found: ${cardId}`);
  return formatCard(data.card);
}

export async function removeTag(cardId, tagToRemove) {
  const data = await apiFetch(`/api/pricing/cards/${encodeURIComponent(cardId)}/tags`, {
    method: 'DELETE',
    body: JSON.stringify({ tag: tagToRemove }),
  });
  if (!data?.card) throw new Error(`Card not found: ${cardId}`);
  return formatCard(data.card);
}

export async function getCardChildren(cardId) {
  const parent = await getCardRaw(cardId);
  const data = await apiFetch(`/api/pricing/cards?tag=&parents_only=false&completed=true&archived=true&search=${encodeURIComponent(parent.displayId || '')}`);
  return (data?.cards || []).filter(c => c.parentId === parent.id).map(formatCard);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** [{ id, name, mimeType, size, url, thumbUrl }] — the dashboard reads id, name, mimeType, size. */
export async function getCardAttachments(cardId) {
  const data = await apiFetch(`/api/pricing/cards/${encodeURIComponent(cardId)}/attachments`);
  return data?.attachments || [];
}

/**
 * Fetch one attachment's bytes for the dashboard proxy. Returns the fetch Response (streamable).
 * opts.thumb = '1' | 'large' asks the board for its jpeg preview instead of the original.
 */
export async function getAttachmentContent(attachmentId, opts = {}) {
  const q = opts.thumb ? `?thumb=${encodeURIComponent(opts.thumb)}` : '';
  return fetch(`${BASE_URL}/api/attachments/${encodeURIComponent(attachmentId)}${q}`, { headers: authHeaders() });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getConfig() {
  return {
    apiKeySet: !!API_KEY,
    baseUrl: BASE_URL,
  };
}
