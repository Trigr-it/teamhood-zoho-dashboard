import { isDisplayId, isUuid, getCachedUuid, cacheDisplayId, indexItems } from '../utils/id-resolver.js';
import { stripHtml } from '../utils/html-strip.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.TEAMHOOD_API_KEY;
// Tenant-specific base URL: https://api-YOURTENANT.teamhood.com
const BASE_URL = (process.env.TEAMHOOD_API_BASE_URL || 'https://api-node.teamhood.com').replace(/\/+$/, '');
const WORKSPACE_ID = process.env.TEAMHOOD_WORKSPACE_ID;
const BOARD_ID = process.env.TEAMHOOD_BOARD_ID;

// Manual UUID→name map (the /api/v1/users endpoint is 403 with this API key)
let USER_MAP = {};
try { USER_MAP = JSON.parse(process.env.TEAMHOOD_USER_MAP || '{}'); } catch { /* ignore */ }

function resolveUserName(userId) {
  if (!userId) return null;
  return USER_MAP[userId] || userId;
}

const MAX_PAGES = 20;           // safety cap – 20 pages × 50 items = 1000 items max
const PAGE_SIZE = 50;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// All public API endpoints use this prefix
const V1 = '/api/v1';

// ---------------------------------------------------------------------------
// Metadata cache
// ---------------------------------------------------------------------------

const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Low-level fetch wrapper
// ---------------------------------------------------------------------------

