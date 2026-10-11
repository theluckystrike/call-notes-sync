// Pure logic of Call Notes Sync: Fathom REST answers to one common Meeting, Meeting to Markdown,
// file names, dedupe keys, cursor, filters and daily note links. No Obsidian import and no network call here, so every rule has
// a golden vector (packages/spec/vectors/call-notes-sync.json). Written from the public Fathom API reference
// (raw copies in research/obsidian-run/raw/b5 and raw/c2). Unofficial: not made by Fathom.

/** The one service the plugin reads. A note records it in the front matter as meeting_source. */
export type Provider = 'fathom';

export const PROVIDER_LABEL: Record<Provider, string> = { fathom: 'Fathom' };
export const DEFAULT_FOLDER = 'Meetings';
export const DEFAULT_TEMPLATE = '{date} {title}';
export const DEFAULT_BODY = '{{header}}\n\n## Summary\n\n{{summary}}\n\n## Action items\n\n{{actions}}\n{{transcript}}';
export const DEFAULT_DAILY_FORMAT = 'YYYY-MM-DD';
export const DEFAULT_DAILY_HEADING = '## Meetings';
export const MAX_NAME = 100;
/** A sync starts this long before the newest meeting that it saw. A recording that finishes late still comes in. */
export const CURSOR_OVERLAP_MS = 48 * 60 * 60 * 1000;
/** A meeting younger than this with no summary is "not ready": the service is still working on it. */
export const READY_AFTER_MS = 48 * 60 * 60 * 1000;
export const MAX_TRANSCRIPT_LINES = 20_000;

