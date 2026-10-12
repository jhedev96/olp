/** Client identity for display (never a security signal). */
export interface ParsedAgent {
  browser: string;
  os: string;
}

/** `Unknown` fallback (empty input, garbage, unrecognized brands). */
const UNKNOWN: ParsedAgent = { browser: 'Unknown', os: 'Unknown' };

/** First dotted version run in `text`, or `null`. */
function versionAfter(text: string): string | null {
  const match = text.match(/\d+(\.\d+){0,3}/);
  return match === null ? null : match[0];
}

function label(base: string, version: string | null, mobile: boolean): string {
  const name = version === null ? base : `${base} ${version}`;
  return mobile ? `${name} Mobile` : name;
}

/**
 * Parse a User-Agent into display strings for the sessions table.
 * Ordered brand table (Edge/Opera UAs embed Chrome, so they match
 * first); OS prefers mobile tokens over desktop ones. Pure, total
 * (never throws), and never returns the raw UA — unrecognized input
 * answers `Unknown`.
 */
export function parseUserAgent(ua: string): ParsedAgent {
  if (typeof ua !== 'string' || ua === '') return { ...UNKNOWN };
  const mobile = ua.includes('Mobile') || ua.includes('Android') || ua.includes('iPhone') || ua.includes('iPad');

  let browser = 'Unknown';
  const edge = ua.match(/Edg(?:e|A|iOS)?\/([^\s;]+)/);
  const opera = ua.match(/(?:OPR|Opera)\/([^\s;]+)/);
  const firefox = ua.match(/(?:FxiOS|Firefox)\/([^\s;]+)/);
  const chrome = ua.match(/(?:CriOS|Chrome)\/([^\s;]+)/);
  const safari = ua.match(/Version\/([^\s;]+).*Safari\//);
  if (edge !== null) browser = label('Edge', versionAfter(edge[1] ?? ''), false);
  else if (opera !== null) browser = label('Opera', versionAfter(opera[1] ?? ''), false);
  else if (firefox !== null) browser = label('Firefox', versionAfter(firefox[1] ?? ''), mobile);
  else if (chrome !== null) browser = label('Chrome', versionAfter(chrome[1] ?? ''), mobile);
  else if (safari !== null) browser = label('Safari', versionAfter(safari[1] ?? ''), mobile);

  let os = 'Unknown';
  const android = ua.match(/Android\s+([0-9.]+)/);
  const ios = ua.match(/OS\s+([0-9_]+)\s+like Mac OS X/);
  const macos = ua.match(/Mac OS X\s+([0-9_]+)/);
  const windows = ua.match(/Windows NT\s+([0-9.]+)/);
  if (android !== null) os = `Android ${android[1] ?? ''}`.trim();
  else if (ios !== null || ua.includes('iPhone') || ua.includes('iPad')) {
    os = ios?.[1] !== undefined ? `iOS ${ios[1].replace(/_/g, '.')}` : 'iOS';
  } else if (macos !== null) os = `macOS ${macos[1]?.replace(/_/g, '.') ?? ''}`.trim();
  else if (windows !== null) os = `Windows ${windows[1] ?? ''}`.trim();
  else if (ua.includes('Linux') || ua.includes('X11')) os = 'Linux';

  return { browser, os };
}
