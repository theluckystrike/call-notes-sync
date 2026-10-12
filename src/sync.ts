// The sync: fetch meetings from Fathom starting at the cursor, write one note per meeting.
// Rules: a note that you deleted is never made again; a note that exists is never changed (your edits are safe); nothing is written
// when nothing is new; a failure keeps the cursor where the last finished run left it.
import { normalizePath, type App, type TFile } from 'obsidian';
import type { MeetingClient } from './client';
import {
	EMPTY_CURSOR,
	PROVIDER_LABEL,
	addLinkUnderHeading,
	dailyLine,
	dailyNotePath,
	isReady,
	meetingKey,
	nextCursor,
	normalizeFolder,
	normalizeTemplate,
	parseFathom,
	passesFilters,
	renderFileName,
	renderNote,
	shortHash,
	uniqueName,
	windowFrom,
	type Cursor,
	type Filters,
	type Meeting,
	type Provider,
} from './logic';

/** Batches of one run for one service. A larger account finishes on the next run. */
export const MAX_BATCHES = 20;
/** Fathom allows 30 heavy requests (summary or transcript on the list) in 60 seconds. */
export const MIN_GAP_MS = 2100;
export const MAX_RETRIES = 2;
export const MAX_DELETED = 100_000;
export const PROVIDERS: Provider[] = ['fathom'];

export interface SyncState {
	cursors: Record<Provider, Cursor>;
	/** Meeting key (provider:id) to the note that holds it. */
	meetings: Record<string, { path: string }>;
	/** Keys of notes that you deleted. They are not made again. */
	deleted: string[];
	lastSync: string | null;
}

export const emptyState = (): SyncState => ({ cursors: { fathom: { ...EMPTY_CURSOR } }, meetings: {}, deleted: [], lastSync: null });

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) ? v : null);

function normalizeCursor(v: unknown): Cursor {
	const c = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
	return { since: isoOrNull(c.since), until: isoOrNull(c.until), high: isoOrNull(c.high) };
}

/** Fills gaps and drops bad values from saved data. */
export function normalizeState(saved: unknown): SyncState {
	const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Record<string, unknown>;
	const meetings: SyncState['meetings'] = {};
	if (typeof s.meetings === 'object' && s.meetings !== null) {
		for (const [k, v] of Object.entries(s.meetings as Record<string, unknown>)) {
			const path = typeof v === 'object' && v !== null ? (v as { path?: unknown }).path : null;
			if (/^fathom:/.test(k) && typeof path === 'string' && path !== '') meetings[k] = { path };
		}
	}
	const cur = (typeof s.cursors === 'object' && s.cursors !== null ? s.cursors : {}) as Record<string, unknown>;
	const deleted = Array.isArray(s.deleted) ? (s.deleted as unknown[]).filter((d): d is string => typeof d === 'string').slice(-MAX_DELETED) : [];
	return {
		cursors: { fathom: normalizeCursor(cur.fathom) },
		meetings,
		deleted: [...new Set(deleted)],
		lastSync: typeof s.lastSync === 'string' ? s.lastSync : null,
	};
}

export interface DailyOptions {
	folder: string;
	format: string;
	heading: string;
}

export interface SyncOptions {
	/** Services that have a key. Only Fathom. */
	providers: Provider[];
	folder: string;
	template: string;
	/** Pro: the transcript is fetched and written. */
	transcript: boolean;
	/** Pro: the body template. Empty: the default body. */
	body: string;
	/** Pro: tags for the front matter of each new note. Empty: none. */
	tags: string;
	/** Pro: extra front matter lines, one "name: value" for each line. Empty: none. */
	props: string;
	/** Pro: date and participant filters. */
	filters: Filters;
	/** Pro: link each new note in its daily note. null: off. */
	daily: DailyOptions | null;
}

export interface SyncResult {
	ok: boolean;
	message: string;
	fetched: number;
	created: number;
	existing: number;
	forgotten: number;
	filtered: number;
	waiting: number;
	linked: number;
	more: boolean;
	errors: string[];
}

export interface SyncDeps {
	app: App;
	client: MeetingClient;
	options: () => SyncOptions;
	now: () => number;
	/** Minutes east of UTC of the local time zone at that instant. */
	tz: (iso: string) => number;
	sleep: (ms: number) => Promise<void>;
	save: () => void;
}

interface Fetched {
	meetings: Meeting[];
	rows: number;
	skippedRows: number;
	dates: string[];
	capped: boolean;
	error: string | null;
}

