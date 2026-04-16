import * as teamhoodApi from './teamhood/api.js';
import { zohoRequest, buildQueryString } from './zoho/api.js';
import { parseCardTitle } from './utils/title-parser.js';
import { lookupClient } from './utils/client-lookup.js';
import { findSimilarQuotes } from './utils/quote-matcher.js';

const DEFAULT_TAX_ID = '70776000000030063'; // Standard Rate VAT

// Salesperson IDs
const SALESPERSON = {
  UK: '70776000004849675',        // Scaffold Design
  IE: '70776000004920001',        // Scaffold Design - Ireland
  POWERED_UK: '70776000004849677', // Powered Design
  POWERED_IE: '70776000005368119', // Powered Design - Ireland
};

// Irish client codes (use IE salesperson + no VAT)
const IE_CLIENT_CODES = new Set(['LAO', 'MSL', 'GCS', 'AIN', '3SC', 'BHL', 'GAB', 'GRP']);

// Line item description template (blank — to be filled in by the designer)
const UK_DESCRIPTION_TEMPLATE = `Title:
Grid Lines:

3D Model: No / Yes

System:
Tube & Fitting
Cuplok
AT-PAC
LAYHER

Load Class:
BS EN 1991-1-4 Environmental Loads
BS EN 13374 Edge Protection Loads
Class A Protection (0.75kN/m2)
Class B Protection (1.00kN/m2)
Light Duty (1.50kN/m2)
General Purpose (2.00kN/m2)
Heavy Duty (3.00kN/m2)
Loading Platform LD (5.00kN/m2)
Loading Platform HD (10.00kN/m2)

Cladding:
Unclad
Netting
Sheeting
Shrink Wrap

Ties:
None
To concrete structure
To steel structure
To brickwork facade

Length:
Width:
Height:

Ancillaries:
CAT II Check - Included
Bridging - Partial length max X.XXm
Bridging - Full length of elevation
Protection Fan - 6no boards wide
Pavement Lift - Double board and poly`;

const HOIST_DESCRIPTION_TEMPLATE = `Title:
Grid Lines:

Max Height:
3D Model: No

Machine Type:
Payload:

Tie Type:
Standard Tie - Slab Edge
Standard Tie - Soffit Fixed
Standard Tie - Steelwork
Bespoke Tie - Scaffold Runoff

Landings: 10no Max

Landing Type:
Slab Edge
Scaffold Runoff

Foundation:
Concrete Base
Scaffold Gantry
TBC

Ancillaries:
CAT II Check - Included`;

/**
 * Detect if a card is a hoist design.
 * Must have "hoist" in the title/scope AND use the hoist template
 * (contains "Hoist Spec" or "Hoist Scope" in the card description).
 */
function isHoistCard(title, scope, cardDescription) {
  const titleText = `${title} ${scope}`.toLowerCase();
  if (!titleText.includes('hoist')) return false;
  const descText = (cardDescription || '').toLowerCase();
  return descText.includes('hoist spec') || descText.includes('hoist scope');
}

/**
 * Build a concise reference string: "Site Name - Short Scope Summary"
 */
function buildReference(siteName, scope) {
  if (!siteName) return scope || '';
  // Truncate scope to a short summary (2-3 words)
  const scopeWords = (scope || '').split(/\s+/).slice(0, 4).join(' ');
  return `${siteName} - ${scopeWords}`.trim().replace(/\s*-\s*$/, '');
}

/**
 * Find or create a Zoho project for this site under the customer.
 */
async function findOrCreateProject(customerId, siteName) {
  if (!siteName) return null;

  // Search existing projects for this customer
  const projectsResult = await zohoRequest('GET', `/projects${buildQueryString({ customer_id: customerId })}`);
  const projects = projectsResult.projects || [];

  // Try to find by name match
  const lowerSite = siteName.toLowerCase();
  const existing = projects.find(p =>
    (p.project_name || '').toLowerCase().includes(lowerSite) ||
    lowerSite.includes((p.project_name || '').toLowerCase())
  );

  if (existing) return existing.project_id;

  // Create new project
  const newProject = await zohoRequest('POST', '/projects', {
    project_name: siteName,
    customer_id: customerId,
    billing_type: 'based_on_task_hours',
  });

  return newProject.project?.project_id || null;
}

