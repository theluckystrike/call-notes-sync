import { readFileSync } from 'node:fs';
import { browser, expect } from '@wdio/globals';
import { lastNotice, pluginId, reloadPlugin } from './load';

// Real-app checks against a STUBBED Fathom (docs/sample-notes/stub-calls.js): no real key, no real request.
// The stub has 5 Fathom meetings, one a day from 5 to 9 October.
const STUB = readFileSync('docs/sample-notes/stub-calls.js', 'utf8');
const FOLDER = 'Meetings';
const NOTE_A = `${FOLDER}/2026-10-05 Weekly product sync.md`;
const NOTE_B = `${FOLDER}/2026-10-08 Quarterly planning.md`;

interface Call {
	provider: string;
	payload: string;
	apiKey: string;
}

async function installStub(): Promise<void> {
	await browser.executeObsidian(({ app }, src) => new Function('app', `return ${src}`)(app) as string, STUB);
}

/** Runs js in the app with the plugin as p and the stub as st. Returns the JSON-safe result. */
async function inApp<T>(js: string): Promise<T> {
	return browser.executeObsidian(
		async ({ app }, id, code) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, unknown> } }).plugins.plugins[id];
			const st = (window as unknown as { __csStub?: unknown }).__csStub;
			const fn = new Function('app', 'p', 'st', `return (async () => (${code}))()`) as (a: unknown, b: unknown, c: unknown) => Promise<T>;
			return fn(app, p, st);
		},
		pluginId,
		js,
	);
}

const readNote = (path: string): Promise<string | null> => inApp<string | null>(`(async () => { const f = app.vault.getFileByPath(${JSON.stringify(path)}); return f ? await app.vault.read(f) : null; })()`);
const noteCount = (): Promise<number> => inApp<number>(`app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(${JSON.stringify(`${FOLDER}/`)})).length`);
const syncNow = async (): Promise<void> => {
	await browser.execute(() => document.querySelectorAll('.notice').forEach((n) => n.remove()));
	await browser.executeObsidianCommand(`${pluginId}:sync-now`);
	await browser.waitUntil(async () => /Fetched|slow down|accept|Add a|No answer/.test(await lastNotice()), { timeout: 15000 });
};

