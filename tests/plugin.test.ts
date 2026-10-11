import { afterEach, describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import CallNotesSyncPlugin from '../src/main';
import { CallNotesSyncSettingTab, DEFAULT_FATHOM_SECRET, DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';
import { SPONSORS, bindPro, isPro, onProChange, resetPro } from '../src/pro';
import manifest from '../manifest.json';

afterEach(() => resetPro());

async function load(): Promise<CallNotesSyncPlugin> {
	const app = App.createConfigured__({ files: {} });
	const plugin = new CallNotesSyncPlugin(app as never, manifest as never);
	await plugin.onload();
	return plugin;
}

const fakeManager = (on: boolean): { isPro: () => boolean; onChange: (cb: () => void) => () => void; fire: () => void } => {
	const cbs = new Set<() => void>();
	return { isPro: () => on, onChange: (cb) => (cbs.add(cb), () => cbs.delete(cb)), fire: () => cbs.forEach((c) => c()) };
};

describe('CallNotesSyncPlugin', () => {
	it('loads with default settings, no keys and a Pro manager that is off', async () => {
		const plugin = await load();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(plugin.pro).not.toBeNull();
		expect(isPro()).toBe(false);
		expect(plugin.options().providers).toEqual([]);
	});

	it('Fathom is on only when its key is in secret storage', async () => {
		const plugin = await load();
		expect(plugin.options().providers).toEqual([]);
		plugin.app.secretStorage.setSecret(DEFAULT_FATHOM_SECRET, '  fa-key  ');
		expect(plugin.options().providers).toEqual(['fathom']);
		plugin.app.secretStorage.setSecret(DEFAULT_FATHOM_SECRET, '   ');
		expect(plugin.options().providers).toEqual([]);
	});

	it('without Pro the Pro settings have no effect', async () => {
		const plugin = await load();
		plugin.settings = normalizeSettings({ ...plugin.settings, transcript: true, body: 'X {{title}}', filterFrom: '2026-01-01', filterParticipants: 'zed', dailyOn: true });
		const o = plugin.options();
		expect(o).toMatchObject({ transcript: false, body: '', daily: null, filters: { from: '', to: '', participants: '' } });
	});

	it('with Pro the Pro settings count', async () => {
		const plugin = await load();
		bindPro(fakeManager(true) as never);
		plugin.settings = normalizeSettings({ ...plugin.settings, transcript: true, body: 'X {{title}}', filterFrom: '2026-01-01', filterParticipants: 'zed', dailyOn: true, dailyFolder: 'Daily' });
		const o = plugin.options();
		expect(o.transcript).toBe(true);
		expect(o.body).toBe('X {{title}}');
		expect(o.filters).toEqual({ from: '2026-01-01', to: '', participants: 'zed' });
		expect(o.daily).toEqual({ folder: 'Daily', format: 'YYYY-MM-DD', heading: '## Meetings' });
	});

	it('remembers a note that you delete in the vault', async () => {
		const plugin = await load();
		plugin.service.deps.client.deps.http = () =>
			Promise.resolve({ status: 200, json: { items: [{ recording_id: 'aaaa1', meeting_title: 'A', recording_start_time: '2026-10-08T09:00:00Z', default_summary: { markdown_formatted: 'x' } }], next_cursor: null }, headers: {} });
		plugin.app.secretStorage.setSecret(DEFAULT_FATHOM_SECRET, 'fa-key');
		expect((await plugin.service.run()).created).toBe(1);
		const f = plugin.app.vault.getFileByPath('Meetings/2026-10-08 A.md');
		expect(f).not.toBeNull();
		await plugin.app.vault.delete(f as never);
		expect(plugin.service.state.deleted).toEqual(['fathom:aaaa1']);
	});

	it('syncNow runs a sync and shows the result', async () => {
		const plugin = await load();
		plugin.service.deps.client.deps.http = () => Promise.resolve({ status: 200, json: { items: [], next_cursor: null }, headers: {} });
		plugin.app.secretStorage.setSecret(DEFAULT_FATHOM_SECRET, 'fa-key');
		await plugin.syncNow();
		expect(plugin.service.state.lastSync).not.toBeNull();
		expect(plugin.service.running).toBe(false);
	});

	it('lists its settings, with the Pro group', async () => {
		const plugin = await load();
		const tab = new CallNotesSyncSettingTab(plugin.app, plugin);
		const names = tab.getSettingDefinitions().flatMap((d) => ('items' in d ? d.items.map((i) => (i as { name: string }).name) : [(d as { name?: string }).name ?? '']));
		for (const want of ['Fathom API key', 'Check Fathom key', 'Folder', 'File name', 'Sync now', 'Forget deleted notes', 'Start from the beginning', 'Status']) expect(names).toContain(want);
		expect(names.some((n) => n.startsWith('Transcript with speaker labels'))).toBe(true);
	});
});

describe('settings and Pro facade', () => {
	it('normalizes bad values', () => {
		const s = normalizeSettings({ fathomSecretId: 'Bad Id!', folder: '../x/', template: '', filterFrom: '2026-02-30', dailyHeading: 'no hashes', dailyFormat: ' ', body: 5 as never });
		expect(s.fathomSecretId).toBe(DEFAULT_FATHOM_SECRET);
		expect(s.folder).toBe('x');
		expect(s.template).toBe('{date} {title}');
		expect(s.filterFrom).toBe('');
		expect(s.dailyHeading).toBe('## Meetings');
		expect(s.dailyFormat).toBe('YYYY-MM-DD');
		expect(s.body).toBe(DEFAULT_SETTINGS.body);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
	});

	it('the facade follows the manager and tells listeners', () => {
		const m = fakeManager(false);
		let calls = 0;
		const off = onProChange(() => calls++);
		bindPro(m as never);
		expect(isPro()).toBe(false);
		m.fire();
		expect(calls).toBe(1);
		off();
		m.fire();
		expect(calls).toBe(1);
		expect(SPONSORS.sponsorLogin).toBe('theluckystrike');
	});
});
