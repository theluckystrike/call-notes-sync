import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, Notice } from 'obsidian-test-mocks/obsidian';
import type { SponsorsManager } from '../src/license/index';
import CallNotesSyncPlugin from '../src/main';
import { CallNotesSyncSettingTab } from '../src/settings';
import { DEFAULT_BODY } from '../src/logic';
import { PRO_LEADS, bindPro, resetPro } from '../src/pro';
import manifest from '../manifest.json';

// A free user can select the Pro settings. Each one shows the shared Pro notice with the "Sponsor on GitHub" button.
// Nothing is saved, and the control shows the value in effect without Pro.
const PITCH = 'Sponsor on GitHub, then sign in from the plugin settings.';

function fakePro(pro: boolean): SponsorsManager {
	return {
		isPro: () => pro,
		onChange: () => () => undefined,
		hasToken: () => false,
		isChecking: () => false,
		getState: () => ({ status: 'unchecked', lastAttemptAt: 0 }),
		config: { sponsorLogin: 'theluckystrike', source: 'call-notes-sync' },
	} as unknown as SponsorsManager;
}

async function setup(pro: boolean) {
	const app = App.createConfigured__({ files: {} });
	const plugin = new CallNotesSyncPlugin(app as never, manifest as never);
	await plugin.onload();
	bindPro(fakePro(pro));
	plugin.persist = vi.fn(async () => undefined);
	const shown: { text: string; buttons: number }[] = [];
	vi.spyOn(Notice.prototype as unknown as { constructor__(): void }, 'constructor__').mockImplementation(function (this: Notice) {
		shown.push({ text: this.messageEl.textContent ?? '', buttons: this.messageEl.querySelectorAll('.pf-pro-notice-sponsor').length });
		// A shown notice is in the document until it hides.
		document.body.append(this.messageEl);
	});
	const tab = new CallNotesSyncSettingTab(plugin.app, plugin);
	const update = vi.spyOn(tab, 'update').mockImplementation(() => undefined);
	return { plugin, tab, shown, update };
}

const CHANGES: [string, unknown][] = [
	['transcript', false],
	['body', 'My {{summary}}'],
	['tags', 'meeting'],
	['props', 'type: call'],
	['filterFrom', '2026-01-01'],
	['filterTo', '2026-12-31'],
	['filterParticipants', 'maria'],
	['dailyOn', true],
];

describe('Pro settings', () => {
	afterEach(() => { resetPro(); vi.restoreAllMocks(); document.body.empty(); });

	it('a free user who selects a Pro setting gets the Pro notice with a Sponsor button, nothing is saved, and the control shows the value in effect', async () => {
		const { plugin, tab, shown, update } = await setup(false);
		const before = JSON.stringify(plugin.settings);
		// The values in effect without Pro: no transcript, the default body, no tags, properties, filters or daily link.
		expect(CHANGES.map(([k]) => tab.getControlValue(k))).toEqual([false, DEFAULT_BODY, '', '', '', '', '', false]);
		for (const [key, value] of CHANGES) {
			document.body.empty();
			await tab.setControlValue(key, value);
		}
		expect(shown).toEqual(CHANGES.map(([key]) => ({ text: `${PRO_LEADS[key]} ${PITCH}Sponsor on GitHub`, buttons: 1 })));
		expect(update).toHaveBeenCalledTimes(CHANGES.length);
		expect(plugin.persist).not.toHaveBeenCalled();
		expect(JSON.stringify(plugin.settings)).toBe(before);
		// More keys in the same field while the notice shows give no second notice.
		await tab.setControlValue('tags', 'meetings');
		expect(shown.length).toBe(CHANGES.length);
		expect(plugin.settings.tags).toBe('');
	});

	it('a free user who types a partial date in a date filter gets no format error, so the Pro notice shows at the first key', async () => {
		const { tab } = await setup(false);
		const rows = tab.productSettingDefinitions().flatMap((d) => ((d as { items?: unknown[] }).items ?? [d]) as { name: string; control?: { validate?: (v: string) => unknown } }[]);
		for (const name of ['Only meetings from (Pro)', 'Only meetings until (Pro)']) {
			const validate = rows.find((r) => r.name === name)!.control!.validate!;
			expect(await validate('2')).toBeUndefined();
			expect(await validate('2026-13-45')).toBeUndefined();
		}
	});

	it('a Pro user who types a partial date in a date filter gets the format error', async () => {
		const { tab } = await setup(true);
		const rows = tab.productSettingDefinitions().flatMap((d) => ((d as { items?: unknown[] }).items ?? [d]) as { name: string; control?: { validate?: (v: string) => unknown } }[]);
		for (const name of ['Only meetings from', 'Only meetings until']) {
			const validate = rows.find((r) => r.name === name)!.control!.validate!;
			expect(await validate('2')).toBe('Use YYYY-MM-DD.');
			expect(await validate('2026-01-01')).toBeUndefined();
		}
	});

	it('a free user can still change the free settings', async () => {
		const { plugin, tab, shown } = await setup(false);
		await tab.setControlValue('folder', 'Calls');
		await tab.setControlValue('dailyFolder', 'Daily');
		expect(plugin.settings.folder).toBe('Calls');
		expect(plugin.settings.dailyFolder).toBe('Daily');
		expect(plugin.persist).toHaveBeenCalledTimes(2);
		expect(shown).toEqual([]);
	});

	it('a Pro user who changes the Pro settings saves them, with no Pro notice', async () => {
		const { plugin, tab, shown } = await setup(true);
		for (const [key, value] of CHANGES) await tab.setControlValue(key, value);
		expect(plugin.settings).toMatchObject(Object.fromEntries(CHANGES));
		expect(plugin.persist).toHaveBeenCalledTimes(CHANGES.length);
		expect(shown).toEqual([]);
	});
});
