/** Structured parsing for Israeli free-text addresses (Hebrew + Latin). */

export type CityAlias = {
  /** Canonical Hebrew display name */
  nameHe: string;
  /** Tokens/phrases that identify this city in a query (longest match wins). */
  keys: string[];
  /** Matches place.city / place.label */
  needle: RegExp;
  /** Optional focus point for Overpass / structured bias */
  focus?: { lng: number; lat: number };
};

export type ParsedAddress = {
  raw: string;
  normalized: string;
  street: string | null;
  housenumber: string | null;
  city: CityAlias | null;
  /** Tokens useful for ranking (street words, excluding city / prefixes / HN). */
  streetTokens: string[];
};

export const CITY_ALIASES: CityAlias[] = [
  {
    nameHe: "תל אביב",
    keys: ["תל אביב יפו", "תל־אביב–יפו", "תל אביב-יפו", "תל אביב", "תל-אביב", "תל־אביב", "tel aviv yafo", "tel aviv", "tel-aviv"],
    needle: /תל[\s\-־–]?אביב|tel[\s\-]?aviv/i,
    focus: { lng: 34.78, lat: 32.08 },
  },
  {
    nameHe: "ירושלים",
    keys: ["ירושלים", "jerusalem"],
    needle: /ירושלים|jerusalem/i,
    focus: { lng: 35.22, lat: 31.78 },
  },
  {
    nameHe: "חיפה",
    keys: ["חיפה", "haifa"],
    needle: /חיפה|haifa/i,
    focus: { lng: 34.99, lat: 32.82 },
  },
  {
    nameHe: "גבעתיים",
    keys: ["גבעתיים", "givatayim", "givataim"],
    needle: /גבעתיים|givatayim|givataim/i,
    focus: { lng: 34.81, lat: 32.07 },
  },
  {
    nameHe: "רמת גן",
    keys: ["רמת גן", "ramat gan", "ramat-gan"],
    needle: /רמת\s*גן|ramat\s*gan/i,
    focus: { lng: 34.82, lat: 32.08 },
  },
  {
    nameHe: "באר שבע",
    keys: ["באר שבע", "beer sheva", "be'er sheva", "beersheba"],
    needle: /באר\s*שבע|beer\s*sheva|beersheba/i,
    focus: { lng: 34.79, lat: 31.25 },
  },
  {
    nameHe: "נתניה",
    keys: ["נתניה", "netanya"],
    needle: /נתניה|netanya/i,
    focus: { lng: 34.86, lat: 32.33 },
  },
  {
    nameHe: "ראשון לציון",
    keys: ["ראשון לציון", "ראשון-לציון", "rishon lezion", "rishon leziyyon", "rishon"],
    needle: /ראשון[\s\-]?לציון|rishon/i,
    focus: { lng: 34.79, lat: 31.96 },
  },
  {
    nameHe: "פתח תקווה",
    keys: ["פתח תקווה", "פתח-תקווה", "petah tikva", "petah tiqwa", "petach tikva"],
    needle: /פתח\s*תקווה|petah\s*tikva|petach\s*tikva/i,
    focus: { lng: 34.89, lat: 32.09 },
  },
  {
    nameHe: "חולון",
    keys: ["חולון", "holon"],
    needle: /חולון|holon/i,
    focus: { lng: 34.77, lat: 32.02 },
  },
  {
    nameHe: "בת ים",
    keys: ["בת ים", "bat yam"],
    needle: /בת\s*ים|bat\s*yam/i,
    focus: { lng: 34.75, lat: 32.02 },
  },
  {
    nameHe: "הרצליה",
    keys: ["הרצליה", "herzliya", "herzliyya"],
    needle: /הרצליה|herzliya/i,
    focus: { lng: 34.84, lat: 32.16 },
  },
  {
    nameHe: "רעננה",
    keys: ["רעננה", "raanana", "ra'anana"],
    needle: /רעננה|ra'?anana/i,
    focus: { lng: 34.87, lat: 32.18 },
  },
  {
    nameHe: "כפר סבא",
    keys: ["כפר סבא", "kfar saba", "kefar sava"],
    needle: /כפר\s*סבא|kfar\s*saba|kefar\s*sava/i,
    focus: { lng: 34.91, lat: 32.17 },
  },
  {
    nameHe: "רחובות",
    keys: ["רחובות", "rehovot"],
    needle: /רחובות|rehovot/i,
    focus: { lng: 34.81, lat: 31.89 },
  },
  {
    nameHe: "אשדוד",
    keys: ["אשדוד", "ashdod"],
    needle: /אשדוד|ashdod/i,
    focus: { lng: 34.65, lat: 31.8 },
  },
  {
    nameHe: "אשקלון",
    keys: ["אשקלון", "ashkelon"],
    needle: /אשקלון|ashkelon/i,
    focus: { lng: 34.57, lat: 31.67 },
  },
  {
    nameHe: "מודיעין",
    keys: ["מודיעין מכבים רעות", "מודיעין", "modiin", "modi'in"],
    needle: /מודיעין|modi'?in/i,
    focus: { lng: 35.01, lat: 31.9 },
  },
  {
    nameHe: "נס ציונה",
    keys: ["נס ציונה", "ness ziona"],
    needle: /נס\s*ציונה|ness\s*ziona/i,
    focus: { lng: 34.8, lat: 31.93 },
  },
  {
    nameHe: "לוד",
    keys: ["לוד", "lod"],
    needle: /(?:^|[\s,])לוד(?:$|[\s,])|\blod\b/i,
    focus: { lng: 34.89, lat: 31.95 },
  },
  {
    nameHe: "רמלה",
    keys: ["רמלה", "ramla"],
    needle: /רמלה|ramla/i,
    focus: { lng: 34.87, lat: 31.93 },
  },
  {
    nameHe: "הוד השרון",
    keys: ["הוד השרון", "hod hasharon"],
    needle: /הוד\s*השרון|hod\s*hasharon/i,
    focus: { lng: 34.89, lat: 32.15 },
  },
  {
    nameHe: "כפר יונה",
    keys: ["כפר יונה", "kfar yona"],
    needle: /כפר\s*יונה|kfar\s*yona/i,
    focus: { lng: 34.94, lat: 32.32 },
  },
];