// ---------------------------------------------------------------------------
// Template sections — each has a key, the exact options, and how to match
// against Teamhood card text. The template structure is ALWAYS preserved.
// ---------------------------------------------------------------------------

// Scaffold template options
const SCAFFOLD_SECTIONS = {
  system: ['Tube & Fitting', 'Cuplok', 'AT-PAC', 'LAYHER'],
  loadClass: [
    'BS EN 1991-1-4 Environmental Loads', 'BS EN 13374 Edge Protection Loads',
    'Class A Protection (0.75kN/m2)', 'Class B Protection (1.00kN/m2)',
    'Light Duty (1.50kN/m2)', 'General Purpose (2.00kN/m2)',
    'Heavy Duty (3.00kN/m2)', 'Loading Platform LD (5.00kN/m2)',
    'Loading Platform HD (10.00kN/m2)',
  ],
  cladding: ['Unclad', 'Netting', 'Sheeting', 'Shrink Wrap'],
  ties: ['None', 'To concrete structure', 'To steel structure', 'To brickwork facade'],
  ancillaries: [
    'CAT II Check - Included', 'Bridging - Partial length max X.XXm',
    'Bridging - Full length of elevation', 'Protection Fan - 6no boards wide',
    'Pavement Lift - Double board and poly',
  ],
};

// Hoist template options
const HOIST_SECTIONS = {
  tieType: [
    'Standard Tie - Slab Edge', 'Standard Tie - Soffit Fixed',
    'Standard Tie - Steelwork', 'Bespoke Tie - Scaffold Runoff',
  ],
  landingType: ['Slab Edge', 'Scaffold Runoff'],
  foundation: ['Concrete Base', 'Scaffold Gantry', 'TBC'],
  ancillaries: ['CAT II Check - Included'],
};

/**
 * Strip HTML from Teamhood description to searchable plain text.
 */