async function apiFetch(path, options = {}) {
  if (!API_KEY) throw new Error('TEAMHOOD_API_KEY environment variable is not set');

  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-ApiKey': API_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.status === 404) return null;

  if (res.status === 429) {
    throw new Error('Teamhood API rate limit reached. Please wait a moment and try again.');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Teamhood API error ${res.status}: ${body || res.statusText}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

/**
 * Unwrap the Teamhood list envelope. Responses come as:
 *   { "workspaces": [...] }     – named wrapper (key varies by resource)
 *   { "items": [...] }          – paginated list
 *   [ ... ]                     – plain array
 *   { ...single object }        – single item
 */
function unwrapItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  // Check for any key that holds an array (e.g. "workspaces", "boards", "items")
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [data];
}

// ---------------------------------------------------------------------------
// Paginated fetcher
// ---------------------------------------------------------------------------

async function fetchAllPages(path, queryParams = {}) {
  const allItems = [];
  let pages = 0;

  // Build initial URL with query params
  const params = new URLSearchParams(queryParams);
  let url = `${path}?${params}`;

  while (url && pages < MAX_PAGES) {
    const data = await apiFetch(url);
    const items = unwrapItems(data);

    if (!items.length) break;
    allItems.push(...items);
    pages++;

    // Use nextPageUrl for cursor-based pagination if provided
    const nextUrl = data && data.nextPageUrl;
    if (!nextUrl) break;

    // nextPageUrl may be absolute or relative
    url = nextUrl.startsWith('http') ? nextUrl : nextUrl;
  }

  if (pages >= MAX_PAGES) {
    console.warn(`[teamhood-api] Hit max page limit (${MAX_PAGES}) for ${path}. Results may be truncated.`);
  }

  // Index all fetched items for display ID resolution
  indexItems(allItems);

  return allItems;
}

// ---------------------------------------------------------------------------
// Display ID → UUID resolution
// ---------------------------------------------------------------------------

async function resolveCardId(cardId) {
  if (isUuid(cardId)) return cardId;
  if (!isDisplayId(cardId)) throw new Error(`Invalid card identifier: "${cardId}". Expected a UUID or display ID like "ROWO-13383".`);

  // Check cache first
  const cached = getCachedUuid(cardId);
  if (cached) return cached;

  // Search items on the board for this display ID
  const items = await fetchAllPages(`${V1}/items`, {
    workspaceId: WORKSPACE_ID,
    boardId: BOARD_ID,
    search: cardId,
  });
  for (const item of items) {
    const did = item.displayId || item.number || item.key;
    if (did === cardId) {
      cacheDisplayId(cardId, item.id);
      return item.id;
    }
  }

  throw new Error(`Could not resolve display ID "${cardId}" to a UUID. Card not found.`);
}

// ---------------------------------------------------------------------------
// Public API: Cards
// ---------------------------------------------------------------------------

export async function getCard(cardId) {
  const uuid = await resolveCardId(cardId);
  const data = await apiFetch(`${V1}/items/${uuid}`);
  if (!data) throw new Error(`Card not found: ${cardId}`);
  if (data.displayId) cacheDisplayId(data.displayId, data.id);
  return formatCard(data);
}

export async function getCardRaw(cardId) {
  const uuid = await resolveCardId(cardId);
  const data = await apiFetch(`${V1}/items/${uuid}`);
  if (!data) throw new Error(`Card not found: ${cardId}`);
  if (data.displayId) cacheDisplayId(data.displayId, data.id);
  return data;
}

export async function listCards(filters = {}) {
  const params = {
    workspaceId: WORKSPACE_ID,
    boardId: BOARD_ID,
  };
  if (filters.archived !== undefined) params.archived = String(filters.archived);
  if (filters.status) params.status = filters.status;
  if (filters.assignee_id) params.assignedUserId = filters.assignee_id;
  if (filters.completed !== undefined) params.completed = String(filters.completed);
  // Server-side tag filter (much faster than fetching all items)
  if (filters.serverTag) params.tags = filters.serverTag;

  let items = await fetchAllPages(`${V1}/items`, params);

  // Default: parent cards only
  if (filters.parent_only !== false) {
    items = items.filter(i => !i.parentId);
  }

  // Tag filter (client-side)
  if (filters.tags && filters.tags.length > 0) {
    const tagSet = new Set(filters.tags.map(t => t.toLowerCase()));
    items = items.filter(i => {
      const itemTags = (i.tags || []).map(t => (typeof t === 'string' ? t : t.name || '').toLowerCase());
      return itemTags.some(t => tagSet.has(t));
    });
  }

  return items.map(formatCard);
}

export async function searchCards(query, filters = {}) {
  if (!query || !query.trim()) throw new Error('Search query is required');

  const params = {
    workspaceId: WORKSPACE_ID,
    boardId: BOARD_ID,
    search: query.trim(),
  };
  if (filters.archived !== undefined) params.archived = String(filters.archived);

  let items = await fetchAllPages(`${V1}/items`, params);

  if (filters.parent_only !== false) {
    items = items.filter(i => !i.parentId);
  }

  return items.map(formatCard);
}

export async function createCard({ title, statusId, assignedUserId, description, tags, customFields, parentId, rowId }) {
  if (!title) throw new Error('Card title is required');

  const body = {
    title,
    workspaceId: WORKSPACE_ID,
    boardId: BOARD_ID,
  };
  if (statusId) body.statusId = statusId;
  if (assignedUserId) body.assignedUserId = assignedUserId;
  if (rowId) body.rowId = rowId;
  if (description) body.description = description;
  if (tags) body.tags = tags;
  if (customFields) body.customFields = customFields;
  if (parentId) body.parentId = await resolveCardId(parentId);

  const data = await apiFetch(`${V1}/items`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (data?.displayId) cacheDisplayId(data.displayId, data.id);
  return formatCard(data);
}

export async function updateCard(cardId, fields) {
  const uuid = await resolveCardId(cardId);

  const data = await apiFetch(`${V1}/items/${uuid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: fields }),
  });

  if (data?.displayId) cacheDisplayId(data.displayId, data.id);
  return formatCard(data);
}

export async function removeTag(cardId, tagToRemove) {
  const uuid = await resolveCardId(cardId);
  const current = await apiFetch(`${V1}/items/${uuid}`);
  if (!current) throw new Error(`Card not found: ${cardId}`);

  const currentTags = (current.tags || []).map(t => typeof t === 'string' ? t : t.name || t);
  const updatedTags = currentTags.filter(t => t !== tagToRemove);

  const data = await apiFetch(`${V1}/items/${uuid}`, {
    method: 'PUT',
    body: JSON.stringify({ data: { tags: updatedTags } }),
  });

  return formatCard(data);
}

// ---------------------------------------------------------------------------
// Public API: Users
// ---------------------------------------------------------------------------

export async function listUsers() {
  const cacheKey = 'users';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const data = await apiFetch(`${V1}/users`);
    const users = unwrapItems(data).map(u => ({
      id: u.id,
      name: u.name || u.title || u.displayName || u.fullName || '',
      email: u.email || '',
    }));
    setCache(cacheKey, users);
    return users;
  } catch (err) {
    if (err.message.includes('403')) {
      return [];
    }
    throw err;
  }
}

export async function getUserByName(name) {
  if (!name) throw new Error('User name is required');
  const users = await listUsers();
  const lower = name.toLowerCase();
  const match = users.find(u => u.name.toLowerCase().includes(lower));
  if (!match) throw new Error(`No user found matching name "${name}"`);
  return match;
}

export async function getUserByEmail(email) {
  if (!email) throw new Error('User email is required');
  const users = await listUsers();
  const lower = email.toLowerCase();
  const match = users.find(u => u.email.toLowerCase() === lower);
  if (!match) throw new Error(`No user found with email "${email}"`);
  return match;
}

// ---------------------------------------------------------------------------
// Public API: Board structure
// ---------------------------------------------------------------------------

export async function getBoardStatuses() {
  const cacheKey = 'statuses';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await apiFetch(`${V1}/boards/${BOARD_ID}/statuses`);
  const statuses = unwrapItems(data).map(s => ({
    id: s.id,
    name: s.name || s.title || '',
    order: s.order ?? s.position ?? 0,
  }));

  setCache(cacheKey, statuses);
  return statuses;
}

export async function getBoardRows() {
  const cacheKey = 'rows';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const data = await apiFetch(`${V1}/boards/${BOARD_ID}/rows`);
  const rows = unwrapItems(data);
  setCache(cacheKey, rows);
  return rows;
}

export async function getBoardMetadata() {
  const cacheKey = 'board_meta';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  // Fetch workspace info + board list to find our board
  const wsData = await apiFetch(`${V1}/workspaces/${WORKSPACE_ID}`);
  const boards = await apiFetch(`${V1}/workspaces/${WORKSPACE_ID}/boards`);
  const boardList = unwrapItems(boards);
  const ourBoard = boardList.find(b => b.id === BOARD_ID) || boardList[0];

  const result = {
    workspace: wsData,
    board: ourBoard,
    allBoards: boardList.map(b => ({ id: b.id, name: b.name || b.title || '' })),
  };

  setCache(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Public API: Attachments
// ---------------------------------------------------------------------------

export async function getCardAttachments(cardId) {
  const uuid = await resolveCardId(cardId);
  const data = await apiFetch(`${V1}/items/${uuid}/attachments`);
  return unwrapItems(data);
}

// ---------------------------------------------------------------------------
// Public API: Custom fields
// ---------------------------------------------------------------------------

export async function getCardCustomField(cardId, fieldName) {
  if (!fieldName) throw new Error('Field name is required');
  const card = await getCardRaw(cardId);
  const fields = card.customFields || card.customFieldValues || [];
  const lower = fieldName.toLowerCase();
  const match = fields.find(f => {
    const name = (f.name || f.fieldName || f.label || '').toLowerCase();
    return name === lower || name.includes(lower);
  });
  if (!match) return { field: fieldName, value: null, found: false };
  return { field: fieldName, value: match.value ?? match.textValue ?? match.numberValue ?? match.dateValue ?? null, found: true };
}

export async function extractProjectInfo(cardId) {
  const card = await getCardRaw(cardId);
  const fields = card.customFields || card.customFieldValues || [];

  function findField(...names) {
    for (const name of names) {
      const lower = name.toLowerCase();
      const match = fields.find(f => {
        const fn = (f.name || f.fieldName || f.label || '').toLowerCase();
        return fn === lower || fn.includes(lower);
      });
      if (match) return match.value ?? match.textValue ?? match.numberValue ?? match.dateValue ?? null;
    }
    return null;
  }

  return {
    cardId: card.id,
    displayId: card.displayId || card.number || null,
    projectName: card.title || '',
    description: stripHtml(card.description || ''),
    clientContact: findField('client contact', 'client', 'contact'),
    drawingRef: findField('drawing ref', 'drawing reference', 'drawing'),
    category: findField('category', 'type'),
    modelUrl: findField('3d model', 'model url', '3d model url', 'model'),
  };
}

// ---------------------------------------------------------------------------
// Public API: Relationships
// ---------------------------------------------------------------------------

export async function getCardChildren(cardId) {
  const uuid = await resolveCardId(cardId);
  // No dedicated children endpoint — fetch all items and filter by parentId
  const allItems = await fetchAllPages(`${V1}/items`, {
    workspaceId: WORKSPACE_ID,
    boardId: BOARD_ID,
  });
  return allItems.filter(i => i.parentId === uuid).map(formatCard);
}

export async function getCardParent(cardId) {
  const card = await getCardRaw(cardId);
  if (!card.parentId) return { parent: null, message: 'This card has no parent' };
  const parent = await apiFetch(`${V1}/items/${card.parentId}`);
  if (!parent) return { parent: null, message: 'Parent card not found' };
  return formatCard(parent);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCard(card) {
  if (!card) return null;
  return {
    id: card.id,
    displayId: card.displayId || card.number || null,
    title: card.title || '',
    description: stripHtml(card.description || ''),
    statusId: card.statusId || null,
    statusName: card.statusName || card.status?.name || null,
    assignedUserId: card.assignedUserId || null,
    assignedUserName: resolveUserName(card.assignedUserId),
    rowId: card.rowId || null,
    parentId: card.parentId || null,
    completed: card.completed || false,
    url: card.url || null,
    tags: (card.tags || []).map(t => typeof t === 'string' ? t : t.name || t),
    customFields: (card.customFields || card.customFieldValues || []).map(f => ({
      name: f.name || f.fieldName || f.label || 'unknown',
      value: f.value ?? f.textValue ?? f.numberValue ?? f.dateValue ?? null,
    })),
    createdAt: card.createdAt || card.createdDate || null,
    updatedAt: card.updatedAt || card.modifiedDate || null,
  };
}

// Export config for validation
export function getConfig() {
  return {
    apiKeySet: !!API_KEY,
    baseUrl: BASE_URL,
    workspaceId: WORKSPACE_ID || '(not set)',
    boardId: BOARD_ID || '(not set)',
  };
}
