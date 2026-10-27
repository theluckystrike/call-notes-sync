import { browser, expect } from '@wdio/globals';
import type { SponsorsManager } from '../../src/license/index';
import { pluginId } from './load';

// A free user can select the Pro settings. The select shows the shared Pro notice with the "Sponsor on GitHub" button.
// The toggle shows off again and nothing is saved. The other Pro rows have unit tests (tests/pro-notice.test.ts).
// A Pro user turns the same toggle off and the choice is saved.
type Plugin = { pro: SponsorsManager; settings: Record<string, unknown>; loadData(): Promise<unknown>; persist(): Promise<void> };
type Host = { plugins: { plugins: Record<string, Plugin> }; setting: { open(): void; close(): void; openTabById(id: string): void } };
const TRANSCRIPT = 'Transcript with speaker labels';

async function setPro(on: boolean): Promise<boolean> {
	return browser.executeObsidian(async ({ app }, enabled, id) => {
		const pro = (app as unknown as Host).plugins.plugins[id]!.pro;
		// Remove a test override of isPro from another spec, so the real Sponsors state counts.
		delete (pro as unknown as Record<string, unknown>).isPro;
		if (!enabled) { pro.signOut(); return pro.isPro(); }
		// Synthetic token store and HTTP answer. No network request or Keychain key.
		let token: string | null = 'gho_' + '0'.repeat(36);
		pro.opts.tokens.get = () => token; pro.opts.tokens.set = (v) => { token = v; }; pro.opts.tokens.clear = () => { token = null; };
		pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader', totalSponsorshipAmountAsSponsorInCents: 1500 }, user: { viewerIsSponsoring: true, sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		await pro.refreshNow();
		return pro.isPro();
	}, on, pluginId);
}

async function openTab(): Promise<void> {
	await browser.executeObsidian(({ app }, id) => {
		activeDocument.querySelectorAll('.notice').forEach((n) => n.remove());
		const s = (app as unknown as Host).setting; s.open(); s.openTabById(id);
	}, pluginId);
	await browser.waitUntil(async () => browser.executeObsidian(() => [...activeDocument.querySelectorAll('.setting-item-name')].some((e) => e.textContent?.startsWith('Transcript with speaker labels'))), { timeout: 10000, timeoutMsg: 'The settings tab drew no Pro group' });
}

/** Clicks the toggle of the row whose name starts with this text, then reads the toggle, the notices and the saved data. */
async function read(click: string | null) {
	return browser.executeObsidian(async ({ app }, click, id) => {
		const row = (n: string) => [...activeDocument.querySelectorAll('.setting-item')].find((r) => r.querySelector('.setting-item-name')?.textContent?.startsWith(n));
		if (click) {
			const t = row(click)?.querySelector('.checkbox-container') as HTMLElement | null;
			t?.focus(); t?.click();
		}
		await new Promise((r) => setTimeout(r, 400));
		const p = (app as unknown as Host).plugins.plugins[id]!;
		return {
			on: row('Transcript with speaker labels')?.querySelector('.checkbox-container')?.classList.contains('is-enabled') ?? null,
			notices: [...activeDocument.querySelectorAll('.notice')].map((n) => ({ text: n.textContent ?? '', sponsor: n.querySelectorAll('.pf-pro-notice-sponsor').length })),
			settings: JSON.stringify(p.settings),
			saved: JSON.stringify((await p.loadData()) ?? {}),
		};
	}, click, pluginId);
}

describe('Pro settings', function () {
	let original = '';
	before(async () => {
		original = await browser.executeObsidian(({ app }, id) => JSON.stringify((app as unknown as Host).plugins.plugins[id]!.settings), pluginId);
	});
	afterEach(async () => {
		await browser.executeObsidian(async ({ app }, id, original) => {
			(app as unknown as Host).setting.close();
			const p = (app as unknown as Host).plugins.plugins[id]!;
			p.settings = JSON.parse(original) as Record<string, unknown>;
			await p.persist();
		}, pluginId, original);
		await setPro(false);
	});

	it('a free user who selects the transcript toggle gets a Pro notice with a Sponsor button, the toggle shows off and nothing is saved', async () => {
		expect(await setPro(false)).toBe(false);
		await openTab();
		const before = await read(null);
		// Without Pro the transcript is off in effect, so the toggle shows off.
		expect(before.on).toBe(false);
		const toggle = await read(TRANSCRIPT);
		if (!toggle.notices.some((n) => n.text.includes('The transcript with speaker labels needs Pro.') && n.sponsor === 1)) throw new Error(`No Pro notice after the transcript toggle: ${JSON.stringify(toggle.notices)}`);
		expect(toggle.on).toBe(false);
		expect(toggle.settings).toBe(before.settings);
		expect(toggle.saved).toBe(before.saved);
	});

	it('a Pro user who selects the transcript toggle turns it off and the choice is saved', async () => {
		expect(await setPro(true)).toBe(true);
		await browser.executeObsidian(({ app }, id) => { (app as unknown as Host).plugins.plugins[id]!.settings.transcript = true; }, pluginId);
		await openTab();
		const before = await read(null);
		expect(before.on).toBe(true);
		const after = await read(TRANSCRIPT);
		expect(after.on).toBe(false);
		expect(JSON.parse(after.settings).transcript).toBe(false);
		expect(after.notices.filter((n) => n.sponsor > 0)).toEqual([]);
	});
});
