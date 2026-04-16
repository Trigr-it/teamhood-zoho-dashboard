/**
 * Parse Teamhood card titles in the format:
 *   [PRO183 - One North Quay] Full perimeter access scaffold
 *
 * Returns:
 *   { clientCode: "PRO", siteName: "One North Quay", scope: "Full perimeter access scaffold" }
 */
export function parseCardTitle(title) {
  if (!title) return { clientCode: null, siteName: null, scope: title || '' };

  // Extract the bracketed portion: [CODE - Site Name]
  const bracketMatch = title.match(/^\[(.+?)\]\s*(.*)/);
  if (!bracketMatch) {
    return { clientCode: null, siteName: null, scope: title };
  }

  const inside = bracketMatch[1]; // e.g. "PRO183 - One North Quay"
  const scope = bracketMatch[2].trim();

  // Split on first " - " to get code+number and site name
  const dashIdx = inside.indexOf(' - ');
  if (dashIdx === -1) {
    return { clientCode: null, siteName: null, scope: title };
  }

  const codeAndNum = inside.slice(0, dashIdx).trim(); // e.g. "PRO183" or "BFT337/HO6102" or "ARTxxx"
  const siteName = inside.slice(dashIdx + 3).trim();

  // Extract client code: leading letters from the first part (before / if present)
  // Strip trailing x/X used as placeholders (e.g. "ARTxxx" → "ART")
  const primaryCode = codeAndNum.split('/')[0];
  const codeMatch = primaryCode.match(/^([A-Za-z]+)/);
  if (!codeMatch) {
    return { clientCode: null, siteName, scope };
  }

  const rawCode = codeMatch[1].toUpperCase();
  const clientCode = rawCode.replace(/X+$/, '') || rawCode;

  return {
    clientCode,
    siteName,
    scope,
  };
}
