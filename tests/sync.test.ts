import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { App } from 'obsidian-test-mocks/obsidian';
import { MeetingClient, classify, fathomQuery, type Http, type HttpReply, type HttpRequest } from '../src/client';
import { MAX_BATCHES, MIN_GAP_MS, SyncService, emptyState, normalizeState, summary, type SyncOptions } from '../src/sync';
import { NO_FILTERS } from '../src/logic';

const NOW = Date.parse('2026-10-11T00:00:00Z');
/** The page size of the stub. Fathom sets the real one. */
const PAGE = 50;

/** One Fathom meeting row as the list endpoint sends it (docs: developers.fathom.ai, raw copy in research/obsidian-run/raw/b5). */
function row(id: string, day: number, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		title: `Meeting ${id}`,
		meeting_title: `Meeting ${id}`,
		recording_id: id,
		url: `https://fathom.video/calls/${id}`,
		created_at: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`,
		recording_start_time: `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`,
		recording_end_time: `2026-10-${String(day).padStart(2, '0')}T09:45:00Z`,
		calendar_invitees: [{ name: 'Ann Lee', email: 'ann@example.com' }],
		recorded_by: { name: 'Ann Lee', email: 'ann@example.com' },
		default_summary: { markdown_formatted: `Summary of ${id}.` },
		action_items: [{ description: 'Send the notes', completed: false, assignee: { name: 'Ann Lee' } }],
		...over,
	};
}

interface Rig {
	svc: SyncService;
	app: App;
	calls: HttpRequest[];
	sleeps: number[];
	script: { rows: Record<string, unknown>[]; replies: HttpReply[] };
	opts: SyncOptions;
}

const OPTS: SyncOptions = { providers: ['fathom'], folder: 'Meetings', template: '{date} {title}', transcript: false, body: '', tags: '', props: '', filters: NO_FILTERS, daily: null };

/** A sync service over an in-memory vault and a scripted Fathom. Rows are served by window and page like the real API: newest first, a cursor. */
function rig(rows: Record<string, unknown>[] = []): Rig {
	const app = App.createConfigured__({ files: {} });
	const calls: HttpRequest[] = [];
	const sleeps: number[] = [];
	const script = { rows, replies: [] as HttpReply[] };
	const http: Http = (r) => {
		calls.push(r);
		const queued = script.replies.shift();
		if (queued) return Promise.resolve(queued);
		const q = new URLSearchParams(r.payload);
		const after = q.get('created_after');
		const before = q.get('created_before');
		const offset = Number(q.get('cursor') ?? '0');
		const hits = script.rows
			.filter((x) => (after === null || String(x.created_at) > after) && (before === null || String(x.created_at) < before))
			.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
		const next = offset + PAGE < hits.length ? String(offset + PAGE) : null;
		return Promise.resolve({ status: 200, json: { items: hits.slice(offset, offset + PAGE), limit: PAGE, next_cursor: next }, headers: {} });
	};
	const opts: SyncOptions = { ...OPTS };
	const client = new MeetingClient({ getKey: () => 'fa-secret-key', http });
	const svc = new SyncService(
		{ app: app as never, client, options: () => opts, now: () => NOW, tz: () => 0, sleep: (ms) => (sleeps.push(ms), Promise.resolve()), save: () => undefined },
		emptyState(),
	);
	return { svc, app, calls, sleeps, script, opts };
}

const read = (r: Rig, path: string): Promise<string> => r.app.vault.adapter.read(path);

describe('sync with Fathom', () => {
	it('makes one note per meeting with front matter, summary, tasks and the link back', async () => {
		const r = rig([row('aaaa1', 8), row('bbbb2', 9)]);
		const res = await r.svc.run();
		expect(res).toMatchObject({ ok: true, fetched: 2, created: 2, existing: 0 });
		const text = await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md');
		expect(text).toContain('meeting_source: fathom');
		expect(text).toContain('meeting_id: "aaaa1"');
		expect(text).toContain('  - "Ann Lee"');
		expect(text).toContain('Summary of aaaa1.');
		expect(text).toContain('- [ ] Send the notes (Ann Lee)');
		expect(text).toContain('duration_minutes: 45');
		expect(text).toContain('[Open in Fathom](https://fathom.video/calls/aaaa1)');
		expect(Object.keys(r.svc.state.meetings).sort()).toEqual(['fathom:aaaa1', 'fathom:bbbb2']);
	});

	it('adds Pro tags and extra properties after the built in properties of a new note', async () => {
		const r = rig([row('aaaa1', 8)]);
		r.opts.tags = '#meeting, calls/fathom';
		r.opts.props = 'type: call\nattendees: {{participant_links}}\nreviewed: false\nmeeting_id: 7';
		await r.svc.run();
		const text = await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md');
		const fm = text.slice(0, text.indexOf('\n---\n', 4) + 5);
		expect(fm).toBe(
			'---\nmeeting_source: fathom\nmeeting_id: "aaaa1"\ntitle: "Meeting aaaa1"\ndate: 2026-10-08T09:00:00Z\nduration_minutes: 45\nparticipants:\n  - "Ann Lee"\nurl: "https://fathom.video/calls/aaaa1"\n' +
				'tags:\n  - "meeting"\n  - "calls/fathom"\ntype: "call"\nattendees:\n  - "[[Ann Lee]]"\nreviewed: false\n---\n',
		);
	});

	it('writes no tags and no extra properties when the options are empty', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		const text = await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md');
		expect(text).not.toContain('tags:');
		expect(text.split('\n---\n')[0]).toBe(
			'---\nmeeting_source: fathom\nmeeting_id: "aaaa1"\ntitle: "Meeting aaaa1"\ndate: 2026-10-08T09:00:00Z\nduration_minutes: 45\nparticipants:\n  - "Ann Lee"\nurl: "https://fathom.video/calls/aaaa1"',
		);
	});

	it('keeps at most 20 tags and 20 extra properties', async () => {
		const r = rig([row('aaaa1', 8)]);
		r.opts.tags = Array.from({ length: 30 }, (_v, i) => `t${i}x`).join(' ');
		r.opts.props = Array.from({ length: 30 }, (_v, i) => `p${i}x: ${i}`).join('\n');
		await r.svc.run();
		const text = await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md');
		expect(text.match(/^ {2}- "t\d+x"$/gm)).toHaveLength(20);
		expect(text.match(/^p\d+x: \d+$/gm)).toHaveLength(20);
	});

	it('does not change a note again when you change the tags later', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		const before = await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md');
		r.opts.tags = 'late';
		r.opts.props = 'x: 1';
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, existing: 1 });
		expect(await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md')).toBe(before);
	});

	it('writes a completed task as done', async () => {
		const r = rig([row('aaaa1', 8, { action_items: [{ description: 'Follow up', completed: true, assignee: { name: 'Bo Chen' } }] })]);
		await r.svc.run();
		expect(await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md')).toContain('- [x] Follow up (Bo Chen)');
	});

	it('sends the key only in the X-Api-Key header and asks for no transcript in the free build', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		const first = r.calls[0];
		expect(first?.headers['X-Api-Key']).toBe('fa-secret-key');
		expect(first?.payload).toBe(fathomQuery(null, null, null, false));
		expect(first?.payload).not.toContain('include_transcript');
		expect(first?.payload).not.toContain('fa-secret-key');
	});

	it('a second run starts 48 hours before the newest meeting and writes nothing new', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, existing: 1 });
		expect(r.calls[1]?.payload).toBe(fathomQuery('2026-10-06T09:00:00Z', null, null, false));
		expect(r.svc.state.cursors.fathom.since).toBe('2026-10-08T09:00:00Z');
	});

	it('never changes a note that exists', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		const file = r.app.vault.getFileByPath('Meetings/2026-10-08 Meeting aaaa1.md');
		await r.app.vault.process(file as never, (d) => `${d}\nMy own thoughts.\n`);
		r.script.rows[0] = row('aaaa1', 8, { default_summary: { markdown_formatted: 'Changed upstream.' } });
		r.svc.resetCursors();
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, existing: 1 });
		const text = await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md');
		expect(text).toContain('My own thoughts.');
		expect(text).toContain('Summary of aaaa1.');
		expect(text).not.toContain('Changed upstream.');
	});

	it('does not make a deleted note again, and Forget deleted notes allows it', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		const file = r.app.vault.getFileByPath('Meetings/2026-10-08 Meeting aaaa1.md');
		await r.app.vault.delete(file as never);
		r.svc.noteDeleted('Meetings/2026-10-08 Meeting aaaa1.md');
		expect(r.svc.state.deleted).toEqual(['fathom:aaaa1']);
		r.svc.resetCursors();
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, forgotten: 1 });
		expect(r.app.vault.getFileByPath('Meetings/2026-10-08 Meeting aaaa1.md')).toBeNull();
		expect(r.svc.forgetDeleted()).toBe(1);
		r.svc.resetCursors();
		expect((await r.svc.run()).created).toBe(1);
	});

	it('a note that vanished while Obsidian was closed counts as deleted', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		// The service gets no delete event here, like a note that was deleted while Obsidian was closed.
		await r.app.vault.delete(r.app.vault.getFileByPath('Meetings/2026-10-08 Meeting aaaa1.md') as never);
		r.svc.resetCursors();
		const res = await r.svc.run();
		expect(res.forgotten).toBe(1);
		expect(r.svc.state.deleted).toEqual(['fathom:aaaa1']);
	});

	it('follows a renamed note and a renamed folder', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.svc.run();
		r.svc.noteRenamed('Meetings/2026-10-08 Meeting aaaa1.md', 'Archive/x.md');
		expect(r.svc.state.meetings['fathom:aaaa1']?.path).toBe('Archive/x.md');
		r.svc.noteRenamed('Archive', 'Old');
		expect(r.svc.state.meetings['fathom:aaaa1']?.path).toBe('Old/x.md');
	});

	it('follows next_cursor with a pause between requests and stops after the last page', async () => {
		const rows = Array.from({ length: 120 }, (_v, i) => row(`m${String(i).padStart(4, '0')}`, 1 + (i % 9)));
		const r = rig(rows);
		const res = await r.svc.run();
		expect(res.fetched).toBe(120);
		expect(r.calls).toHaveLength(3);
		expect(r.calls[1]?.payload).toContain(`cursor=${PAGE}`);
		expect(r.sleeps).toEqual([MIN_GAP_MS, MIN_GAP_MS]);
		expect(res.more).toBe(false);
	});

	it('stops at the batch limit, says there is more and continues before the oldest meeting', async () => {
		const at = (i: number): string => new Date(Date.parse('2026-10-09T00:00:00Z') - i * 60_000).toISOString().replace('.000Z', 'Z');
		const rows = Array.from({ length: 1100 }, (_v, i) => row(`m${String(i).padStart(4, '0')}`, 1 + (i % 9), { created_at: at(i), recording_start_time: at(i), recording_end_time: at(i) }));
		const r = rig(rows);
		const res = await r.svc.run();
		expect(r.calls).toHaveLength(MAX_BATCHES);
		expect(res).toMatchObject({ more: true, created: 1000 });
		const cur = r.svc.state.cursors.fathom;
		expect(cur.since).toBeNull();
		expect(cur.until).not.toBeNull();
		expect(cur.high).toBe('2026-10-09T00:00:00Z');
		const res2 = await r.svc.run();
		expect(res2).toMatchObject({ more: false, created: 100 });
		expect(r.svc.state.cursors.fathom).toEqual({ since: '2026-10-09T00:00:00Z', until: null, high: null });
	}, 30_000);

	it('a young meeting without a summary waits and is made on a later run', async () => {
		const r = rig([row('aaaa1', 10, { default_summary: null, action_items: [] })]);
		let res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, waiting: 1 });
		r.script.rows[0] = row('aaaa1', 10);
		res = await r.svc.run();
		expect(res).toMatchObject({ created: 1, waiting: 0 });
	});

	it('adopts a note with the same meeting id when the sync state is lost', async () => {
		const r = rig([row('aaaa1', 8)]);
		await r.app.vault.createFolder('Elsewhere');
		await r.app.vault.create('Elsewhere/old.md', '---\nmeeting_source: fathom\nmeeting_id: "aaaa1"\n---\nHello\n');
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 0, existing: 1 });
		expect(r.svc.state.meetings['fathom:aaaa1']?.path).toBe('Elsewhere/old.md');
	});

	it('gives two meetings with one title two file names', async () => {
		const r = rig([row('aaaa1', 8, { meeting_title: 'Sync' }), row('bbbb2', 8, { meeting_title: 'Sync' })]);
		await r.svc.run();
		expect(Object.values(r.svc.state.meetings).map((m) => m.path).sort()).toEqual(['Meetings/2026-10-08 Sync (2).md', 'Meetings/2026-10-08 Sync.md']);
	});
});

describe('failures', () => {
	it('a rejected key gives a clear message and keeps the cursor and the last sync time', async () => {
		const r = rig([row('aaaa1', 9)]);
		r.script.replies.push({ status: 401, json: null, headers: {} });
		const res = await r.svc.run();
		expect(res.ok).toBe(false);
		expect(res.message).toContain('Fathom did not accept the API key');
		expect(res.created).toBe(0);
		expect(r.svc.state.cursors.fathom.since).toBeNull();
		expect(r.svc.state.lastSync).toBeNull();
	});

	it('waits and retries on HTTP 429, then stops with a clear text after three answers', async () => {
		const r = rig([row('aaaa1', 8)]);
		r.script.replies.push({ status: 429, json: null, headers: { 'retry-after': '3' } });
		expect((await r.svc.run()).created).toBe(1);
		expect(r.sleeps).toEqual([3000]);
		const r2 = rig([row('aaaa1', 8)]);
		for (let i = 0; i < 3; i++) r2.script.replies.push({ status: 429, json: null, headers: {} });
		const res = await r2.svc.run();
		expect(res.ok).toBe(false);
		expect(res.message).toContain('asked us to slow down');
		expect(r2.sleeps).toEqual([30_000, 30_000]);
	});

	it('says offline when there is no answer and has no run without a key', async () => {
		const r = rig([row('aaaa1', 8)]);
		r.script.replies.push({ status: 0, json: null, headers: {} });
		expect((await r.svc.run()).message).toContain('No answer from Fathom');
		r.opts.providers = [];
		expect((await r.svc.run()).message).toBe('Add a Fathom API key in the plugin settings.');
	});
});

describe('Pro options', () => {
	it('asks for the transcript and writes it with speaker labels', async () => {
		const transcript = [
			{ speaker: { display_name: 'Ann Lee' }, text: 'Hello team.', timestamp: '00:00:01' },
			{ speaker: { display_name: 'Ann Lee' }, text: 'Welcome.', timestamp: '00:00:04' },
		];
		const r = rig([row('aaaa1', 8, { transcript })]);
		r.opts.transcript = true;
		await r.svc.run();
		expect(r.calls[0]?.payload).toBe(fathomQuery(null, null, null, true));
		expect(await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md')).toContain('## Transcript\n\n**Ann Lee** (0:01): Hello team. Welcome.');
	});

	it('leaves out meetings by date and participant and still moves the cursor', async () => {
		const zed = { name: 'Zed', email: 'zed@example.com' };
		const r = rig([row('aaaa1', 8), row('bbbb2', 9, { recorded_by: zed, calendar_invitees: [zed] })]);
		r.opts.filters = { from: '', to: '', participants: 'zed' };
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 1, filtered: 1 });
		expect(r.svc.state.cursors.fathom.since).toBe('2026-10-09T09:00:00Z');
		expect(r.app.vault.getFileByPath('Meetings/2026-10-09 Meeting bbbb2.md')).not.toBeNull();
	});

	it('uses the body template', async () => {
		const r = rig([row('aaaa1', 8)]);
		r.opts.body = 'On {{date}}: {{summary}}';
		await r.svc.run();
		expect(await read(r, 'Meetings/2026-10-08 Meeting aaaa1.md')).toContain('\n# Meeting aaaa1\n\nOn 2026-10-08: Summary of aaaa1.\n');
	});

	it('adds a link to the daily note that exists and never makes a daily note', async () => {
		const r = rig([row('aaaa1', 8), row('bbbb2', 9)]);
		await r.app.vault.createFolder('Daily');
		await r.app.vault.create('Daily/2026-10-08.md', '# Thursday\n');
		r.opts.daily = { folder: 'Daily', format: 'YYYY-MM-DD', heading: '## Meetings' };
		const res = await r.svc.run();
		expect(res).toMatchObject({ created: 2, linked: 1 });
		expect(await read(r, 'Daily/2026-10-08.md')).toBe('# Thursday\n\n## Meetings\n\n- 09:00 [[2026-10-08 Meeting aaaa1]]\n');
		expect(r.app.vault.getFileByPath('Daily/2026-10-09.md')).toBeNull();
	});
});

describe('client and state', () => {
	it('classifies answers', () => {
		expect(classify('fathom', { status: 200, json: { items: [] }, headers: {} }).ok).toBe(true);
		expect(classify('fathom', { status: 401, json: null, headers: {} })).toMatchObject({ ok: false, kind: 'auth' });
		expect(classify('fathom', { status: 403, json: null, headers: {} })).toMatchObject({ ok: false, kind: 'auth' });
		expect(classify('fathom', { status: 500, json: null, headers: {} })).toMatchObject({ ok: false, kind: 'server' });
		expect(classify('fathom', { status: 429, json: null, headers: { 'Retry-After': '7' } })).toMatchObject({ ok: false, kind: 'rate', waitMs: 7000 });
		expect(classify('fathom', { status: 429, json: null, headers: { 'retry-after': '9999' } })).toMatchObject({ ok: false, kind: 'rate', waitMs: 120_000 });
		expect(classify('fathom', { status: 404, json: null, headers: {} })).toMatchObject({ ok: false, kind: 'http', status: 404 });
	});

	it('builds the Fathom query with a window, a cursor and the transcript flag', () => {
		expect(fathomQuery('2026-10-06T09:00:00Z', null, 'abc=', true)).toBe('include_summary=true&include_action_items=true&include_transcript=true&created_after=2026-10-06T09%3A00%3A00Z&cursor=abc%3D');
	});

	it('no key gives a clear text and sends nothing', async () => {
		let sent = 0;
		const c = new MeetingClient({ getKey: () => null, http: () => (sent++, Promise.resolve({ status: 200, json: {}, headers: {} })) });
		const r = await c.page({ provider: 'fathom', from: null, to: null, token: null, transcript: false });
		expect(r).toMatchObject({ ok: false, kind: 'no-key', message: 'Add your Fathom API key in the plugin settings.' });
		expect(await c.check('fathom')).toMatchObject({ ok: false, kind: 'no-key' });
		expect(sent).toBe(0);
	});

	it('paging follows next_cursor and rejects an answer without a list', async () => {
		const c = new MeetingClient({ getKey: () => 'k', http: () => Promise.resolve({ status: 200, json: { items: [{}], next_cursor: 'c2' }, headers: {} }) });
		const r = await c.page({ provider: 'fathom', from: null, to: null, token: null, transcript: false });
		expect(r).toMatchObject({ ok: true, data: { next: 'c2' } });
		const bad = new MeetingClient({ getKey: () => 'k', http: () => Promise.resolve({ status: 200, json: { data: 1 }, headers: {} }) });
		expect(await bad.page({ provider: 'fathom', from: null, to: null, token: null, transcript: false })).toMatchObject({ ok: false, kind: 'http' });
	});

	it('check connection sends one request and says Fathom accepted the key', async () => {
		const seen: HttpRequest[] = [];
		const c = new MeetingClient({ getKey: () => 'k', http: (q) => (seen.push(q), Promise.resolve({ status: 200, json: { items: [] }, headers: {} })) });
		expect(await c.check('fathom')).toEqual({ ok: true, data: 'Fathom accepted the key.' });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.payload).toBe('');
		const bad = new MeetingClient({ getKey: () => 'k', http: () => Promise.resolve({ status: 401, json: null, headers: {} }) });
		expect(await bad.check('fathom')).toMatchObject({ ok: false, kind: 'auth' });
	});

	it('normalizes saved state and drops bad values', () => {
		const s = normalizeState({
			cursors: { fathom: { since: '2026-10-08T09:00:00Z', until: 'bad' } },
			meetings: { 'fathom:a': { path: 'x.md' }, 'other:b': { path: 'y.md' }, 'fathom:c': { path: '' } },
			deleted: ['fathom:1', 3, 'fathom:1'],
			lastSync: 5,
		});
		expect(s.cursors.fathom).toEqual({ since: '2026-10-08T09:00:00Z', until: null, high: null });
		expect(s.meetings).toEqual({ 'fathom:a': { path: 'x.md' } });
		expect(s.deleted).toEqual(['fathom:1']);
		expect(s.lastSync).toBeNull();
		expect(normalizeState(null)).toEqual(emptyState());
	});

	it('writes one sentence for the notice', () => {
		const base = { ok: true, message: '', fetched: 3, created: 1, existing: 1, forgotten: 1, filtered: 0, waiting: 0, linked: 0, more: false, errors: [] };
		expect(summary(base)).toBe('Fetched 3 meetings: 1 new note, 1 already in the vault, 1 skipped because you deleted it.');
		expect(summary({ ...base, fetched: 1, existing: 0, forgotten: 0, more: true, errors: ['Oops.'] })).toBe('Oops. Fetched 1 meeting: 1 new note. There are more. Run Sync now again.');
	});
});

describe('Fathom only', () => {
	// The plugin reads one service. A second service needs its own terms check, so no other service name or host stays in the code.
	const other = ['fire', 'flies'].join('');
	it('has no other service in the source, the manifest or the network list', () => {
		// The exported repo vendors shared code under src/core and has no product.yaml, so walk folders and skip absent files.
		const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
		const files = walk('src').concat(['manifest.json', 'package.json', 'product.yaml'].filter((f) => existsSync(f)));
		expect(files.length).toBeGreaterThan(3);
		for (const f of files) expect(readFileSync(f, 'utf8').toLowerCase(), f).not.toContain(other);
	});

	it('sends every request to api.fathom.ai and reads only', () => {
		const text = readFileSync('src/client.ts', 'utf8');
		const urls = text.match(/https?:\/\/[^\s'"`$)]+/g) ?? [];
		for (const u of urls) expect(u.startsWith('https://api.fathom.ai/external/v1/meetings') || u.startsWith('https://developers.fathom.ai')).toBe(true);
		expect(text).toContain("method: 'GET'");
		expect(text).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/);
	});
});