const STREET_PREFIX_RE =
  /^(?:רחוב|רח׳|רח'|רח\.|שדרות|שד׳|שד'|שד\.|דרך|כיכר|סמטת|סמטה|משעול|מעלה|מבוא)\s+/i;

const HOUSE_NUMBER_RE = /(?:^|[\s,/\-])(\d{1,4}[א-תa-z]?)(?=$|[\s,/\-])/gi;

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—―־]/g, "-")
    .replace(/[׳'’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractHouseNumber(query: string): string | null {
  const matches = [...normalizeText(query).matchAll(HOUSE_NUMBER_RE)];
  if (!matches.length) return null;
  return matches[matches.length - 1]?.[1] ?? null;
}

export function normalizeHouseNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{1,4})([א-תa-z]?)/i);
  if (!m) return null;
  const letter = (m[2] ?? "").toLowerCase();
  return `${m[1]}${letter}`;
}

function findCity(query: string): { city: CityAlias; start: number; end: number } | null {
  const q = normalizeText(query).toLowerCase();
  let best: { city: CityAlias; start: number; end: number; keyLen: number } | null = null;
  for (const city of CITY_ALIASES) {
    for (const key of city.keys) {
      const k = key.toLowerCase();
      const idx = q.indexOf(k);
      if (idx < 0) continue;
      const keyLen = k.length;
      if (!best || keyLen > best.keyLen || (keyLen === best.keyLen && idx > best.start)) {
        best = { city, start: idx, end: idx + keyLen, keyLen };
      }
    }
  }
  return best ? { city: best.city, start: best.start, end: best.end } : null;
}