function stripCardHtml(html) {
  if (!html) return '';
  return html
    .replace(/<li class="ql-indent-1">/g, ' ')
    .replace(/<li>/g, '\n')
    .replace(/<\/li>/g, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * For a given section, find which options are mentioned in the card text.
 * Returns matched options, or null if none found.
 */
function matchOptions(options, cardText) {
  const lower = cardText.toLowerCase();
  const matched = options.filter(opt => lower.includes(opt.toLowerCase()));
  return matched.length > 0 ? matched : null;
}

/**
 * Parse the reference quote description to extract values for each section.
 * Returns a map of section key → selected values.
 */
function parseRefDescription(refDesc) {
  if (!refDesc) return {};
  const result = {};

  // Extract each section's value from the reference description
  // Covers both scaffold and hoist templates
  const sectionPatterns = [
    // Scaffold fields
    { key: 'system', pattern: /^System:\n([\s\S]*?)(?=\n\n|\nLoad Class:)/m },
    { key: 'loadClass', pattern: /^Load Class:\n([\s\S]*?)(?=\n\n|\nCladding:|$)/m },
    { key: 'cladding', pattern: /^Cladding:\n([\s\S]*?)(?=\n\n|\nTies:)/m },
    { key: 'ties', pattern: /^Ties:\n([\s\S]*?)(?=\n\n|\nLength:)/m },
    { key: 'length', pattern: /^Length:\s*(.*)$/m },
    { key: 'width', pattern: /^Width:\s*(.*)$/m },
    { key: 'height', pattern: /^Height:\s*(.*)$/m },
    // Hoist fields
    { key: 'maxHeight', pattern: /^Max Height:\s*(.*)$/m },
    { key: 'machineType', pattern: /^Machine Type:\s*(.*)$/m },
    { key: 'payload', pattern: /^Payload:\s*(.*)$/m },
    { key: 'tieType', pattern: /^Tie Type:\n([\s\S]*?)(?=\n\n|\nLandings:)/m },
    { key: 'landings', pattern: /^Landings:\s*(.*)$/m },
    { key: 'landingType', pattern: /^Landing Type:\n([\s\S]*?)(?=\n\n|\nFoundation:)/m },
    { key: 'foundation', pattern: /^Foundation:\s*\n([\s\S]*?)(?=\n\n|\nAncillaries:)/m },
    // Shared fields
    { key: 'ancillaries', pattern: /^Ancillaries:\n([\s\S]*?)$/m },
    { key: 'model', pattern: /^3D Model:\s*(.+)$/m },
    { key: 'gridLines', pattern: /^Grid Lines:\s*(.*)$/m },
  ];

  for (const { key, pattern } of sectionPatterns) {
    const match = refDesc.match(pattern);
    if (match) {
      result[key] = match[1].trim();
    }
  }

  return result;
}

/**
 * Get the best matching reference quote description for fallback values.
 */
function getRefValues(cardTitle, scope, clientName) {
  const pricing = findSimilarQuotes(cardTitle, scope, clientName, 5);
  for (const match of pricing.similarQuotes) {
    for (const li of match.lineItems) {
      if (li.description && li.description.includes('Title:') && !li.description.includes('No / Yes')) {
        return parseRefDescription(li.description);
      }
    }
  }
  return {};
}

/**
 * Pick the best option for a section:
 *   1. Match from Teamhood card text → use if found
 *   2. Else use reference quote value
 *   3. Else show all options (blank template)
 */
function pickSection(options, cardText, refValue) {
  const matched = matchOptions(options, cardText);
  if (matched) return matched.join('\n');
  if (refValue) return refValue;
  return options.join('\n');
}

/**
 * Build SCAFFOLD line item description.
 */
function buildScaffoldDescription(scope, cardText, refValues) {
  const title = scope || '';
  const gridLines = refValues.gridLines || '';

  let model3d = 'No / Yes';
  if (cardText.toLowerCase().includes('3d')) model3d = 'Yes';
  else if (refValues.model) model3d = refValues.model;

  const system = pickSection(SCAFFOLD_SECTIONS.system, cardText, refValues.system);
  const loadClass = pickSection(SCAFFOLD_SECTIONS.loadClass, cardText, refValues.loadClass);
  const cladding = pickSection(SCAFFOLD_SECTIONS.cladding, cardText, refValues.cladding);
  const ties = pickSection(SCAFFOLD_SECTIONS.ties, cardText, refValues.ties);
  const anc = pickSection(SCAFFOLD_SECTIONS.ancillaries, cardText, refValues.ancillaries);
  // Ensure CAT II is always present
  const ancValue = anc.includes('CAT II Check') ? anc : 'CAT II Check - Included\n' + anc;

  return `Title: ${title}
Grid Lines: ${gridLines}

3D Model: ${model3d}

System:
${system}

Load Class:
${loadClass}

Cladding:
${cladding}

Ties:
${ties}

Length: ${refValues.length || ''}
Width: ${refValues.width || ''}
Height: ${refValues.height || ''}

Ancillaries:
${ancValue}`;
}

/**
 * Build HOIST line item description.
 */
function buildHoistDescription(scope, cardText, refValues) {
  const title = scope || '';
  const gridLines = refValues.gridLines || '';
  const maxHeight = refValues.maxHeight || '';

  let model3d = 'No';
  if (cardText.toLowerCase().includes('3d')) model3d = 'Yes';
  else if (refValues.model) model3d = refValues.model;

  const machineType = refValues.machineType || '';
  const payload = refValues.payload || '';
  const landings = refValues.landings || '10no Max';

  const tieType = pickSection(HOIST_SECTIONS.tieType, cardText, refValues.tieType);
  const landingType = pickSection(HOIST_SECTIONS.landingType, cardText, refValues.landingType);
  const foundation = pickSection(HOIST_SECTIONS.foundation, cardText, refValues.foundation);
  const anc = pickSection(HOIST_SECTIONS.ancillaries, cardText, refValues.ancillaries);
  const ancValue = anc.includes('CAT II Check') ? anc : 'CAT II Check - Included\n' + anc;

  return `Title: ${title}
Grid Lines: ${gridLines}

Max Height: ${maxHeight}
3D Model: ${model3d}

Machine Type: ${machineType}
Payload: ${payload}

Tie Type:
${tieType}

Landings: ${landings}

Landing Type:
${landingType}

Foundation:
${foundation}

Ancillaries:
${ancValue}`;
}

/**
 * Build line item description using the appropriate template (scaffold or hoist).
 * For each section: card data → reference fallback → all options.
 */
function getLineItemDescription(scope, cardDescription, cardTitle, clientName) {
  const cardText = stripCardHtml(cardDescription);
  const refValues = getRefValues(cardTitle, scope, clientName);
  const hoist = isHoistCard(cardTitle, scope, cardDescription);

  if (hoist) {
    return buildHoistDescription(scope, cardText, refValues);
  }
  return buildScaffoldDescription(scope, cardText, refValues);
}

/**
 * Approve a Teamhood card → create Zoho draft estimate.
 */
export async function approveCard(cardId, { rate, quantity = 1 }) {
  // 1. Fetch card
  const card = await teamhoodApi.getCard(cardId);
  if (!card) throw new Error(`Card not found: ${cardId}`);

  const parsed = parseCardTitle(card.title);
  const client = lookupClient(parsed.clientCode);
  if (!client) {
    throw new Error(`Client code "${parsed.clientCode}" not found in client-identifiers.txt`);
  }

  const isIreland = IE_CLIENT_CODES.has(parsed.clientCode);

  // 2. Find Zoho customer
  const contactSearch = await zohoRequest('GET', `/contacts?search_text=${encodeURIComponent(client.customerName)}`);
  const contacts = contactSearch.contacts || [];
  if (contacts.length === 0) {
    throw new Error(`No Zoho contact found for "${client.customerName}". Create the contact in Zoho first.`);
  }
  const customerId = contacts[0].contact_id;
  const customerName = contacts[0].contact_name;

  // 3. Find or create project
  let projectId = null;
  try {
    projectId = await findOrCreateProject(customerId, parsed.siteName);
  } catch (err) {
    console.warn(`[approve] Project lookup/create failed for "${parsed.siteName}":`, err.message);
  }

  // 4. Extract Client Contact from Teamhood custom fields → Zoho PO Number
  const clientContact = (card.customFields || []).find(f => f.name === 'Client Contact')?.value || '';

  // 5. Build line item — detect hoist vs scaffold, use correct template
  const hoist = isHoistCard(card.title, parsed.scope, card.description);
  let lineItemName;
  if (hoist) {
    lineItemName = isIreland ? '- Design & Analysis (Hoist)' : '- Design & Analysis (Hoist)';
  } else {
    lineItemName = isIreland ? '- Design & Analysis (IE)' : '- Design & Analysis (UK)';
  }
  const lineItemDescription = getLineItemDescription(parsed.scope, card.description, card.title, client.customerName);

  // 5. Build reference: "Site Name - Short Scope"
  const reference = buildReference(parsed.siteName, parsed.scope);

  // 6. Salesperson
  const salespersonId = isIreland ? SALESPERSON.IE : SALESPERSON.UK;

  // 7. Create draft estimate
  const estimateBody = {
    customer_id: customerId,
    reference_number: reference,
    salesperson_id: salespersonId,
    custom_fields: clientContact ? [{ api_name: 'cf_po_number', value: clientContact }] : [],
    line_items: [{
      name: lineItemName,
      description: lineItemDescription,
      quantity,
      rate: rate || 0,
      tax_id: isIreland ? undefined : DEFAULT_TAX_ID,
    }],
  };

  if (projectId) estimateBody.project_id = projectId;

  const result = await zohoRequest('POST', '/estimates', estimateBody);

  if (result.code && result.code !== 0) {
    throw new Error(`Zoho error: ${result.message || JSON.stringify(result)}`);
  }

  return {
    success: true,
    estimateId: result.estimate?.estimate_id,
    estimateNumber: result.estimate?.estimate_number,
    customerName,
    projectName: parsed.siteName,
    reference,
    displayId: card.displayId,
    rate,
    isIreland,
  };
}