const blank = (message: string, ok = false): SyncResult => ({ ok, message, fetched: 0, created: 0, existing: 0, forgotten: 0, filtered: 0, waiting: 0, linked: 0, more: false, errors: [] });

export class SyncService {
	deps: SyncDeps;
	state: SyncState;
	running = false;

	constructor(deps: SyncDeps, state: SyncState) {
		this.deps = deps;
		this.state = state;
	}

	/** A note of ours was deleted: remember the meeting so that it is not made again. */
	noteDeleted(path: string): void {
		for (const [key, rec] of Object.entries(this.state.meetings)) {
			if (rec.path !== path && !rec.path.startsWith(`${path}/`)) continue;
			delete this.state.meetings[key];
			if (!this.state.deleted.includes(key)) this.state.deleted.push(key);
		}
		this.deps.save();
	}

	/** A note or a folder of ours moved: follow it. */
	noteRenamed(oldPath: string, newPath: string): void {
		for (const rec of Object.values(this.state.meetings)) {
			if (rec.path === oldPath) rec.path = newPath;
			else if (rec.path.startsWith(`${oldPath}/`)) rec.path = `${newPath}${rec.path.slice(oldPath.length)}`;
		}
		this.deps.save();
	}

	/** Makes the plugin forget which notes you deleted. The next sync can make them again. */
	forgetDeleted(): number {
		const n = this.state.deleted.length;
		this.state.deleted = [];
		this.deps.save();
		return n;
	}

	/** The next run starts from the beginning of the history. Notes that exist stay and are not made twice. */
	resetCursors(): void {
		this.state.cursors = emptyState().cursors;
		this.deps.save();
	}

