import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUOTE_DB_PATH = process.env.QUOTE_DB_PATH || join(__dirname, '../../data/quote_reference_db.json');

const HOURLY_RATE = 85;
const HALF_HOUR = 42.50;

let quoteDb = null;

function loadQuoteDb() {
  if (quoteDb) return quoteDb;
  try {
    const text = readFileSync(QUOTE_DB_PATH, 'utf-8');
    quoteDb = JSON.parse(text);
  } catch (err) {
    console.warn(`[quote-matcher] Could not read ${QUOTE_DB_PATH}: ${err.message}`);
    quoteDb = [];
  }
  return quoteDb;
}

function roundToHalfHour(v) {
  return Math.round(v / HALF_HOUR) * HALF_HOUR;
}

// ---------------------------------------------------------------------------
// Text similarity — compare words between two texts
// ---------------------------------------------------------------------------

/**
 * Tokenize text into meaningful words (3+ chars, lowercased, no common stopwords).
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'were',
  'been', 'being', 'have', 'has', 'had', 'not', 'but', 'all', 'can', 'her',
  'his', 'its', 'may', 'will', 'shall', 'should', 'would', 'could', 'into',
  'over', 'under', 'between', 'through', 'during', 'before', 'after', 'above',
  'below', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'than', 'too', 'very', 'just', 'also', 'yes', 'none', 'included',
]);

function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Calculate text similarity between two strings.
 * Returns 0-1 based on shared significant words.
 */
function textSimilarity(textA, textB) {
  const wordsA = new Set(tokenize(textA));
  const wordsB = new Set(tokenize(textB));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }

  // Jaccard-like: shared / union
  const union = new Set([...wordsA, ...wordsB]).size;
  return shared / union;
}

/**
 * Score a past quote against a card.
 *
 * Scoring weights:
 *   - Line item description text vs card description: 0.5
 *   - Reference text vs card scope/title: 0.3
 *   - Line item description vs card scope/title: 0.2
 */
function scoreQuote(quote, cardTitle, cardScope, cardDescription) {
  const quoteDescText = quote.line_items.map(li => li.description || '').join('\n');
  const quoteRefText = quote.reference || '';

  const scopeText = `${cardTitle} ${cardScope}`;

  // Description-to-description similarity (heaviest weight)
  const descScore = cardDescription
    ? textSimilarity(quoteDescText, cardDescription)
    : 0;

  // Reference-to-scope similarity
  const refScore = textSimilarity(quoteRefText, scopeText);

  // Quote description-to-scope similarity
  const descToScopeScore = textSimilarity(quoteDescText, scopeText);

  return (descScore * 0.5) + (refScore * 0.3) + (descToScopeScore * 0.2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find similar past quotes for a given card.
 *
 * Strategy:
 *   1. Search same client's quotes first
 *   2. If fewer than `limit` good matches, fill from all quotes
 *   3. Score by text similarity (description + scope weighted)
 *   4. Return score-weighted suggested rate rounded to half-hours
 */
export function findSimilarQuotes(title, scope, clientName, limit = 5) {
  const db = loadQuoteDb();

  // Strip HTML from card description if present
  const cardDesc = (title + ' ' + scope).replace(/<[^>]+>/g, ' ');

  if (!title && !scope) {
    return { keywords: [], suggestedRate: null, similarQuotes: [], message: 'No scope text to match.' };
  }

  // Separate client quotes from others
  const clientLower = (clientName || '').toLowerCase();
  const clientQuotes = [];
  const otherQuotes = [];

  for (const quote of db) {
    if (quote.status === 'declined' || quote.status === 'expired') continue;
    const isClient = clientLower && (quote.client || '').toLowerCase().includes(clientLower.split(' ')[0]);
    if (isClient) clientQuotes.push(quote);
    else otherQuotes.push(quote);
  }

  // Score and rank client quotes first
  function scoreAndSort(quotes, isClientMatch) {
    return quotes
      .map(quote => {
        const score = scoreQuote(quote, title, scope, cardDesc);
        return { quote, score, isClientMatch };
      })
      .filter(m => m.score > 0.02)
      .sort((a, b) => {
        if (Math.abs(b.score - a.score) > 0.02) return b.score - a.score;
        return (b.quote.date || '').localeCompare(a.quote.date || '');
      });
  }

  const clientMatches = scoreAndSort(clientQuotes, true);
  const otherMatches = scoreAndSort(otherQuotes, false);

  // Take client matches first, fill remaining from others
  const topMatches = [];
  for (const m of clientMatches) {
    if (topMatches.length >= limit) break;
    topMatches.push(m);
  }
  for (const m of otherMatches) {
    if (topMatches.length >= limit) break;
    topMatches.push(m);
  }

  // Calculate score-weighted rate
  let suggestedRate = null;
  if (topMatches.length > 0) {
    const ratesWithScores = topMatches.flatMap(m =>
      m.quote.line_items
        .filter(li => li.rate > 0)
        .map(li => ({ rate: li.rate, score: m.score, isClient: m.isClientMatch }))
    );

    if (ratesWithScores.length > 0) {
      const rates = ratesWithScores.map(r => r.rate);

      // Client matches get 2x weight in the average
      const totalWeight = ratesWithScores.reduce((sum, r) => sum + r.score * (r.isClient ? 2 : 1), 0);
      const weightedRate = totalWeight > 0
        ? ratesWithScores.reduce((sum, r) => sum + r.rate * r.score * (r.isClient ? 2 : 1), 0) / totalWeight
        : rates.reduce((a, b) => a + b, 0) / rates.length;

      suggestedRate = {
        weighted: roundToHalfHour(weightedRate),
        average: roundToHalfHour(rates.reduce((a, b) => a + b, 0) / rates.length),
        min: Math.min(...rates),
        max: Math.max(...rates),
        median: roundToHalfHour(rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)]),
        hours: +(weightedRate / HOURLY_RATE).toFixed(1),
      };
    }
  }

  // Extract matched keywords for display
  const keywords = tokenize(`${title} ${scope}`)
    .filter(w => w.length >= 4)
    .slice(0, 8);

  return {
    keywords: [...new Set(keywords)],
    suggestedRate,
    similarQuotes: topMatches.map(({ quote, score, isClientMatch }) => ({
      estimateNumber: quote.estimate_number,
      date: quote.date,
      client: quote.client,
      project: quote.project,
      reference: quote.reference,
      status: quote.status,
      matchScore: Math.round(score * 100) + '%',
      isClientMatch,
      lineItems: quote.line_items.map(li => ({
        name: li.name,
        description: li.description || '',
        descriptionPreview: (li.description || '').slice(0, 150),
        quantity: li.quantity,
        rate: li.rate,
        total: li.total,
      })),
      subTotal: quote.sub_total,
      total: quote.total,
    })),
  };
}

export function reloadQuoteDb() {
  quoteDb = null;
  return loadQuoteDb();
}
