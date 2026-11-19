/**
 * Host-side implementation of the plugin SDK's PluginApiClient contract
 * (see @paca-ai/plugin-sdk-react's api-client.ts, which every plugin
 * frontend bundles its own copy of via Module Federation). apps/web does
 * not depend on that package, so this is duck-typed to match its runtime
 * shape rather than sharing a class — plugin components call `props.api.*`
 * and don't care which implementation answers.
 */

interface SuccessEnvelope<T> {
	success: true;
	data: T;
}

export interface HostPluginApiClient {
	readonly projectId: string;
	/** The first page of tasks (200 by default); see listTasksPage. */
	listTasks(filters?: Record<string, unknown>): Promise<unknown[]>;
	/** One page of tasks: `{items, page_size, next_cursor, total_count?}`;
	 *  pass `next_cursor` as the `cursor` filter for the next page. */
	listTasksPage(filters?: Record<string, unknown>): Promise<unknown>;
	getTask(taskId: string): Promise<unknown>;
	getProject(): Promise<unknown>;
	listMembers(opts?: {
		search?: string;
		ids?: string[];
		cursor?: string;
		pageSize?: number;
	}): Promise<unknown>;
	pluginGet<T>(pluginId: string, path: string): Promise<T>;
	pluginPost<T>(pluginId: string, path: string, body: unknown): Promise<T>;
	pluginPatch<T>(pluginId: string, path: string, body: unknown): Promise<T>;
	pluginDelete(pluginId: string, path: string): Promise<void>;
}

import { apiClient } from "@/lib/api-client";

const API_BASE_URL = `${window.location.origin}/api/v1`;

function pluginUrl(pluginId: string, path: string): string {
	const p = path.startsWith("/") ? path : `/${path}`;
	return `${API_BASE_URL}/plugins/${pluginId}${p}`;
}

// Project-scoped methods (listTasks/getTask/getProject/listMembers) are only
// meaningful when the client was built with a projectId — admin/global-scope
// pages build one without. Fail loudly instead of hitting a malformed
// `/projects//...` URL, which otherwise surfaces as an opaque 404.
function requireProjectId(projectId: string, method: string): void {
	if (!projectId) {
		throw new Error(
			`[PluginApiClient] ${method}() requires a project-scoped client, but no projectId was provided — this plugin page is rendered without a project context (e.g. an admin/global-scope page).`,
		);
	}
}

async function request<T>(
	method: string,
	url: string,
	body?: unknown,
): Promise<T> {
	const init: RequestInit = {
		method,
		// Auth is via an HttpOnly session cookie (see apiClient's withCredentials
		// use of the same cookie) rather than a bearer token, so plain fetch
		// with credentials included is sufficient — no token to attach.
		credentials: "include",
		headers: { "Content-Type": "application/json" },
	};
	if (body !== undefined) {
		init.body = JSON.stringify(body);
	}

	let res = await fetch(url, init);
	if (res.status === 401) {
		// The short-lived access-token cookie may have lapsed (a tab left open,
		// or a detour through an external site). Renew it from the refresh
		// cookie — the same renewal the host's own API client does on a 401 —
		// and retry once. Retrying is safe even for a POST: a 401 means the
		// request was refused before the plugin handled it.
		try {
			await apiClient.refreshSession();
			res = await fetch(url, init);
		} catch {
			// Refresh failed: fall through and report the original 401.
		}
	}
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(
			`[PluginApiClient] ${method} ${url} → ${res.status}: ${text}`,
		);
	}
	if (res.status === 204) return undefined as T;
	const json = (await res.json()) as SuccessEnvelope<T>;
	return json.data;
}

interface TaskPage {
	items: unknown[];
	page_size: number;
	next_cursor: string | null;
	total_count?: number;
}

function listTaskPage(
	projectId: string,
	method: string,
	filters?: Record<string, unknown>,
): Promise<TaskPage> {
	requireProjectId(projectId, method);
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters ?? {})) {
		// `page` is not a task-list parameter (tasks page by cursor).
		if (key === "page") continue;
		if (value !== undefined && value !== null && value !== "") {
			params.set(key, String(value));
		}
	}
	if (!params.has("page_size")) params.set("page_size", "200");
	const qs = params.toString();
	return request<TaskPage>(
		"GET",
		`${API_BASE_URL}/projects/${projectId}/tasks${qs ? `?${qs}` : ""}`,
	);
}

/**
 * Builds the client injected as `props.api` into every plugin extension-point
 * component. `projectId` should be omitted for admin/global-scope pages,
 * matching BaseExtensionProps's contract.
 */
export function createPluginApiClient(projectId = ""): HostPluginApiClient {
	return {
		projectId,
		listTasks: (filters) =>
			listTaskPage(projectId, "listTasks", filters).then((page) => page.items),
		listTasksPage: (filters) =>
			listTaskPage(projectId, "listTasksPage", filters),
		getTask: (taskId) => {
			requireProjectId(projectId, "getTask");
			return request(
				"GET",
				`${API_BASE_URL}/projects/${projectId}/tasks/${taskId}`,
			);
		},
		getProject: () => {
			requireProjectId(projectId, "getProject");
			return request("GET", `${API_BASE_URL}/projects/${projectId}`);
		},
		listMembers: (opts = {}) => {
			requireProjectId(projectId, "listMembers");
			const params = new URLSearchParams();
			if (opts.search) params.set("search", opts.search);
			if (opts.ids?.length) params.set("ids", opts.ids.join(","));
			if (opts.cursor) params.set("cursor", opts.cursor);
			if (opts.pageSize) params.set("page_size", String(opts.pageSize));
			const qs = params.toString();
			return request(
				"GET",
				`${API_BASE_URL}/projects/${projectId}/members${qs ? `?${qs}` : ""}`,
			);
		},
		pluginGet: (pluginId, path) => request("GET", pluginUrl(pluginId, path)),
		pluginPost: (pluginId, path, body) =>
			request("POST", pluginUrl(pluginId, path), body),
		pluginPatch: (pluginId, path, body) =>
			request("PATCH", pluginUrl(pluginId, path), body),
		pluginDelete: (pluginId, path) =>
			request("DELETE", pluginUrl(pluginId, path), undefined),
	};
}
