import { z } from 'zod';
import * as api from './api.js';
import { parseCardTitle } from '../utils/title-parser.js';
import { lookupClient } from '../utils/client-lookup.js';
import { findSimilarQuotes } from '../utils/quote-matcher.js';
import { extractDisplayIdFromUrl } from '../utils/id-resolver.js';

// Client codes excluded from the quote workflow
const EXCLUDED_CLIENT_CODES = new Set(['BFT']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
}

function error(e) {
  return {
    content: [{ type: 'text', text: 'Error: ' + e.message }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Register all Teamhood tools
// ---------------------------------------------------------------------------

export function registerTeamhoodTools(server) {
  // =========================================================================
  // CARD TOOLS (6)
  // =========================================================================

  // 1. get_card
  server.tool(
    'get_card',
    'Get a Teamhood card by its ID (UUID or display ID like "ROWO-13383"). Returns all card fields including title, description, status, owner, tags, and custom fields.',
    {
      card_id: z.string().describe('Card UUID or display ID (e.g. "ROWO-13383")'),
    },
    async ({ card_id }) => {
      try {
        const result = await api.getCard(card_id);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 2. get_card_by_url
  server.tool(
    'get_card_by_url',
    'Get a Teamhood card by its URL. Extracts the display ID from the URL and fetches the card.',
    {
      url: z.string().describe('Teamhood card URL (e.g. "https://node.teamhood.com/ROWO/Board/LIPR/ROWO-13383")'),
    },
    async ({ url }) => {
      try {
        const displayId = extractDisplayIdFromUrl(url);
        if (!displayId) throw new Error(`Could not extract a card display ID from URL: ${url}`);
        const result = await api.getCard(displayId);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 3. list_cards
  server.tool(
    'list_cards',
    'List Teamhood cards with optional filters. Returns parent-level cards by default. Automatically handles pagination.',
    {
      status: z.string().optional().describe('Filter by status name or ID'),
      assignee_id: z.string().optional().describe('Filter by assignee user ID'),
      tags: z.array(z.string()).optional().describe('Filter by tags (cards matching any tag are returned)'),
      archived: z.boolean().optional().describe('Include archived cards (default: false)'),
      parent_only: z.boolean().optional().describe('Return only parent cards, not subtasks (default: true)'),
    },
    async ({ status, assignee_id, tags, archived, parent_only }) => {
      try {
        const result = await api.listCards({
          status,
          assignee_id,
          tags,
          archived,
          parent_only,
        });
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 4. search_cards
  server.tool(
    'search_cards',
    'Search Teamhood cards by title and description. Returns matching cards with optional filters.',
    {
      query: z.string().describe('Search query (matches against title and description)'),
      archived: z.boolean().optional().describe('Include archived cards (default: false)'),
      parent_only: z.boolean().optional().describe('Return only parent cards (default: true)'),
    },
    async ({ query, archived, parent_only }) => {
      try {
        const result = await api.searchCards(query, {
          archived,
          parent_only,
        });
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 5. create_card
  server.tool(
    'create_card',
    'Create a new Teamhood card on the board.',
    {
      title: z.string().describe('Card title'),
      statusId: z.string().optional().describe('Status ID to place the card in'),
      assignedUserId: z.string().optional().describe('User ID to assign the card to'),
      description: z.string().optional().describe('Card description (supports HTML)'),
      tags: z.array(z.string()).optional().describe('Tags to apply to the card'),
      customFields: z.array(z.any()).optional().describe('Custom field values to set'),
      parentId: z.string().optional().describe('Parent card ID to create this as a subtask'),
    },
    async ({ title, statusId, assignedUserId, description, tags, customFields, parentId }) => {
      try {
        const result = await api.createCard({
          title,
          statusId,
          assignedUserId,
          description,
          tags,
          customFields,
          parentId,
        });
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 6. update_card
  server.tool(
    'update_card',
    'Update an existing Teamhood card. Uses PUT (full replace merged with current values).',
    {
      card_id: z.string().describe('Card UUID or display ID'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      statusId: z.string().optional().describe('New status ID'),
      assignedUserId: z.string().optional().describe('New assignee user ID'),
      tags: z.array(z.string()).optional().describe('New tags'),
    },
    async ({ card_id, ...fields }) => {
      try {
        const result = await api.updateCard(card_id, fields);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // =========================================================================
  // USER TOOLS (3)
  // =========================================================================

  // 7. list_users
  server.tool(
    'list_users',
    'List all users in the Teamhood workspace. Returns id, name, and email for each user.',
    {},
    async () => {
      try {
        const users = await api.listUsers();
        if (!users.length) {
          return success({ users: [], message: 'No users returned — the API key may not have permission for the users endpoint.' });
        }
        return success(users);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 8. get_user_by_name
  server.tool(
    'get_user_by_name',
    'Find a Teamhood user by name (fuzzy/partial match).',
    {
      name: z.string().describe('User name to search for (partial match supported)'),
    },
    async ({ name }) => {
      try {
        const result = await api.getUserByName(name);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 9. get_user_by_email
  server.tool(
    'get_user_by_email',
    'Find a Teamhood user by their email address (exact match).',
    {
      email: z.string().describe('User email address'),
    },
    async ({ email }) => {
      try {
        const result = await api.getUserByEmail(email);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // =========================================================================
  // BOARD TOOLS (3)
  // =========================================================================

  // 10. get_board_statuses
  server.tool(
    'get_board_statuses',
    'Get all statuses (columns) for the Teamhood board. Returns id, name, and order for each status.',
    {},
    async () => {
      try {
        const result = await api.getBoardStatuses();
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 11. get_board_rows
  server.tool(
    'get_board_rows',
    'Get all rows (swimlanes) for the Teamhood board.',
    {},
    async () => {
      try {
        const result = await api.getBoardRows();
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 12. get_board_metadata
  server.tool(
    'get_board_metadata',
    'Get board metadata including workspace details, settings, and configuration.',
    {},
    async () => {
      try {
        const result = await api.getBoardMetadata();
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // =========================================================================
  // ATTACHMENT TOOLS (1)
  // =========================================================================

  // 13. get_card_attachments
  server.tool(
    'get_card_attachments',
    'Get all attachments for a Teamhood card. Returns file names, URLs, and metadata.',
    {
      card_id: z.string().describe('Card UUID or display ID (e.g. "ROWO-13383")'),
    },
    async ({ card_id }) => {
      try {
        const result = await api.getCardAttachments(card_id);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // =========================================================================
  // CUSTOM FIELD TOOLS (2)
  // =========================================================================

  // 14. get_card_custom_field
  server.tool(
    'get_card_custom_field',
    'Get the value of a specific custom field on a Teamhood card. Uses fuzzy name matching.',
    {
      card_id: z.string().describe('Card UUID or display ID'),
      field_name: z.string().describe('Name of the custom field to retrieve (partial match supported)'),
    },
    async ({ card_id, field_name }) => {
      try {
        const result = await api.getCardCustomField(card_id, field_name);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 15. extract_project_info
  server.tool(
    'extract_project_info',
    'Extract structured project information from a Teamhood card for quote generation. Returns project name, client contact, drawing ref, category, 3D model URL, and description.',
    {
      card_id: z.string().describe('Card UUID or display ID'),
    },
    async ({ card_id }) => {
      try {
        const result = await api.extractProjectInfo(card_id);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // =========================================================================
  // RELATIONSHIP TOOLS (2)
  // =========================================================================

  // 16. get_card_children
  server.tool(
    'get_card_children',
    'Get all child cards (subtasks) of a Teamhood card.',
    {
      card_id: z.string().describe('Parent card UUID or display ID'),
    },
    async ({ card_id }) => {
      try {
        const result = await api.getCardChildren(card_id);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 17. get_card_parent
  server.tool(
    'get_card_parent',
    'Get the parent card of a Teamhood card, if it exists.',
    {
      card_id: z.string().describe('Child card UUID or display ID'),
    },
    async ({ card_id }) => {
      try {
        const result = await api.getCardParent(card_id);
        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // =========================================================================
  // QUOTE TOOLS (2)
  // =========================================================================

  // 18. list_price_required
  server.tool(
    'list_price_required',
    'List all Teamhood cards tagged "Price Required" that need quotes. Returns card details including parsed client code, Zoho customer name, site name, scope, and suggested pricing from similar past quotes.',
    {
      include_completed: z.boolean().optional().describe('Include completed cards (default: false)'),
    },
    async ({ include_completed = false }) => {
      try {
        // Use server-side tag filter -- fetches ~65 items instead of 5000
        const filters = {
          parent_only: true,
          serverTag: 'Price Required',
        };
        if (!include_completed) filters.completed = false;

        const cards = await api.listCards(filters);

        const priceRequired = cards.filter(card => {
          // Exclude filtered client codes (e.g. BFT)
          const parsed = parseCardTitle(card.title);
          if (parsed.clientCode && EXCLUDED_CLIENT_CODES.has(parsed.clientCode)) return false;
          return true;
        });

        const result = priceRequired.map(card => {
          const parsed = parseCardTitle(card.title);
          const client = lookupClient(parsed.clientCode);
          const pricing = findSimilarQuotes(card.title, parsed.scope, client?.customerName, 3);

          return {
            id: card.id,
            displayId: card.displayId,
            title: card.title,
            clientCode: parsed.clientCode,
            zohoCustomerName: client ? client.customerName : null,
            siteName: parsed.siteName,
            scope: parsed.scope,
            assignedUserName: card.assignedUserName,
            suggestedRate: pricing.suggestedRate,
            matchedKeywords: pricing.keywords,
            topMatch: pricing.similarQuotes[0] ? {
              estimateNumber: pricing.similarQuotes[0].estimateNumber,
              reference: pricing.similarQuotes[0].reference,
              total: pricing.similarQuotes[0].total,
              matchScore: pricing.similarQuotes[0].matchScore,
            } : null,
            customFields: card.customFields,
            completed: card.completed,
            url: card.url,
          };
        });

        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  // 19. prepare_quote_data
  server.tool(
    'prepare_quote_data',
    'Extract and format all data from a Teamhood card needed to create a Zoho draft estimate. Includes suggested pricing from similar past quotes in the reference database. Use the returned zohoCustomerName to search Zoho contacts for the customer_id, then call create_estimate with the returned estimateData.',
    {
      card_id: z.string().describe('Teamhood card UUID or display ID (e.g. "ROWO-13214")'),
    },
    async ({ card_id }) => {
      try {
        // 1. Fetch the Teamhood card
        const card = await api.getCard(card_id);
        if (!card) throw new Error(`Card not found: ${card_id}`);

        // 2. Parse the title
        const parsed = parseCardTitle(card.title);
        if (!parsed.clientCode) {
          throw new Error(`Could not parse client code from card title: "${card.title}". Expected format: [XXX### - Site Name] Description`);
        }

        // 3. Look up client from client-identifiers.txt
        const client = lookupClient(parsed.clientCode);
        if (!client) {
          throw new Error(`Client code "${parsed.clientCode}" not found in client-identifiers.txt. Please add it to the file.`);
        }

        // 4. Extract useful custom fields
        const customFieldMap = {};
        for (const cf of (card.customFields || [])) {
          if (cf.value) customFieldMap[cf.name] = cf.value;
        }

        // 5. Find similar past quotes for pricing
        const pricing = findSimilarQuotes(card.title, parsed.scope, client.customerName, 5);

        // 6. Build notes block for the estimate
        const notesParts = [];
        if (parsed.scope) notesParts.push(`Scope: ${parsed.scope}`);
        if (customFieldMap['Client Contact']) notesParts.push(`Client Contact: ${customFieldMap['Client Contact']}`);
        if (customFieldMap['Drawing Ref']) notesParts.push(`Drawing Ref: ${customFieldMap['Drawing Ref']}`);
        if (customFieldMap['3D Model']) notesParts.push(`3D Model: ${customFieldMap['3D Model']}`);
        if (card.description) notesParts.push(`\nDescription:\n${card.description}`);
        if (card.url) notesParts.push(`\nTeamhood: ${card.url}`);

        // 7. Build suggested line items using pricing data
        const suggestedRate = pricing.suggestedRate?.median || pricing.suggestedRate?.average || 0;

        // 8. Return everything needed to create the Zoho estimate
        const result = {
          // Card identifiers
          cardId: card.id,
          displayId: card.displayId,
          cardUrl: card.url,

          // Parsed title components
          clientCode: parsed.clientCode,
          siteName: parsed.siteName,
          scope: parsed.scope,

          // Zoho customer (from client-identifiers.txt)
          zohoCustomerName: client.customerName,
          zohoLookup: {
            instruction: `Search Zoho contacts for "${client.customerName}" to get the customer_id, then create the estimate.`,
          },

          // Pricing intelligence from reference database
          pricing: {
            suggestedRate: pricing.suggestedRate,
            matchedKeywords: pricing.keywords,
            similarQuotes: pricing.similarQuotes,
          },

          // Ready-to-use estimate data (just needs customer_id added)
          estimateData: {
            reference_number: card.displayId,
            notes: notesParts.join('\n'),
            line_items: [{
              name: '- Design & Analysis (UK)',
              description: `${parsed.scope || card.title}\n${parsed.siteName || ''} - ${card.displayId}`,
              quantity: 1,
              rate: suggestedRate,
            }],
          },

          // Additional context
          assignedTo: card.assignedUserName,
          customFields: customFieldMap,
        };

        return success(result);
      } catch (e) {
        return error(e);
      }
    },
  );
}
