import { $, browser, expect } from '@wdio/globals';
import { pluginId } from './load';

// Keyboard focus after a refused Pro setting (s1028 FOCUS). A free user changes a Pro control with a real key. The
// plugin refuses the change, shows the Pro notice and draws the tab again. The keyboard focus must stay on the control
// of the same row. Obsidian can open the settings in a second window (activeWindow), so the test sends the keys to the
// window that shows the settings tab.
const ROW = 'Link in the daily note (Pro)';

type Host = {
	plugins: { plugins: Record<string, Record<string, unknown>> };
	setting: { open(): void; close(): void; openTabById(id: string): void };
};

interface Where {
	hasFocus: boolean;
	tag: string;
	row: string | null;
	value: string | null;
	notices: number;
}

/** Runs in the window that shows the settings: where the keyboard focus is, and the state of the row control. */
const where = (): Promise<Where> =>
	browser.execute((name: string) => {
		const a = document.activeElement as HTMLElement | null;
		const row = [...document.querySelectorAll('.setting-item')].find((r) => r.querySelector('.setting-item-name')?.textContent === name);
		const control = row?.querySelector<HTMLSelectElement | HTMLInputElement>('select, input');
		const docs = new Set([document, (window as unknown as { activeDocument?: Document }).activeDocument ?? document]);
		return {
			hasFocus: document.hasFocus(),
			tag: a ? a.tagName.toLowerCase() : '',
			row: a?.closest('.setting-item')?.querySelector('.setting-item-name')?.textContent ?? null,
			value: control ? (control.tagName === 'INPUT' ? String((control as HTMLInputElement).checked) : control.value) : null,
			notices: [...docs].reduce((n, d) => n + d.querySelectorAll('.notice').length, 0),
		};
	}, ROW);

describe(`${pluginId} keyboard focus after a refused Pro setting`, function () {
	let main = '';
	after(async function () {
		if (main) await browser.switchToWindow(main);
		await browser.executeObsidian(({ app }) => {
			(app as unknown as Host).setting.close();
			activeDocument.querySelectorAll('.notice').forEach((n) => n.remove());
		});
	});

	it(`a free user who changes "${ROW}" with a key keeps the keyboard focus on that control (desktop only: phone and tablet have no keyboard focus ring)`, async function () {
		if (await browser.executeObsidian(({ obsidian }) => obsidian.Platform.isMobile)) this.skip();
		main = await browser.getWindowHandle();
		// A free user: sign out of each Pro manager of the plugin, then open the settings tab of the plugin.
		await browser.executeObsidian(({ app }, id) => {
			const plugin = (app as unknown as Host).plugins.plugins[id]!;
			for (const value of Object.values(plugin)) {
				const signOut = (value as { signOut?: unknown } | null)?.signOut;
				if (typeof signOut === 'function') (signOut as () => void).call(value);
			}
			activeDocument.querySelectorAll('.notice').forEach((n) => n.remove());
			const setting = (app as unknown as Host).setting;
			setting.open();
			setting.openTabById(id);
		}, pluginId);
		await browser.waitUntil(
			async () => browser.executeObsidian((_o, name) => [...activeDocument.querySelectorAll('.setting-item-name')].some((e) => e.textContent === name), ROW),
			{ timeout: 10000, timeoutMsg: `The settings tab has no row "${ROW}".` },
		);
		await browser.pause(500);
		// Send the keys to the window that shows the row.
		let found = '';
		for (const handle of await browser.getWindowHandles()) {
			await browser.switchToWindow(handle);
			const has = await browser.execute((name: string) => [...document.querySelectorAll('.setting-item-name')].some((e) => e.textContent === name), ROW);
			if (has) {
				found = handle;
				break;
			}
		}
		expect(found).not.toBe('');
		// Put the keyboard focus on the control of the row. Then check that this window has the focus, so a real key goes there.
		// The key: Space for a toggle. For a dropdown, the first letter or digit of another option (type-ahead), sent
		// with WebDriver Element Send Keys (probe run 40628437449). The controls can come from another window realm, so
		// the test checks tagName, not instanceof.
		const key = await browser.execute((name: string) => {
			const row = [...document.querySelectorAll('.setting-item')].find((r) => r.querySelector('.setting-item-name')?.textContent === name)!;
			const control = row.querySelector<HTMLElement>('select, .checkbox-container')!;
			control.focus();
			document.querySelectorAll('[data-focus-test]').forEach((e) => e.removeAttribute('data-focus-test'));
			control.setAttribute('data-focus-test', '1');
			document.querySelectorAll('.notice').forEach((n) => n.remove());
			if (control.tagName !== 'SELECT') return '\uE00D';
			const select = control as HTMLSelectElement;
			const first = (o: HTMLOptionElement | undefined): string => (o?.text.trim()[0] ?? '').toLowerCase();
			const current = first(select.options[select.selectedIndex]);
			const other = [...select.options].map(first).find((c) => /^[a-z0-9]$/.test(c) && c !== current);
			if (!other) throw new Error(`No option of "${name}" starts with another letter or digit.`);
			return other;
		}, ROW);
		const before = await where();
		expect({ hasFocus: before.hasFocus, row: before.row }).toEqual({ hasFocus: true, row: ROW });
		// A real key changes the control. The plugin refuses the change and shows the Pro notice.
		await $('[data-focus-test="1"]').addValue(key);
		await browser
			.waitUntil(async () => (await where()).notices > 0, { timeout: 5000 })
			.catch(() => undefined);
		await browser.pause(500);
		const after = await where();
		expect({ notices: after.notices > 0, value: after.value }).toEqual({ notices: true, value: before.value });
		// Obsidian drew the tab again. The keyboard focus is still on the control of the same row.
		expect({ tag: after.tag, row: after.row }).toEqual({ tag: before.tag, row: ROW });
	});
});
