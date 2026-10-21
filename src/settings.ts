import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import {
	DEFAULT_BODY,
	DEFAULT_DAILY_FORMAT,
	DEFAULT_DAILY_HEADING,
	DEFAULT_FOLDER,
	DEFAULT_TEMPLATE,
	formatDate,
	normalizeDay,
	normalizeFolder,
	normalizeTemplate,
	renderFileName,
	type Meeting,
} from './logic';
import { PRO_UI, isPro } from './pro';
import type CallNotesSyncPlugin from './main';
import { helloSettingItems } from './hello/settings';

export interface CallNotesSyncSettings {
	/** Name of the secret in Obsidian secret storage. The key itself is never in data.json. */
	fathomSecretId: string;
	folder: string;
	template: string;
	// Pro settings. They have no effect while Pro is off.
	transcript: boolean;
	body: string;
	tags: string;
	props: string;
	filterFrom: string;
	filterTo: string;
	filterParticipants: string;
	dailyOn: boolean;
	dailyFolder: string;
	dailyFormat: string;
	dailyHeading: string;
}

export const DEFAULT_FATHOM_SECRET = 'call-notes-sync-fathom-key';

export const DEFAULT_SETTINGS: CallNotesSyncSettings = {
	fathomSecretId: DEFAULT_FATHOM_SECRET,
	folder: DEFAULT_FOLDER,
	template: DEFAULT_TEMPLATE,
	transcript: true,
	body: DEFAULT_BODY,
	tags: '',
	props: '',
	filterFrom: '',
	filterTo: '',
	filterParticipants: '',
	dailyOn: false,
	dailyFolder: '',
	dailyFormat: DEFAULT_DAILY_FORMAT,
	dailyHeading: DEFAULT_DAILY_HEADING,
};

const secretId = (v: unknown, fallback: string): string => (typeof v === 'string' && /^[a-z0-9-]+$/.test(v) ? v : fallback);
const text = (v: unknown, fallback: string, max: number): string => (typeof v === 'string' ? v.slice(0, max) : fallback);

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<CallNotesSyncSettings> | null | undefined): CallNotesSyncSettings {
	const s = saved ?? {};
	const heading = typeof s.dailyHeading === 'string' && /^#{1,6}\s+\S/.test(s.dailyHeading.trim()) ? s.dailyHeading.trim().slice(0, 80) : DEFAULT_DAILY_HEADING;
	return {
		fathomSecretId: secretId(s.fathomSecretId, DEFAULT_FATHOM_SECRET),
		// An empty folder is the vault root. A missing value is the default folder.
		folder: typeof s.folder === 'string' ? normalizeFolder(s.folder) : DEFAULT_FOLDER,
		template: typeof s.template === 'string' ? normalizeTemplate(s.template) : DEFAULT_TEMPLATE,
		transcript: typeof s.transcript === 'boolean' ? s.transcript : true,
		body: text(s.body, DEFAULT_BODY, 20_000),
		tags: text(s.tags, '', 500),
		props: text(s.props, '', 5_000),
		filterFrom: typeof s.filterFrom === 'string' ? normalizeDay(s.filterFrom) : '',
		filterTo: typeof s.filterTo === 'string' ? normalizeDay(s.filterTo) : '',
		filterParticipants: text(s.filterParticipants, '', 500),
		dailyOn: typeof s.dailyOn === 'boolean' ? s.dailyOn : false,
		dailyFolder: typeof s.dailyFolder === 'string' ? normalizeFolder(s.dailyFolder) : '',
		dailyFormat: typeof s.dailyFormat === 'string' && s.dailyFormat.trim() !== '' ? s.dailyFormat.trim().slice(0, 60) : DEFAULT_DAILY_FORMAT,
		dailyHeading: heading,
	};
}

const SAMPLE: Meeting = {
	provider: 'fathom',
	id: 'sample',
	title: 'Weekly sync',
	date: '2026-10-08T09:00:00Z',
	durationMin: 30,
	participants: [],
	summary: '',
	actionItems: [],
	url: '',
	transcript: null,
};