describe(`${pluginId} in the real app`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const s = await reloadPlugin(pluginId);
		expect(s).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('says what is missing when no key is saved', async function () {
		await browser.executeObsidianCommand(`${pluginId}:sync-now`);
		await browser.waitUntil(async () => (await lastNotice()).includes('Add a Fathom API key'), { timeout: 8000 });
	});

	it('first sync makes one note per meeting', async function () {
		await installStub();
		await inApp('st.reset()');
		await syncNow();
		expect(await lastNotice()).toContain('Fetched 5 meetings: 5 new notes.');
		expect(await noteCount()).toBe(5);
		const a = (await readNote(NOTE_A)) ?? '';
		expect(a).toContain('meeting_source: fathom');
		expect(a).toContain('meeting_id: "4101"');
		expect(a).toContain('  - "Maria Lopez"');
		expect(a).toContain('- [ ] Fix the date bug in the importer (Sam Okoye)');
		expect(a).toContain('duration_minutes: 32');
		expect(a).toContain('[Open in Fathom](https://fathom.video/calls/4101)');
		expect(a).not.toContain('## Transcript');
		const b = (await readNote(NOTE_B)) ?? '';
		expect(b).toContain('meeting_source: fathom');
		expect(b).toContain('- [x] Book the planning room for November (Jo Park)');
		expect(b).toContain('### Goals');
		const calls = await inApp<Call[]>('st.calls');
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ provider: 'fathom', apiKey: 'stub-fathom-key-0000' });
		expect(calls[0]?.payload).not.toContain('include_transcript');
	});

	it('second sync asks from 48 hours before the newest meeting and changes no file', async function () {
		const before = await inApp<number>(`app.vault.getFileByPath(${JSON.stringify(NOTE_A)}).stat.mtime`);
		await syncNow();
		expect(await lastNotice()).toContain('Fetched 3 meetings: 0 new notes, 3 already in the vault.');
		const calls = await inApp<Call[]>('st.calls');
		expect(calls[1]?.payload).toContain('created_after=2026-10-07T12%3A01%3A00Z');
		expect(await inApp<number>(`app.vault.getFileByPath(${JSON.stringify(NOTE_A)}).stat.mtime`)).toBe(before);
		expect(await noteCount()).toBe(5);
	});

	it('a note that exists keeps the text you wrote', async function () {
		await inApp(`(async () => { const f = app.vault.getFileByPath(${JSON.stringify(NOTE_A)}); await app.vault.process(f, (d) => d + '\\nMy own follow-up.\\n'); p.service.resetCursors(); })()`);
		await syncNow();
		expect(await lastNotice()).toContain('0 new notes');
		expect(await readNote(NOTE_A)).toContain('My own follow-up.');
	});

	it('a deleted note is not made again, and Forget deleted notes brings it back', async function () {
		await inApp(`(async () => { await app.vault.delete(app.vault.getFileByPath(${JSON.stringify(NOTE_A)})); p.service.resetCursors(); })()`);
		await syncNow();
		expect(await lastNotice()).toContain('1 skipped because you deleted it');
		expect(await readNote(NOTE_A)).toBeNull();
		await browser.executeObsidianCommand(`${pluginId}:forget-deleted`);
		await browser.waitUntil(async () => (await lastNotice()).includes('forgot 1 deleted note'), { timeout: 5000 });
		await browser.executeObsidianCommand(`${pluginId}:reset-cursor`);
		await syncNow();
		expect(await readNote(NOTE_A)).not.toBeNull();
	});

	it('a rejected key gives a clear notice and keeps the cursor', async function () {
		const cursor = await inApp<string | null>('p.service.state.cursors.fathom.since');
		await inApp(`(() => { st.mode = '401'; })()`);
		await syncNow();
		expect(await lastNotice()).toContain('did not accept the API key');
		expect(await inApp<string | null>('p.service.state.cursors.fathom.since')).toBe(cursor);
		await inApp(`(() => { st.mode = 'ok'; })()`);
	});

	it('the settings tab shows the keys, folder, file name and the Pro group', async function () {
		await inApp(`(() => { app.setting.open(); app.setting.openTabById('call-notes-sync'); return 'ok'; })()`);
		const read = (): Promise<string[]> => inApp<string[]>(`Array.from(app.setting.activeTab.containerEl.querySelectorAll('.setting-item-name')).map((e) => e.textContent ?? '')`);
		await browser.waitUntil(async () => (await read()).length >= 12, { timeout: 10000, timeoutMsg: 'the settings tab drew no items' });
		const names = await read();
		for (const want of ['Fathom API key', 'Check Fathom key', 'Folder', 'File name', 'Sync now', 'Forget deleted notes', 'Start from the beginning', 'Status']) expect(names).toContain(want);
		expect(names.some((n) => n.startsWith('Transcript with speaker labels'))).toBe(true);
		await inApp(`(() => { app.setting.close(); return 'ok'; })()`);
	});

	it('check connection sends one request and says Fathom accepted the key', async function () {
		await inApp(`(() => { document.querySelectorAll('.notice').forEach((n) => n.remove()); st.calls = []; return p.checkConnection(); })()`);
		await browser.waitUntil(async () => (await lastNotice()).includes('Fathom accepted the key.'), { timeout: 5000 });
		expect(await inApp<Call[]>('st.calls')).toHaveLength(1);
	});

	it('Pro: the transcript, the filters, the template and the daily note link', async function () {
		await inApp(`(async () => { await st.reset(); st.setPro(true); p.settings.transcript = true; p.settings.filterParticipants = 'chen'; p.settings.dailyOn = true; p.settings.dailyFolder = 'Daily'; await app.vault.createFolder('Daily').catch(() => undefined); await app.vault.create('Daily/2026-10-05.md', '# Monday\\n'); return 'ok'; })()`);
		await syncNow();
		expect(await lastNotice()).toContain('Fetched 5 meetings: 3 new notes, 2 left out by your filters, 1 linked in daily notes.');
		const a = (await readNote(NOTE_A)) ?? '';
		expect(a).toContain('## Transcript\n\n**Maria Lopez** (0:03): Let us start with the import screen.');
		expect(a).toContain('**Sam Okoye** (0:15): The date bug is the last blocker. I can fix it today.');
		const at = new Date('2026-10-05T12:01:00Z');
		const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
		expect(await readNote('Daily/2026-10-05.md')).toContain(`## Meetings\n\n- ${hhmm} [[2026-10-05 Weekly product sync]]`);
		const calls = await inApp<Call[]>('st.calls');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.payload).toContain('include_transcript=true');
	});

	it('Pro off again: new notes have no transcript and the filters stop', async function () {
		await inApp(`(async () => { await st.reset(); st.setPro(false); await app.vault.delete(app.vault.getFileByPath('Daily/2026-10-05.md')); return 'ok'; })()`);
		await syncNow();
		expect(await lastNotice()).toContain('Fetched 5 meetings: 5 new notes.');
		expect(await readNote(NOTE_A)).not.toContain('## Transcript');
		await inApp(`(async () => { await st.reset(); p.settings.filterParticipants = ''; p.settings.dailyOn = false; return 'ok'; })()`);
	});
});
