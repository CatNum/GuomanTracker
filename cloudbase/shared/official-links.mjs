import { createHash } from 'node:crypto';
import { parseOfficialUrl } from './official-url.mjs';

/** Server wrapper adds a stable canonical-link identifier to the shared pure parser. */
export function normalizeOfficialUrl(input) {
  const normalized = parseOfficialUrl(input);
  return { ...normalized, id: `official-${createHash('sha256').update(normalized.url).digest('hex')}` };
}