export class CallNotesSyncSettingTab extends PluginSettingTab {
	plugin: CallNotesSyncPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: CallNotesSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		this.plugin.settings = normalizeSettings({ ...this.plugin.settings, [key]: value });
		await this.plugin.persist();
	}

	private statusText(): string {
		const st = this.plugin.service.state;
		const last = st.lastSync === null ? 'never' : st.lastSync.replace('T', ' ').slice(0, 19) + ' UTC';
		return `Last sync: ${last}. Notes made by the plugin: ${Object.keys(st.meetings).length}. Deleted notes that are not made again: ${st.deleted.length}.`;
	}

	private proGroup(): SettingDefinitionItem {
		const s = this.plugin.settings;
		const on = isPro();
		const tag = on ? '' : ' (Pro)';
		return {
			type: 'group',
			heading: on ? 'Pro features' : 'Pro features (off until you sponsor)',
			items: [
				{ name: `Transcript with speaker labels${tag}`, desc: 'Writes the full transcript under the action items. The transcript makes each Fathom answer larger, so a sync with it is slower.', control: { type: 'toggle', key: 'transcript', defaultValue: true } },
				{
					name: `Note template${tag}`,
					desc: 'The body of each new note. Tokens: {{header}}, {{summary}}, {{actions}}, {{transcript}}, {{title}}, {{date}}, {{time}}, {{duration}}, {{participants}}, {{link}}, {{source}}, {{id}}. Notes that exist do not change.',
					control: { type: 'textarea', key: 'body', defaultValue: DEFAULT_BODY },
				},
				{ name: `Tags${tag}`, desc: 'Tags for the properties of each new note. Separate them with commas or spaces. A "#" is optional. Empty: no tags.', control: { type: 'text', key: 'tags', defaultValue: '', placeholder: 'meeting, calls/fathom' } },
				{
					name: `Extra properties${tag}`,
					desc: 'One "name: value" for each line, added to the properties of each new note. Tokens: {{title}}, {{date}}, {{time}}, {{duration}}, {{participants}}, {{participant_links}}, {{link}}, {{source}}, {{id}}. {{participants}} or {{participant_links}} alone as the value makes a list. {{participant_links}} gives [[wiki links]] to person notes. A line with a built in name is left out.',
					control: { type: 'textarea', key: 'props', defaultValue: '', placeholder: 'type: call\nattendees: {{participant_links}}\nreviewed: false', rows: 4 },
				},
				{ name: `Only meetings from${tag}`, desc: 'Date as YYYY-MM-DD. Meetings before it are left out. Empty: no limit.', control: { type: 'text', key: 'filterFrom', defaultValue: '', placeholder: '2026-01-01', validate: (v: string) => (v.trim() === '' || normalizeDay(v) !== '' ? undefined : 'Use YYYY-MM-DD.') } },
				{ name: `Only meetings until${tag}`, desc: 'Date as YYYY-MM-DD. Meetings after it are left out. Empty: no limit.', control: { type: 'text', key: 'filterTo', defaultValue: '', placeholder: '2026-12-31', validate: (v: string) => (v.trim() === '' || normalizeDay(v) !== '' ? undefined : 'Use YYYY-MM-DD.') } },
				{ name: `Only meetings with${tag}`, desc: 'Names or emails, separated by commas. A meeting stays when one participant contains one of them. Empty: all meetings.', control: { type: 'text', key: 'filterParticipants', defaultValue: '', placeholder: 'maria, ops@example.com' } },
				{ name: `Link in the daily note${tag}`, desc: 'Adds a line with a link to each new note in the daily note of the meeting day. It never makes a daily note.', control: { type: 'toggle', key: 'dailyOn', defaultValue: false } },
				{ name: 'Daily note folder', desc: 'Folder of your daily notes. Empty: the vault root.', control: { type: 'text', key: 'dailyFolder', defaultValue: '', placeholder: 'Daily' } },
				{ name: 'Daily note name', desc: `Date format of your daily note names. Supported: YYYY, YY, MMMM, MMM, MM, M, DD, D, dddd, ddd and [text]. Now: "${formatDate(SAMPLE.date, s.dailyFormat, 0)}".`, control: { type: 'text', key: 'dailyFormat', defaultValue: DEFAULT_DAILY_FORMAT, placeholder: DEFAULT_DAILY_FORMAT } },
				{ name: 'Daily note heading', desc: 'The line links go under. It is added at the end of the daily note when it is missing.', control: { type: 'text', key: 'dailyHeading', defaultValue: DEFAULT_DAILY_HEADING, placeholder: DEFAULT_DAILY_HEADING } },
			],
		};
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		const example = renderFileName(this.plugin.settings.template, SAMPLE, 0);
		return [
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{
				name: 'Fathom API key',
				desc: 'Make it in Fathom, User Settings, API Access. It is kept in Obsidian secret storage, not in a note or in data.json. It is sent to api.fathom.ai, and to no other host. Without a key the plugin sends no request.',
				control: { type: 'secret', key: 'fathomSecretId', defaultValue: DEFAULT_FATHOM_SECRET },
			},
			{ name: 'Check Fathom key', desc: 'Sends 1 request to Fathom to test the key.', action: () => void this.plugin.checkConnection().then(() => this.update()) },
			{ name: 'Folder', desc: 'The folder for the meeting notes. It is made when needed. Leave it empty for the vault root.', control: { type: 'text', key: 'folder', defaultValue: DEFAULT_FOLDER, placeholder: DEFAULT_FOLDER } },
			{
				name: 'File name',
				desc: `Template for the note name. Tokens: {title}, {date}, {time}, {source} and {id} (short hash). Now: "${example}". A note name is fixed when the note is made.`,
				control: { type: 'text', key: 'template', defaultValue: DEFAULT_TEMPLATE, placeholder: DEFAULT_TEMPLATE },
			},
			{ name: 'Sync now', desc: 'Gets new meetings from Fathom.', action: () => void this.plugin.syncNow().then(() => this.update()) },
			{ name: 'Forget deleted notes', desc: 'The plugin does not make a note again that you deleted. This clears that list, so the next sync can make those notes again, if the meeting is in the sync window.', action: () => this.plugin.forgetDeleted() },
			{ name: 'Start from the beginning', desc: 'The next sync asks for the whole history again. Notes that exist are kept and not made twice.', action: () => this.plugin.resetCursors() },
			this.proGroup(),
			{ name: 'Status', desc: this.statusText() },
		];
	}
}