export interface Person {
	name: string;
	email: string;
}
export interface ActionItem {
	text: string;
	done: boolean;
	assignee: string;
}
export interface TranscriptLine {
	speaker: string;
	/** Seconds from the start of the meeting, or null when the service gave none. */
	at: number | null;
	text: string;
}
export interface Meeting {
	provider: Provider;
	id: string;
	title: string;
	/** UTC, to the second: 2026-10-08T09:00:00Z. */
	date: string;
	durationMin: number | null;
	participants: Person[];
	summary: string;
	actionItems: ActionItem[];
	/** Link back to the meeting on the service. Empty when the service gave none. */
	url: string;
	/** Null when the transcript was not asked for (free) or the service has none. */
	transcript: TranscriptLine[] | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A link that is safe to put in a note: https, no spaces, no angle brackets or parentheses. Empty otherwise. */
export function safeUrl(raw: unknown): string {
	const u = str(raw).trim();
	return /^https:\/\/[^\s<>()]+$/.test(u) ? u : '';
}

/** Time to a UTC ISO text without fractions: 2026-10-08T09:00:00Z. Accepts ISO text or epoch milliseconds. Empty when invalid. */
export function isoStamp(v: unknown): string {
	const t = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? (/^\d{12,}$/.test(v.trim()) ? Number(v.trim()) : Date.parse(v)) : NaN;
	if (!Number.isFinite(t) || t < 0 || t > 4_102_444_800_000) return '';
	return `${new Date(t).toISOString().slice(0, 19)}Z`;
}

// ---------------------------------------------------------------- people

function personKey(p: Person): string {
	return (p.email !== '' ? p.email : p.name).toLowerCase();
}

/** People without duplicates (by email, else by name), in order of first use. A name fills a gap in an earlier row of one email. */
export function mergePeople(people: Person[]): Person[] {
	const out: Person[] = [];
	for (const p of people) {
		if (p.name === '' && p.email === '') continue;
		const key = personKey(p);
		const have = out.find((o) => personKey(o) === key);
		if (!have) out.push({ ...p });
		else if (have.name === '' && p.name !== '') have.name = p.name;
	}
	return out;
}

/** The text of a person in a note: the name, or the email when there is no name. */
export const personLabel = (p: Person): string => (p.name !== '' ? p.name : p.email);

// ---------------------------------------------------------------- Fathom

/** "00:05:32" to seconds. Null for any other text. */
export function parseClock(v: unknown): number | null {
	const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(str(v).trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(str(v).trim());
	if (!m) return null;
	const parts = m.slice(1).map(Number);
	return parts.length === 3 ? (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) : (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

function fathomPeople(raw: Obj): Person[] {
	const people: Person[] = [];
	const by = raw.recorded_by;
	if (isObj(by)) people.push({ name: oneLine(str(by.name)), email: str(by.email).trim().toLowerCase() });
	for (const i of list(raw.calendar_invitees)) {
		if (isObj(i)) people.push({ name: oneLine(str(i.name)), email: str(i.email).trim().toLowerCase() });
	}
	return mergePeople(people);
}

function fathomActions(raw: unknown): ActionItem[] {
	const out: ActionItem[] = [];
	for (const a of list(raw)) {
		if (!isObj(a)) continue;
		const text = oneLine(str(a.description));
		const who = isObj(a.assignee) ? oneLine(str(a.assignee.name)) : '';
		if (text !== '') out.push({ text, done: a.completed === true, assignee: who });
	}
	return out;
}

function fathomLines(raw: unknown): TranscriptLine[] | null {
	if (!Array.isArray(raw)) return null;
	const out: TranscriptLine[] = [];
	for (const l of (raw as unknown[]).slice(0, MAX_TRANSCRIPT_LINES)) {
		if (!isObj(l)) continue;
		const text = oneLine(str(l.text));
		if (text === '') continue;
		out.push({ speaker: isObj(l.speaker) ? oneLine(str(l.speaker.display_name)) : '', at: parseClock(l.timestamp), text });
	}
	return out.length > 0 ? out : null;
}

/** One Fathom meeting row as a Meeting, or null for a row without a recording id or a date. */
export function parseFathom(raw: unknown): Meeting | null {
	if (!isObj(raw)) return null;
	const id = typeof raw.recording_id === 'number' && Number.isInteger(raw.recording_id) ? String(raw.recording_id) : str(raw.recording_id);
	const start = isoStamp(raw.recording_start_time) || isoStamp(raw.scheduled_start_time) || isoStamp(raw.created_at);
	if (!ID.test(id) || start === '') return null;
	const end = isoStamp(raw.recording_end_time);
	const mins = end === '' ? NaN : (Date.parse(end) - Date.parse(start)) / 60_000;
	const sum = isObj(raw.default_summary) ? str(raw.default_summary.markdown_formatted) : '';
	return {
		provider: 'fathom',
		id,
		title: oneLine(str(raw.meeting_title) || str(raw.title)) || 'Untitled meeting',
		date: start,
		durationMin: Number.isFinite(mins) && mins > 0 ? Math.round(mins) : null,
		participants: fathomPeople(raw),
		summary: sum.trim(),
		actionItems: fathomActions(raw.action_items),
		url: safeUrl(raw.url) || safeUrl(raw.share_url),
		transcript: fathomLines(raw.transcript),
	};
}

/** Dedupe key of a meeting in the sync state and in the front matter. */
export const meetingKey = (m: { provider: Provider; id: string }): string => `${m.provider}:${m.id}`;

/** False for a young meeting that has no summary and no action item yet: the service is still working on it. */
export function isReady(m: Meeting, nowMs: number): boolean {
	if (m.summary !== '' || m.actionItems.length > 0) return true;
	return nowMs - Date.parse(m.date) > READY_AFTER_MS;
}

// ---------------------------------------------------------------- dates, names

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const p2 = (n: number): string => String(n).padStart(2, '0');

/** The meeting time moved by tzMin minutes (local time = UTC + tzMin), as a Date whose UTC fields are the local fields. */
function shifted(iso: string, tzMin: number): Date {
	return new Date(Date.parse(iso) + tzMin * 60_000);
}

/** Local date of a meeting as YYYY-MM-DD. */
export function localDate(iso: string, tzMin: number): string {
	const t = Date.parse(iso);
	return Number.isFinite(t) ? shifted(iso, tzMin).toISOString().slice(0, 10) : '';
}

/** Local time of a meeting as HH:mm. */
export function localTime(iso: string, tzMin: number): string {
	const t = Date.parse(iso);
	return Number.isFinite(t) ? shifted(iso, tzMin).toISOString().slice(11, 16) : '';
}

/**
 * A small subset of the Moment.js date format, enough for daily note names: YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd, ddd and
 * text in [brackets]. Any other letter stays as it is.
 */
export function formatDate(iso: string, format: string, tzMin: number): string {
	if (!Number.isFinite(Date.parse(iso))) return '';
	const d = shifted(iso, tzMin);
	const y = d.getUTCFullYear();
	const tokens: Record<string, string> = {
		YYYY: String(y),
		YY: String(y % 100).padStart(2, '0'),
		MMMM: MONTHS[d.getUTCMonth()] ?? '',
		MMM: (MONTHS[d.getUTCMonth()] ?? '').slice(0, 3),
		MM: p2(d.getUTCMonth() + 1),
		M: String(d.getUTCMonth() + 1),
		DD: p2(d.getUTCDate()),
		D: String(d.getUTCDate()),
		dddd: DAYS[d.getUTCDay()] ?? '',
		ddd: (DAYS[d.getUTCDay()] ?? '').slice(0, 3),
	};
	return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd/g, (m: string, lit: string | undefined) => (lit !== undefined ? lit : (tokens[m] ?? m)));
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** A file name that is safe on desktop and phone and cannot break a link: no path characters, no # ^ [ ], no reserved names. */
export function sanitizeFileName(raw: string, max: number = MAX_NAME): string {
	let s = Array.from(raw.normalize('NFC'), (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('');
	s = s.replace(/[:|]/g, ' - ').replace(/[\\/*?"<>#^[\]]/g, ' ');
	s = s.replace(/\s+/g, ' ').replace(/ -(?: -)+ /g, ' - ');
	s = s.replace(/^(?:\s*-\s+)+|(?:\s+-\s*)+$/g, '').replace(/^[\s.]+|[\s.]+$/g, '');
	s = Array.from(s).slice(0, Math.max(1, max)).join('').replace(/[\s.]+$/g, '');
	if (s === '') return 'Untitled';
	return RESERVED.test(s) ? `_${s}` : s;
}

/** FNV-1a of the meeting key as 8 hex digits: the {id} of a file name template. */
export function shortHash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/** File name (without folder and extension) from the tokens {title}, {date}, {time}, {source} and {id}. */
export function renderFileName(template: string, m: Meeting, tzMin: number, max: number = MAX_NAME): string {
	const tokens: Record<string, string> = {
		title: m.title,
		date: localDate(m.date, tzMin),
		time: localTime(m.date, tzMin).replace(':', '.'),
		source: PROVIDER_LABEL[m.provider],
		id: shortHash(meetingKey(m)),
	};
	return sanitizeFileName(template.replace(/\{([a-z]+)\}/g, (_x, name: string) => tokens[name] ?? ''), max);
}

/** The first of base, "base (2)", "base (3)" and so on that is not taken. Stops at 999 and then adds the hash. */
export function uniqueName(base: string, isTaken: (name: string) => boolean, hash: string): string {
	if (!isTaken(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const name = `${base} (${n})`;
		if (!isTaken(name)) return name;
	}
	return `${base} ${hash}`;
}

/** Folder path with no leading or trailing slash, no "." or ".." part and no character that a folder name cannot hold. */
export function normalizeFolder(raw: string): string {
	return raw
		.replace(/\\/g, '/')
		.split('/')
		.map((p) => p.replace(/[:*?"<>|#^[\]]/g, '').trim())
		.filter((p) => p !== '' && p !== '.' && p !== '..')
		.join('/');
}

export function normalizeTemplate(raw: string): string {
	const t = raw.trim().slice(0, 120);
	return t === '' ? DEFAULT_TEMPLATE : t;
}

// ---------------------------------------------------------------- Markdown

const q = (s: string): string => JSON.stringify(oneLine(s));

/** Front matter of a note. The key line is what dedupe uses when the sync state is lost. */
export function renderFrontmatter(m: Meeting): string {
	const people = m.participants.map(personLabel);
	const lines = ['---', `meeting_source: ${m.provider}`, `meeting_id: ${q(m.id)}`, `title: ${q(m.title)}`, `date: ${m.date}`];
	if (m.durationMin !== null) lines.push(`duration_minutes: ${m.durationMin}`);
	lines.push(...(people.length === 0 ? ['participants: []'] : ['participants:', ...people.map((p) => `  - ${q(p)}`)]));
	if (m.url !== '') lines.push(`url: ${q(m.url)}`);
	lines.push('---', '');
	return lines.join('\n');
}

/** Headings of service text are moved down so that the highest one is level 3. The note keeps one level 1 and its own level 2 headings. */
export function demoteHeadings(md: string): string {
	const lines = md.split('\n');
	const levels: (number | null)[] = [];
	let fence = false;
	for (const line of lines) {
		if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
		const m = fence ? null : /^(#{1,6})\s+\S/.exec(line);
		levels.push(m ? (m[1] ?? '').length : null);
	}
	const found = levels.filter((l): l is number => l !== null);
	const shift = found.length === 0 ? 0 : Math.max(0, 3 - Math.min(...found));
	if (shift === 0) return md;
	return lines.map((line, i) => (levels[i] === null ? line : `${'#'.repeat(Math.min(6, (levels[i] ?? 1) + shift))}${line.replace(/^#+/, '')}`)).join('\n');
}

/** Comment markers in service text would hide text in the note. */
const noComment = (s: string): string => s.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');

export function renderSummary(m: Meeting): string {
	return m.summary === '' ? '_No summary was available when this note was made._' : demoteHeadings(noComment(m.summary)).trim();
}

/** Action items as tasks. An assignee goes in brackets after the text. */
export function renderActions(items: ActionItem[]): string {
	if (items.length === 0) return '_No action items._';
	return items.map((a) => `- [${a.done ? 'x' : ' '}] ${noComment(a.text)}${a.assignee !== '' ? ` (${a.assignee})` : ''}`).join('\n');
}

/** "m:ss" or "h:mm:ss". */
export function clock(sec: number): string {
	const h = Math.floor(sec / 3600);
	const mm = Math.floor((sec % 3600) / 60);
	const ss = sec % 60;
	return h > 0 ? `${h}:${p2(mm)}:${p2(ss)}` : `${mm}:${p2(ss)}`;
}

/** The transcript with speaker labels. Neighbour lines of one speaker are one paragraph that starts at the first time. */
export function renderTranscript(lines: TranscriptLine[]): string {
	const out: string[] = [];
	let last: { speaker: string; idx: number } | null = null;
	for (const l of lines) {
		const text = noComment(l.text);
		if (last !== null && last.speaker === l.speaker) {
			out[last.idx] = `${out[last.idx] ?? ''} ${text}`;
			continue;
		}
		const who = l.speaker === '' ? 'Unknown speaker' : l.speaker;
		out.push(`**${who}**${l.at === null ? '' : ` (${clock(l.at)})`}: ${text}`);
		last = { speaker: l.speaker, idx: out.length - 1 };
	}
	return out.join('\n\n');
}

/** Date, length, source and the link back. */
export function renderHeader(m: Meeting, tzMin: number): string {
	const label = PROVIDER_LABEL[m.provider];
	const when = `${localDate(m.date, tzMin)} ${localTime(m.date, tzMin)}`;
	const dur = m.durationMin === null ? '' : `, ${m.durationMin} min`;
	const people = m.participants.map(personLabel);
	const lines = [`**When:** ${when}${dur}`];
	if (people.length > 0) lines.push(`**Participants:** ${people.join(', ')}`);
	lines.push(m.url === '' ? `**Source:** ${label}` : `**Source:** [Open in ${label}](${m.url})`);
	return lines.join('  \n');
}

export interface RenderOptions {
	tzMin: number;
	/** Pro: the transcript is part of the note. */
	transcript: boolean;
	/** Pro: the body template. Empty or free: DEFAULT_BODY. */
	body: string;
}

/** The tokens of a body template: {{header}}, {{summary}}, {{actions}}, {{transcript}}, {{title}}, {{date}}, {{time}}, {{duration}}, {{participants}}, {{link}}, {{source}}, {{id}}. */
export function renderBody(m: Meeting, o: RenderOptions): string {
	const showT = o.transcript && m.transcript !== null;
	const tText = showT ? renderTranscript(m.transcript ?? []) : '';
	const t: Record<string, string> = {
		header: renderHeader(m, o.tzMin),
		summary: renderSummary(m),
		actions: renderActions(m.actionItems),
		transcript: tText === '' ? '' : `\n## Transcript\n\n${tText}\n`,
		title: m.title,
		date: localDate(m.date, o.tzMin),
		time: localTime(m.date, o.tzMin),
		duration: m.durationMin === null ? '' : String(m.durationMin),
		participants: m.participants.map(personLabel).join(', '),
		link: m.url,
		source: PROVIDER_LABEL[m.provider],
		id: m.id,
	};
	const tpl = o.body.trim() === '' ? DEFAULT_BODY : o.body;
	const text = tpl.replace(/\{\{([a-z]+)\}\}/g, (_x, name: string) => t[name] ?? '');
	return `${text.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Text of a new note: front matter, a title line and the body. */
export function renderNote(m: Meeting, o: RenderOptions): string {
	return `${renderFrontmatter(m)}\n# ${oneLine(m.title)}\n\n${renderBody(m, o)}`;
}

// ---------------------------------------------------------------- filters (Pro)

export interface Filters {
	/** YYYY-MM-DD, local date, inclusive. Empty: no limit. */
	from: string;
	to: string;
	/** Comma separated names or emails. A meeting passes when one participant contains one of them. Empty: no filter. */
	participants: string;
}

export const NO_FILTERS: Filters = { from: '', to: '', participants: '' };

export function normalizeDay(raw: string): string {
	const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(raw);
	if (!m) return '';
	const t = Date.parse(`${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}T00:00:00Z`);
	return Number.isFinite(t) && new Date(t).toISOString().startsWith(`${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}`) ? `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}` : '';
}

export const filterTerms = (raw: string): string[] =>
	raw
		.split(/[,;\n]/)
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s !== '');

/** True when the meeting passes the date range and the participant filter. */
export function passesFilters(m: Meeting, f: Filters, tzMin: number): boolean {
	const day = localDate(m.date, tzMin);
	if (f.from !== '' && day < f.from) return false;
	if (f.to !== '' && day > f.to) return false;
	const terms = filterTerms(f.participants);
	if (terms.length === 0) return true;
	return m.participants.some((p) => terms.some((t) => p.name.toLowerCase().includes(t) || p.email.includes(t)));
}

// ---------------------------------------------------------------- cursor

export interface Cursor {
	/** Newest meeting time that a finished sync saw. A sync starts a little before it. */
	since: string | null;
	/** Set when a run stopped at its limit: the next run asks for meetings before this time. */
	until: string | null;
	/** Newest meeting time seen while a limited run is not finished. */
	high: string | null;
}

export const EMPTY_CURSOR: Cursor = { since: null, until: null, high: null };

const maxIso = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

/** Start of the next request window: the cursor moved back by the overlap. */
export function windowFrom(c: Cursor, overlapMs: number = CURSOR_OVERLAP_MS): string | null {
	if (c.since === null) return null;
	const t = Date.parse(c.since);
	return Number.isFinite(t) ? isoStamp(t - overlapMs) : null;
}

/**
 * The cursor after one run. dates are the meeting times in the order the service sent them. When the run was not stopped by its
 * limit, the window is complete: since moves to the newest time seen. When it was stopped, a newest-first answer continues
 * before the oldest time seen (until), and an oldest-first answer continues after the newest (since).
 */
export function nextCursor(prev: Cursor, dates: string[], capped: boolean): Cursor {
	const valid = dates.filter((d) => d !== '');
	const newest = valid.reduce<string | null>((m, d) => maxIso(m, d), null);
	const oldest = valid.reduce<string | null>((m, d) => (m === null || d < m ? d : m), null);
	if (!capped) return { since: maxIso(maxIso(prev.since, prev.high), newest), until: null, high: null };
	if (newest === null || oldest === null) return { ...prev };
	const first = valid[0] ?? '';
	const last = valid[valid.length - 1] ?? '';
	if (first <= last && valid.length > 1) return { since: maxIso(prev.since, newest), until: null, high: null };
	return { since: prev.since, until: oldest, high: maxIso(prev.high, newest) };
}

// ---------------------------------------------------------------- daily note (Pro)

/** Path of the daily note of a meeting, or "" when the folder or format gives nothing. */
export function dailyNotePath(m: Meeting, folder: string, format: string, tzMin: number): string {
	const name = sanitizeFileName(formatDate(m.date, format === '' ? DEFAULT_DAILY_FORMAT : format, tzMin).replace(/\//g, '-'));
	const f = normalizeFolder(folder);
	return `${f === '' ? '' : `${f}/`}${name}.md`;
}

/** Adds one line to the end of the section under heading, or a new section at the end. The same line is never added twice. */
export function addLinkUnderHeading(text: string, heading: string, line: string): string {
	if (text.split(/\r?\n/).some((l) => l.trim() === line.trim())) return text;
	const lines = text.split('\n');
	const at = lines.findIndex((l) => l.trim() === heading.trim());
	if (at < 0) return `${text.replace(/\s+$/, '')}${text.trim() === '' ? '' : '\n\n'}${heading}\n\n${line}\n`;
	let end = lines.length;
	const level = /^#+/.exec(heading.trim())?.[0].length ?? 2;
	for (let i = at + 1; i < lines.length; i++) {
		const m = /^(#+)\s/.exec(lines[i] ?? '');
		if (m && (m[1] ?? '').length <= level) {
			end = i;
			break;
		}
	}
	let ins = end;
	while (ins > at + 1 && (lines[ins - 1] ?? '').trim() === '') ins--;
	lines.splice(ins, 0, line);
	return lines.join('\n');
}

/** The wiki link line for a meeting note in the daily note. */
export function dailyLine(notePath: string, m: Meeting, tzMin: number): string {
	const base = notePath.replace(/^.*\//, '').replace(/\.md$/i, '');
	return `- ${localTime(m.date, tzMin)} [[${base}]]`;
}

// ---------------------------------------------------------------- vectors

const run: Record<string, (a: unknown[]) => unknown> = {
	parseFathom: (a) => parseFathom(a[0]),
	parseClock: (a) => parseClock(a[0]),
	isoStamp: (a) => isoStamp(a[0]),
	safeUrl: (a) => safeUrl(a[0]),
	mergePeople: (a) => mergePeople(a[0] as Person[]),
	meetingKey: (a) => meetingKey(a[0] as Meeting),
	isReady: (a) => isReady(a[0] as Meeting, a[1] as number),
	localDate: (a) => localDate(a[0] as string, a[1] as number),
	localTime: (a) => localTime(a[0] as string, a[1] as number),
	formatDate: (a) => formatDate(a[0] as string, a[1] as string, a[2] as number),
	sanitizeFileName: (a) => (a.length > 1 ? sanitizeFileName(a[0] as string, a[1] as number) : sanitizeFileName(a[0] as string)),
	shortHash: (a) => shortHash(a[0] as string),
	renderFileName: (a) => renderFileName(a[0] as string, a[1] as Meeting, a[2] as number),
	uniqueName: (a) => {
		const taken = new Set(a[1] as string[]);
		return uniqueName(a[0] as string, (n) => taken.has(n), a[2] as string);
	},
	normalizeFolder: (a) => normalizeFolder(a[0] as string),
	normalizeTemplate: (a) => normalizeTemplate(a[0] as string),
	renderFrontmatter: (a) => renderFrontmatter(a[0] as Meeting),
	demoteHeadings: (a) => demoteHeadings(a[0] as string),
	renderActions: (a) => renderActions(a[0] as ActionItem[]),
	renderTranscript: (a) => renderTranscript(a[0] as TranscriptLine[]),
	clock: (a) => clock(a[0] as number),
	renderNote: (a) => renderNote(a[0] as Meeting, a[1] as RenderOptions),
	normalizeDay: (a) => normalizeDay(a[0] as string),
	passesFilters: (a) => passesFilters(a[0] as Meeting, a[1] as Filters, a[2] as number),
	windowFrom: (a) => windowFrom(a[0] as Cursor, a[1] as number | undefined),
	nextCursor: (a) => nextCursor(a[0] as Cursor, a[1] as string[], a[2] as boolean),
	dailyNotePath: (a) => dailyNotePath(a[0] as Meeting, a[1] as string, a[2] as string, a[3] as number),
	addLinkUnderHeading: (a) => addLinkUnderHeading(a[0] as string, a[1] as string, a[2] as string),
	dailyLine: (a) => dailyLine(a[0] as string, a[1] as Meeting, a[2] as number),
};

/** Runs the function that a golden vector names. args = [fn, args]. */
export function evalVector(fn: string, args: unknown[]): unknown {
	const f = run[fn];
	if (!f) throw new Error(`unknown vector function ${fn}`);
	return f(args);
}