function stripStreetPrefix(street: string): string {
  let s = street.trim();
  // Apply twice for "רחוב שדרות X"
  for (let i = 0; i < 2; i++) {
    const next = s.replace(STREET_PREFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

function tokenizeStreet(street: string): string[] {
  return street
    .toLowerCase()
    .split(/[\s,/]+/)
    .map((t) => t.replace(/^[-]+|[-]+$/g, ""))
    .filter((t) => t.length >= 2)
    .filter((t) => !/^\d+[א-תa-z]?$/i.test(t));
}

/**
 * Parse a free-text Israeli address into street / house number / city.
 * Conservative: prefers longest city key; house number is the last standalone number token.
 */
export function parseAddressQuery(query: string): ParsedAddress {
  const raw = query.trim();
  let normalized = normalizeText(raw);
  const cityHit = findCity(normalized);
  let city: CityAlias | null = null;
  let working = normalized;

  if (cityHit) {
    city = cityHit.city;
    working = normalizeText(`${working.slice(0, cityHit.start)} ${working.slice(cityHit.end)}`);
  }

  const housenumber = extractHouseNumber(working);
  if (housenumber) {
    const matches = [...working.matchAll(new RegExp(HOUSE_NUMBER_RE.source, "gi"))];
    const last = matches[matches.length - 1];
    if (last && last.index != null && last[1]) {
      const num = last[1];
      const numOffset = last[0].lastIndexOf(num);
      const absStart = last.index + Math.max(0, numOffset);
      working = normalizeText(`${working.slice(0, absStart)} ${working.slice(absStart + num.length)}`);
    }
  }

  working = working.replace(/^[,/\-]+|[,/\-]+$/g, "").trim();
  const street = stripStreetPrefix(working) || null;

  return {
    raw,
    normalized,
    street: street && street.length >= 2 ? street : null,
    housenumber,
    city,
    streetTokens: street ? tokenizeStreet(street) : [],
  };
}

/** Build alternative free-text queries that geocoders often handle better. */
export function buildQueryVariants(parsed: ParsedAddress): string[] {
  const variants: string[] = [];
  const push = (q: string | null | undefined) => {
    const t = q ? normalizeText(q) : "";
    if (!t || t.length < 2) return;
    if (!variants.some((v) => v.toLowerCase() === t.toLowerCase())) variants.push(t);
  };

  push(parsed.raw);
  push(parsed.normalized);

  const { street, housenumber, city } = parsed;
  if (street && housenumber && city) {
    push(`${street} ${housenumber} ${city.nameHe}`);
    push(`${street} ${housenumber}, ${city.nameHe}`);
    push(`${housenumber} ${street}, ${city.nameHe}`);
  } else if (street && city) {
    push(`${street}, ${city.nameHe}`);
    push(`${street} ${city.nameHe}`);
  } else if (street && housenumber) {
    push(`${street} ${housenumber}`);
    push(`${housenumber} ${street}`);
  } else if (street) {
    push(street);
  } else if (city) {
    push(city.nameHe);
  }

  return variants.slice(0, 4);
}

export function placeMatchesCity(
  place: { city?: string; label: string },
  city: CityAlias,
): boolean {
  return city.needle.test(`${place.city ?? ""} ${place.label}`);
}

/**
 * True when `needle` appears as a whole token (or multi-token phrase) in `haystack`.
 * Avoids substring false positives (יפו ⊂ יפת).
 */
export function tokenPhraseMatch(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack).toLowerCase();
  const n = normalizeText(needle).toLowerCase();
  if (!n) return false;
  if (h === n) return true;
  // Escape regex special chars in needle tokens.
  const parts = n.split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${parts.join("[\\s\\-]+")}(?:$|[^\\p{L}\\p{N}])`, "iu");
  return re.test(h);
}

export function streetMatchScore(
  placeStreet: string | undefined,
  placeLabel: string,
  parsed: ParsedAddress,
): number {
  if (!parsed.streetTokens.length) return 0;
  const streetBlob = placeStreet ?? "";
  const labelBlob = placeLabel;

  let streetHits = 0;
  let labelHits = 0;
  for (const token of parsed.streetTokens) {
    if (tokenPhraseMatch(streetBlob, token)) streetHits += 1;
    else if (tokenPhraseMatch(labelBlob, token)) labelHits += 1;
  }

  if (streetHits === parsed.streetTokens.length) {
    if (placeStreet && parsed.street && tokenPhraseMatch(placeStreet, parsed.street)) return 3;
    return 2;
  }
  // Label-only hits (junctions / POI names) are weaker than real street field matches.
  if (streetHits + labelHits === parsed.streetTokens.length && streetHits > 0) return 2;
  if (streetHits + labelHits === parsed.streetTokens.length) return 1;
  if (streetHits + labelHits > 0) return 1;
  return 0;
}
