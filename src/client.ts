// Fathom REST client over Obsidian requestUrl (no Node, works on phone and tablet).
// Read only: GET https://api.fathom.ai/external/v1/meetings. The API key is read from SecretStorage for each request. It is never
// stored here, logged or put in an error text.
import { requestUrl } from 'obsidian';
import { PROVIDER_LABEL, type Provider } from './logic';

export interface HttpRequest {
	provider: Provider;
	/** The query string of the GET, without the "?". */
	payload: string;
	headers: Record<string, string>;
}
export interface HttpReply {
	status: number;
	json: unknown;
	headers: Record<string, string>;
}
export type Http = (r: HttpRequest) => Promise<HttpReply>;

async function parsed(res: { status: number; json: unknown; headers: Record<string, string> }): Promise<HttpReply> {
	let json: unknown = null;
	try {
		json = res.json;
	} catch {
		json = null;
	}
	return { status: res.status, json, headers: res.headers };
}

/**
 * The network call site of the plugin. The Fathom URL starts with a literal prefix that ends the host, so the query cannot
 * change the host (tools/network-gate.mjs, product.yaml network_path_hosts). status 0 means no answer: offline.
 */
export const obsidianHttp: Http = async (r) => {
	try {
		const res = await requestUrl({ url: `https://api.fathom.ai/external/v1/meetings?${r.payload}`, method: 'GET', headers: r.headers, throw: false });
		return await parsed(res);
	} catch {
		return { status: 0, json: null, headers: {} };
	}
};

export type FailKind = 'no-key' | 'auth' | 'rate' | 'offline' | 'server' | 'http';
export type Reply<T> = { ok: true; data: T } | { ok: false; kind: FailKind; status: number; waitMs: number; message: string };

export const DEFAULT_WAIT_MS = 30_000;
export const MAX_WAIT_MS = 120_000;

const fail = (kind: FailKind, status: number, message: string, waitMs = 0): Reply<never> => ({ ok: false, kind, status, waitMs, message });

const header = (h: Record<string, string>, name: string): string | null => {
	const key = Object.keys(h).find((k) => k.toLowerCase() === name);
	return key === undefined ? null : (h[key] ?? null);
};

/** Seconds in a Retry-After header, as ms, or the default. A date form is not used. */
export function waitFrom(h: Record<string, string>): number {
	const v = Number(header(h, 'retry-after'));
	return Number.isFinite(v) && v > 0 ? Math.min(MAX_WAIT_MS, Math.round(v * 1000)) : DEFAULT_WAIT_MS;
}

const KEY_HELP = 'Make a new key in Fathom, User Settings, API Access, and save it in the settings.';

/** Turns an HTTP answer into a reply. 2xx is data. Any other answer is a failure with a text the user can act on. */
export function classify(provider: Provider, r: HttpReply): Reply<unknown> {
	const name = PROVIDER_LABEL[provider];
	if (r.status === 0) return fail('offline', 0, `No answer from ${name}. Check your connection and try again.`);
	if (r.status === 401 || r.status === 403) return fail('auth', r.status, `${name} did not accept the API key. ${KEY_HELP}`);
	if (r.status === 429) return fail('rate', 429, `${name} asked us to slow down.`, waitFrom(r.headers));
	if (r.status >= 500) return fail('server', r.status, `${name} had a server error (${r.status}). Try again later.`);
	if (r.status >= 200 && r.status < 300) return { ok: true, data: r.json };
	return fail('http', r.status, `${name} answered with status ${r.status}.`);
}

// ---------------------------------------------------------------- queries

/** The Fathom list query string: summary and action items always, the transcript when asked, a window and a cursor. */
export function fathomQuery(from: string | null, to: string | null, cursor: string | null, withTranscript: boolean): string {
	const parts = ['include_summary=true', 'include_action_items=true'];
	if (withTranscript) parts.push('include_transcript=true');
	if (from !== null) parts.push(`created_after=${encodeURIComponent(from)}`);
	if (to !== null) parts.push(`created_before=${encodeURIComponent(to)}`);
	if (cursor !== null) parts.push(`cursor=${encodeURIComponent(cursor)}`);
	return parts.join('&');
}

// ---------------------------------------------------------------- client

export interface ClientDeps {
	getKey: (p: Provider) => string | null;
	http: Http;
}

export interface PageRequest {
	provider: Provider;
	from: string | null;
	to: string | null;
	/** The cursor of the last answer. null for the first page. */
	token: string | null;
	transcript: boolean;
}

export interface MeetingPage {
	rows: unknown[];
	/** Token of the next page, or null when there is none. */
	next: string | null;
}

export class MeetingClient {
	deps: ClientDeps;

	constructor(deps: ClientDeps) {
		this.deps = deps;
	}

	private async call(provider: Provider, payload: string): Promise<Reply<unknown>> {
		const key = this.deps.getKey(provider);
		if (!key) return fail('no-key', 0, `Add your ${PROVIDER_LABEL[provider]} API key in the plugin settings.`);
		const headers: Record<string, string> = { 'X-Api-Key': key, Accept: 'application/json' };
		return classify(provider, await this.deps.http({ provider, payload, headers }));
	}

	/** One page of meetings in a window. The page size is set by Fathom. */
	async page(req: PageRequest): Promise<Reply<MeetingPage>> {
		const r = await this.call('fathom', fathomQuery(req.from, req.to, req.token, req.transcript));
		if (!r.ok) return r;
		const j = r.data;
		const items = typeof j === 'object' && j !== null && 'items' in j ? j.items : null;
		if (!Array.isArray(items)) return fail('http', 200, 'Fathom sent an answer that has no list of meetings.');
		const next = typeof j === 'object' && j !== null && 'next_cursor' in j && typeof j.next_cursor === 'string' && j.next_cursor !== '' ? j.next_cursor : null;
		return { ok: true, data: { rows: items as unknown[], next } };
	}

	/** Check connection: one list request without summaries. Returns a short text for the notice. */
	async check(provider: Provider): Promise<Reply<string>> {
		const r = await this.call(provider, '');
		return r.ok ? { ok: true, data: 'Fathom accepted the key.' } : r;
	}
}
