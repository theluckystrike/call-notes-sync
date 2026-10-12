import { Notice, Plugin } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { MeetingClient, obsidianHttp } from './client';
import { NO_FILTERS, PROVIDER_LABEL } from './logic';
import { SPONSORS, bindPro, isPro, resetPro } from './pro';
import { DEFAULT_SETTINGS, CallNotesSyncSettingTab, normalizeSettings, type CallNotesSyncSettings } from './settings';
import { PROVIDERS, SyncService, emptyState, normalizeState, type SyncOptions } from './sync';

const SAVE_DELAY_MS = 800;
/** How often to ask the Pro state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;
const NAME = 'Call Notes Sync';

export default class CallNotesSyncPlugin extends Plugin {
	settings: CallNotesSyncSettings = { ...DEFAULT_SETTINGS };
	service: SyncService = this.makeService(emptyState());
	/** GitHub Sponsors manager. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	private settingTab: CallNotesSyncSettingTab | null = null;
	private saveTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadAll();
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
		});
		this.settingTab = new CallNotesSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addRibbonIcon('mic', `${NAME}: sync now`, () => void this.syncNow());
		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow() });
		this.addCommand({ id: 'forget-deleted', name: 'Forget deleted notes', callback: () => this.forgetDeleted() });
		this.addCommand({ id: 'reset-cursor', name: 'Start from the beginning', callback: () => this.resetCursors() });
		this.registerEvent(this.app.vault.on('delete', (f) => this.service.noteDeleted(f.path)));
		this.registerEvent(this.app.vault.on('rename', (f, old) => this.service.noteRenamed(old, f.path)));
	}

	onunload(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		void this.saveNow();
		resetPro();
	}

	private makeService(state: ReturnType<typeof emptyState>): SyncService {
		const client = new MeetingClient({ getKey: () => this.key(), http: obsidianHttp });
		return new SyncService(
			{
				app: this.app,
				client,
				options: () => this.options(),
				now: () => Date.now(),
				tz: (iso) => -new Date(iso).getTimezoneOffset(),
				sleep: (ms) => new Promise((r) => window.setTimeout(r, ms)),
				save: () => this.scheduleSave(),
			},
			state,
		);
	}

	/** The options of one sync. Pro settings count only while Pro is on. */
	options(): SyncOptions {
		const s = this.settings;
		const pro = isPro();
		return {
			providers: this.key() === null ? [] : PROVIDERS,
			folder: s.folder,
			template: s.template,
			transcript: pro && s.transcript,
			body: pro ? s.body : '',
			tags: pro ? s.tags : '',
			props: pro ? s.props : '',
			filters: pro ? { from: s.filterFrom, to: s.filterTo, participants: s.filterParticipants } : NO_FILTERS,
			daily: pro && s.dailyOn ? { folder: s.dailyFolder, format: s.dailyFormat, heading: s.dailyHeading } : null,
		};
	}

	/** An API key from Obsidian secret storage. It is read for each request and never kept or logged. */
	private key(): string | null {
		try {
			const t = this.app.secretStorage.getSecret(this.settings.fathomSecretId);
			return t && t.trim() ? t.trim() : null;
		} catch {
			return null;
		}
	}

	private async loadAll(): Promise<void> {
		const raw = (await this.loadData()) as { settings?: Partial<CallNotesSyncSettings>; state?: unknown } | null;
		this.settings = normalizeSettings(raw?.settings);
		this.service = this.makeService(normalizeState(raw?.state));
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, SAVE_DELAY_MS);
	}

	private async saveNow(): Promise<void> {
		await this.saveData({ settings: this.settings, state: this.service.state });
	}

	async persist(): Promise<void> {
		await this.saveNow();
	}

	/** One sync with a notice for the result. */
	async syncNow(): Promise<void> {
		const busy = new Notice(`${NAME}: syncing...`, 0);
		try {
			const r = await this.service.run();
			busy.hide();
			new Notice(`${NAME}: ${r.message}`, 8000);
		} finally {
			busy.hide();
			this.settingTab?.update();
		}
	}

	forgetDeleted(): void {
		const n = this.service.forgetDeleted();
		new Notice(`${NAME}: forgot ${n} deleted ${n === 1 ? 'note' : 'notes'}.`);
		this.settingTab?.update();
	}

	resetCursors(): void {
		this.service.resetCursors();
		new Notice(`${NAME}: the next sync starts from the beginning of your history.`);
		this.settingTab?.update();
	}

	/** Asks Fathom whether it accepts the key. */
	async checkConnection(): Promise<void> {
		const r = await this.service.deps.client.check('fathom');
		new Notice(`${NAME}: ${r.ok ? r.data : r.message}`, 8000);
		if (!r.ok && r.kind === 'no-key') new Notice(`${NAME}: no ${PROVIDER_LABEL.fathom} key is saved.`, 4000);
	}
}
