/**
 * Which board the pricing workflow reads cards from.
 *
 *   CARD_SOURCE=teamhood  (default) — Teamhood via ../teamhood/api.js
 *   CARD_SOURCE=kanban              — Node Kanban via ../kanban/api.js (needs KANBAN_API_KEY)
 *
 * The dashboard (/api/cards, attachments, done) and the approve flow import from here, so flipping
 * the variable on Railway moves the whole pricing workflow to the board without a code change.
 * The Teamhood MCP tools in ../teamhood/tools.js deliberately keep talking to Teamhood.
 */
import * as teamhood from '../teamhood/api.js';
import * as kanban from '../kanban/api.js';

export const CARD_SOURCE = (process.env.CARD_SOURCE || 'teamhood').toLowerCase() === 'kanban' ? 'kanban' : 'teamhood';

const impl = CARD_SOURCE === 'kanban' ? kanban : teamhood;

export const getCard = impl.getCard;
export const getCardRaw = impl.getCardRaw;
export const listCards = impl.listCards;
export const searchCards = impl.searchCards;
export const removeTag = impl.removeTag;
export const getCardAttachments = impl.getCardAttachments;
export const getAttachmentContent = impl.getAttachmentContent;
export const getCardChildren = impl.getCardChildren;
export const getConfig = impl.getConfig;

/** Label for logs, health and the dashboard. */
export const SOURCE_LABEL = CARD_SOURCE === 'kanban' ? 'Node Kanban' : 'Teamhood';