	private async pageWithRetry(provider: Provider, from: string | null, to: string | null, token: string | null, transcript: boolean): Promise<{ ok: true; rows: unknown[]; next: string | null } | { ok: false; message: string }> {
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const r = await this.deps.client.page({ provider, from, to, token, transcript });
			if (r.ok) return { ok: true, rows: r.data.rows, next: r.data.next };
			if (r.kind !== 'rate' || attempt === MAX_RETRIES) return { ok: false, message: r.message };
			await this.deps.sleep(r.waitMs);
		}
		return { ok: false, message: `${PROVIDER_LABEL[provider]} asked us to slow down. Try again later.` };
	}

	private async fetchAll(provider: Provider, opt: SyncOptions): Promise<Fetched> {
		const cur = this.state.cursors[provider];
		const from = windowFrom(cur);
		const out: Fetched = { meetings: [], rows: 0, skippedRows: 0, dates: [], capped: false, error: null };
		let token: string | null = null;
		for (let i = 0; i < MAX_BATCHES; i++) {
			if (i > 0) await this.deps.sleep(MIN_GAP_MS);
			const r = await this.pageWithRetry(provider, from, cur.until, token, opt.transcript);
			if (!r.ok) {
				out.error = r.message;
				return out;
			}
			for (const row of r.rows) {
				out.rows++;
				const m = parseFathom(row);
				if (m === null) out.skippedRows++;
				else {
					out.meetings.push(m);
					out.dates.push(m.date);
				}
			}
			token = r.next;
			if (token === null) return out;
		}
		out.capped = true;
		return out;
	}

	/** Runs one sync. Never throws: a failure comes back in the result. */
	async run(): Promise<SyncResult> {
		if (this.running) return blank('A sync is already running.');
		const opt = this.deps.options();
		if (opt.providers.length === 0) return blank('Add a Fathom API key in the plugin settings.');
		this.running = true;
		try {
			return await this.runInner(opt);
		} catch (e) {
			return blank(`Sync stopped: ${e instanceof Error ? e.message : 'unknown error'}.`);
		} finally {
			this.running = false;
		}
	}

	private async runInner(opt: SyncOptions): Promise<SyncResult> {
		const res = blank('', true);
		for (const provider of opt.providers) {
			const got = await this.fetchAll(provider, opt);
			res.fetched += got.meetings.length;
			for (const m of got.meetings) await this.take(m, opt, res);
			if (got.error === null) this.state.cursors[provider] = nextCursor(this.state.cursors[provider], got.dates, got.capped);
			else {
				res.ok = false;
				res.errors.push(got.error);
			}
			if (got.capped) res.more = true;
		}
		if (res.ok) this.state.lastSync = new Date(this.deps.now()).toISOString();
		this.deps.save();
		res.message = summary(res);
		return res;
	}

	private async take(m: Meeting, opt: SyncOptions, res: SyncResult): Promise<void> {
		if (!passesFilters(m, opt.filters, this.deps.tz(m.date))) {
			res.filtered++;
			return;
		}
		if (!isReady(m, this.deps.now())) {
			res.waiting++;
			return;
		}
		const how = await this.apply(m, opt);
		if (how === 'created-linked') {
			res.created++;
			res.linked++;
		} else res[how]++;
	}

	private async apply(m: Meeting, opt: SyncOptions): Promise<'created' | 'created-linked' | 'existing' | 'forgotten'> {
		const key = meetingKey(m);
		if (this.state.deleted.includes(key)) return 'forgotten';
		const rec = this.state.meetings[key];
		if (rec) {
			if (this.deps.app.vault.getFileByPath(rec.path)) return 'existing';
			const moved = this.findByKey(m);
			if (!moved) {
				delete this.state.meetings[key];
				this.state.deleted.push(key);
				return 'forgotten';
			}
			rec.path = moved.path;
			return 'existing';
		}
		const found = this.findByKey(m);
		if (found) {
			this.state.meetings[key] = { path: found.path };
			return 'existing';
		}
		const path = await this.createNote(m, opt);
		return opt.daily !== null && (await this.linkDaily(m, path, opt.daily)) ? 'created-linked' : 'created';
	}

	/** A note whose front matter names this meeting: a note that moved while Obsidian was closed, or the sync state was lost. */
	private findByKey(m: Meeting): TFile | null {
		const { vault, metadataCache } = this.deps.app;
		for (const f of vault.getMarkdownFiles()) {
			const fm = metadataCache.getFileCache(f)?.frontmatter;
			if (fm?.meeting_source === m.provider && String(fm.meeting_id ?? '') === m.id) return f;
		}
		return null;
	}

	private async createNote(m: Meeting, opt: SyncOptions): Promise<string> {
		const { vault } = this.deps.app;
		const folder = normalizeFolder(opt.folder);
		let made = '';
		for (const part of folder === '' ? [] : folder.split('/')) {
			made = made === '' ? part : `${made}/${part}`;
			if (!vault.getFolderByPath(made)) await vault.createFolder(made).catch(() => undefined);
		}
		const tz = this.deps.tz(m.date);
		const base = renderFileName(normalizeTemplate(opt.template), m, tz);
		const name = uniqueName(base, (n) => vault.getAbstractFileByPath(normalizePath(`${folder}/${n}.md`)) !== null, shortHash(meetingKey(m)));
		const path = normalizePath(`${folder}/${name}.md`);
		await vault.create(path, renderNote(m, { tzMin: tz, transcript: opt.transcript, body: opt.body, tags: opt.tags, props: opt.props }));
		this.state.meetings[meetingKey(m)] = { path };
		return path;
	}

	/** Pro: adds a link to the new note in the daily note of the meeting day. Never makes a daily note. True when a line was added. */
	private async linkDaily(m: Meeting, notePath: string, d: DailyOptions): Promise<boolean> {
		const tz = this.deps.tz(m.date);
		const dailyPath = normalizePath(dailyNotePath(m, d.folder, d.format, tz));
		const file = this.deps.app.vault.getFileByPath(dailyPath);
		if (!file) return false;
		const line = dailyLine(notePath, m, tz);
		let added = false;
		await this.deps.app.vault.process(file, (data) => {
			const next = addLinkUnderHeading(data, d.heading, line);
			added = next !== data;
			return next;
		});
		return added;
	}
}

/** One sentence for the notice after a sync. */
export function summary(r: SyncResult): string {
	const n = (c: number, one: string, many: string): string => `${c} ${c === 1 ? one : many}`;
	const parts = [n(r.created, 'new note', 'new notes')];
	if (r.existing > 0) parts.push(`${r.existing} already in the vault`);
	if (r.forgotten > 0) parts.push(`${r.forgotten} skipped because you deleted ${r.forgotten === 1 ? 'it' : 'them'}`);
	if (r.filtered > 0) parts.push(`${r.filtered} left out by your filters`);
	if (r.waiting > 0) parts.push(`${r.waiting} not ready yet`);
	if (r.linked > 0) parts.push(`${r.linked} linked in daily notes`);
	let head = `Fetched ${n(r.fetched, 'meeting', 'meetings')}: ${parts.join(', ')}.`;
	if (r.errors.length > 0) head = `${r.errors.join(' ')} ${head}`;
	return r.more ? `${head} There are more. Run Sync now again.` : head;
}
