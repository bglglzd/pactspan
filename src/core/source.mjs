import { fields, identifier, integer, jsonData, list, object, requireValue, sha256, text, instant, zone } from './data.mjs';

export async function makeSource(document) {
  jsonData(document);
  fields(document, ['id', 'title', 'meeting_at', 'time_zone', 'participants', 'segments', 'original'], 'source');
  if ('id' in document) identifier(document.id, 'source.id');
  const participants = list(document.participants ?? [], 'source.participants', 32).map((row, index) => {
    fields(row, ['speaker', 'person_id'], `source.participants[${index}]`);
    return { speaker: text(row.speaker, `participant[${index}].speaker`, 80),
      person_id: identifier(row.person_id ?? null, `participant[${index}].person_id`, { nullable: true }) };
  });
  requireValue(new Set(participants.map(row => row.speaker)).size === participants.length, 'source.participants contains duplicate speaker labels');
  const segments = list(document.segments, 'source.segments', 256).map((row, index) => {
    fields(row, ['speaker', 'start_secs', 'end_secs', 'text'], `source.segments[${index}]`);
    requireValue(typeof row.start_secs === 'number' && typeof row.end_secs === 'number'
      && Number.isFinite(row.start_secs) && Number.isFinite(row.end_secs)
      && row.start_secs >= 0 && row.end_secs >= row.start_secs && row.end_secs <= 86400,
    `source.segments[${index}] requires ordered timestamps within one day`);
    return { speaker: text(row.speaker, `segment[${index}].speaker`, 80),
      start_secs: row.start_secs, end_secs: row.end_secs,
      text: text(row.text, `segment[${index}].text`, 8000) };
  });
  requireValue(segments.length > 0, 'source.segments must not be empty');
  let original = null;
  if (document.original != null) {
    fields(document.original, ['format', 'text'], 'source.original');
    requireValue(['json', 'txt'].includes(document.original.format), 'source.original.format must be json or txt');
    original = { format: document.original.format, text: text(document.original.text, 'source.original.text', 262_144) };
    requireValue(new TextEncoder().encode(original.text).length <= 256 * 1024, 'Original transcript exceeds 256 KiB');
  }
  const content = { title: text(document.title ?? 'Imported transcript', 'source.title', 160),
    meeting_at: document.meeting_at == null ? null : instant(document.meeting_at, 'source.meeting_at'),
    time_zone: zone(document.time_zone ?? null, 'source.time_zone', { nullable: true }), participants, segments, original };
  requireValue(new TextEncoder().encode(JSON.stringify(content)).length <= 512 * 1024, 'Parsed source exceeds 512 KiB');
  return { id: 'src_' + await sha256(content), ...content };
}

export function citation(source, raw) {
  fields(raw, ['source', 'segment', 'quote', 'start', 'end'], 'citation');
  identifier(raw.source, 'citation.source');
  integer(raw.segment, 'citation.segment', 0, 255);
  const quote = text(raw.quote, 'citation.quote', 2000);
  const segment = source?.segments[raw.segment];
  if (!source || raw.source !== source.id || !segment) return { ...structuredClone(raw), supported: false, reason: 'Unknown source or segment' };
  let start = raw.start;
  let end = raw.end;
  if (start == null && end == null) {
    start = segment.text.indexOf(quote);
    if (start < 0 || start !== segment.text.lastIndexOf(quote)) {
      return { ...structuredClone(raw), supported: false, reason: 'Quote is absent or ambiguous; exact offsets are required' };
    }
    end = start + quote.length;
  } else {
    integer(start, 'citation.start', 0, segment.text.length);
    integer(end, 'citation.end', start, segment.text.length);
  }
  if (segment.text.slice(start, end) !== quote) return { ...structuredClone(raw), supported: false, reason: 'Quote differs from the exact source span' };
  const participant = source.participants.find(row => row.speaker === segment.speaker);
  return { source: source.id, segment: raw.segment, quote, start, end, speaker: segment.speaker,
    person_id: participant?.person_id ?? null, supported: true };
}

export function importedDocument(input, metadata = {}) {
  object(metadata, 'import metadata');
  fields(metadata, ['title', 'meeting_at', 'time_zone', 'participants'], 'import metadata');
  if (typeof input !== 'string') return { ...structuredClone(input), ...structuredClone(metadata) };
  text(input, 'transcript', 262_144);
  requireValue(new TextEncoder().encode(input).length <= 256 * 1024, 'Original transcript exceeds 256 KiB');
  let parsed;
  try { parsed = JSON.parse(input); } catch { /* Timestamped TXT is a separate supported input. */ }
  if (parsed !== undefined) {
    object(parsed, 'transcript JSON');
    return { ...parsed, ...structuredClone(metadata), original: { format: 'json', text: input } };
  }
  const segments = [];
  for (const line of input.split(/\r?\n/)) {
    const match = line.match(/^\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]\s+([^:]{1,80}):\s?(.*)$/);
    if (match) {
      const hours = match[3] === undefined ? 0 : Number(match[1]);
      const minutes = match[3] === undefined ? Number(match[1]) : Number(match[2]);
      const seconds = Number(match[3] ?? match[2]);
      requireValue(seconds < 60 && (match[3] === undefined || minutes < 60), 'TXT timestamp has invalid minutes/seconds');
      const start = hours * 3600 + minutes * 60 + seconds;
      segments.push({ speaker: match[4], start_secs: start, end_secs: start, text: match[5] });
    } else if (segments.length && line.trim()) {
      segments.at(-1).text += '\n' + line;
    }
  }
  requireValue(segments.length > 0, 'TXT transcript requires [m:ss] Speaker: text segments');
  return { ...structuredClone(metadata), segments, original: { format: 'txt', text: input } };
}
