import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";

// Mirrors agent-api.ts exactly: types, REST functions, and queryOptions(...)
// factories — see docs/ai-agent/environment-management.md for the full
// design. Base path `/projects/{projectId}/environments`, under the existing
// `/api/v1` prefix api-client.ts already applies.

// ── Shapes ────────────────────────────────────────────────────────────────────

export type EnvironmentStatus =
	| "creating"
	// Set immediately after StartEnvironment queues a start command,
	// before the async consumer has actually asked agent-runner to start
	// the backing container/Pod — see environmentdom.StatusStarting's own
	// doc comment on the Go side.
	| "starting"
	| "running"
	| "stopping"
	| "stopped"
	| "suspended"
	| "error"
	| "deleting";

export type EnvironmentBackend = "docker" | "kubernetes";

// EnvironmentFolder is identified purely by path — a name/repo-clone-URL/
// branch used to exist here but were dropped before ever shipping (the
// repo-clone machinery was never fully wired to a real credential
// source).
export interface EnvironmentFolder {
	id: string;
	path: string;
	created_at: string;
}

// EnvironmentBrowseEntry is one immediate child of a directory listed via
// browseEnvironment — a live read against the environment's own running
// container/Pod filesystem, not a persisted row.
export interface EnvironmentBrowseEntry {
	name: string;
	is_dir: boolean;
}

export interface Environment {
	id: string;
	project_id: string;
	name: string;
	slug: string;
	// null until agent-runner's own SSH-routing feature assigns one (or
	// permanently null on a deployment that never configured it) — see
	// docs/ai-agent/environment-management.md's "Terminal / SSH Access"
	// section. Published as a native Docker -p binding or a Kubernetes
	// NodePort Service entry directly on the environment's own
	// container/Pod, never relayed through agent-runner's own process.
	ssh_port: number | null;
	status: EnvironmentStatus;
	backend: EnvironmentBackend;
	image: string | null;
	cpu_limit: string;
	memory_limit: string;
	disk_limit_gb: number;
	// Decided once at create time and never patched afterward — there is
	// no docker_enabled field on updateEnvironment's payload below, the
	// same "create-only" contract cpu_limit/memory_limit/disk_limit_gb
	// already follow.
	docker_enabled: boolean;
	idle_timeout_minutes: number;
	last_active_at: string;
	error_message?: string | null;
	// True whenever a port forward has been added/removed since the
	// environment's backing container/Pod last had its full port-mapping
	// set applied — see docs/ai-agent/environment-management.md's "Port
	// Forwarding" section. When true, show a "restart required" prompt
	// (see restartEnvironment below).
	ports_pending_restart: boolean;
	created_at: string;
	updated_at: string;
}

// EnvironmentStats is one message on the live-usage WebSocket
// (environment-status-ring.tsx's useEnvironmentUsage connects to
// getStatsTicket's ws_url) — a point-in-time snapshot, not a persisted
// field on Environment above. cpu_usage_usec is cumulative since the
// container/Pod started, not an instantaneous rate — useEnvironmentUsage
// derives a rate from two successive messages.
// cpu_limit_millicores/memory_limit_bytes are 0 when the backend reports
// no enforced limit — fall back to the parent Environment's own
// cpu_limit/memory_limit in that case.
export interface EnvironmentStats {
	cpu_usage_usec: number;
	cpu_limit_millicores: number;
	memory_used_bytes: number;
	memory_limit_bytes: number;
	disk_used_bytes: number;
	// has_active_ssh_session mirrors the idle reaper's own live-session
	// check (cmd/agent-runner/main.go's reapOneIdleEnvironment) — direct
	// SSH access never touches last_active_at, so this is the only signal
	// the frontend has that an environment which *looks* about to idle-out
	// by that column is, in fact, never going to be allowed to.
	has_active_ssh_session: boolean;
}

export interface EnvironmentSSHKey {
	id: string;
	label: string;
	public_key: string;
	fingerprint: string;
	created_at: string;
}

// EnvironmentPortForward is a user-added mapping exposing one container
// port on a dedicated external port — see
// docs/ai-agent/environment-management.md's "Port Forwarding" section.
// host_port is null until agent-runner assigns one (either the
// environment isn't running yet, or port forwarding isn't configured on
// this deployment); even once assigned, it isn't necessarily *live* yet —
// see Environment.ports_pending_restart.
export interface EnvironmentPortForward {
	id: string;
	label: string;
	container_port: number;
	host_port: number | null;
	created_at: string;
}

// ── Environments ──────────────────────────────────────────────────────────────

export const ENVIRONMENTS_PAGE_SIZE = 30;

/** One page of an environment list. `total_count` is present on the
 *  per-environment lists (folders, SSH keys, port forwards). */
export interface EnvironmentListPage<T> {
	items: T[];
	page_size: number;
	next_cursor: string | null;
	total_count?: number;
}

export interface EnvironmentListOptions {
	/** Words that must all appear in the name/slug (environments) or path (folders). */
	search?: string;
	/** Only these records (at most 100) — a batch lookup. */
	ids?: string[];
	cursor?: string;
	pageSize?: number;
}

function listParams(
	opts: EnvironmentListOptions,
): Record<string, string | number> {
	const params: Record<string, string | number> = {
		page_size: opts.pageSize ?? ENVIRONMENTS_PAGE_SIZE,
	};
	if (opts.search?.trim()) params.search = opts.search.trim();
	if (opts.ids?.length) params.ids = opts.ids.join(",");
	if (opts.cursor) params.cursor = opts.cursor;
	return params;
}

/** One page of a project's environments, newest first. */
export async function listEnvironments(
	projectId: string,
	opts: EnvironmentListOptions = {},
): Promise<EnvironmentListPage<Environment>> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<EnvironmentListPage<Environment>>
	>(`/projects/${projectId}/environments`, { params: listParams(opts) });
	return data.data;
}

export async function getEnvironment(
	projectId: string,
	environmentId: string,
): Promise<Environment> {
	const { data } = await apiClient.instance.get<SuccessEnvelope<Environment>>(
		`/projects/${projectId}/environments/${environmentId}`,
	);
	return data.data;
}

export async function createEnvironment(
	projectId: string,
	payload: {
		name: string;
		image?: string;
		cpu_limit?: string;
		memory_limit?: string;
		disk_limit_gb?: number;
		docker_enabled?: boolean;
	},
): Promise<Environment> {
	const { data } = await apiClient.instance.post<SuccessEnvelope<Environment>>(
		`/projects/${projectId}/environments`,
		payload,
	);
	return data.data;
}

export async function updateEnvironment(
	projectId: string,
	environmentId: string,
	payload: {
		name?: string;
		idle_timeout_minutes?: number;
	},
): Promise<Environment> {
	const { data } = await apiClient.instance.patch<SuccessEnvelope<Environment>>(
		`/projects/${projectId}/environments/${environmentId}`,
		payload,
	);
	return data.data;
}

export async function deleteEnvironment(
	projectId: string,
	environmentId: string,
): Promise<void> {
	await apiClient.instance.delete(
		`/projects/${projectId}/environments/${environmentId}`,
	);
}

export async function startEnvironment(
	projectId: string,
	environmentId: string,
): Promise<Environment> {
	const { data } = await apiClient.instance.post<SuccessEnvelope<Environment>>(
		`/projects/${projectId}/environments/${environmentId}/start`,
	);
	return data.data;
}

export async function stopEnvironment(
	projectId: string,
	environmentId: string,
): Promise<Environment> {
	const { data } = await apiClient.instance.post<SuccessEnvelope<Environment>>(
		`/projects/${projectId}/environments/${environmentId}/stop`,
	);
	return data.data;
}

// restartEnvironment applies any pending port-forward changes to a
// currently-running environment's backing container/Pod — the explicit
// user-facing action for Environment.ports_pending_restart. Only valid
// against a running environment; a stopped one applies its pending
// changes automatically on its next startEnvironment call instead.
export async function restartEnvironment(
	projectId: string,
	environmentId: string,
): Promise<Environment> {
	const { data } = await apiClient.instance.post<SuccessEnvelope<Environment>>(
		`/projects/${projectId}/environments/${environmentId}/restart`,
	);
	return data.data;
}

// heartbeatEnvironment refreshes an environment's idle timer — pinged
// periodically (see environment-terminal.tsx's CONVERSATION_HEARTBEAT_INTERVAL_MS
// sibling below) while a browser terminal session is open against it, the
// same "keep the sandbox alive while a tab is actively using it" pattern
// heartbeatConversation already establishes in agent-api.ts.
export async function heartbeatEnvironment(
	projectId: string,
	environmentId: string,
): Promise<void> {
	await apiClient.instance.post(
		`/projects/${projectId}/environments/${environmentId}/heartbeat`,
	);
}

export const ENVIRONMENT_HEARTBEAT_INTERVAL_MS = 30_000;

// ── Folders ───────────────────────────────────────────────────────────────────

/** One page of an environment's folders, oldest first. */
export async function listFolders(
	projectId: string,
	environmentId: string,
	opts: EnvironmentListOptions = {},
): Promise<EnvironmentListPage<EnvironmentFolder>> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<EnvironmentListPage<EnvironmentFolder>>
	>(`/projects/${projectId}/environments/${environmentId}/folders`, {
		params: listParams(opts),
	});
	return data.data;
}

export async function addFolder(
	projectId: string,
	environmentId: string,
	payload: { path: string },
): Promise<EnvironmentFolder> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<EnvironmentFolder>
	>(`/projects/${projectId}/environments/${environmentId}/folders`, payload);
	return data.data;
}

export async function deleteFolder(
	projectId: string,
	environmentId: string,
	folderId: string,
): Promise<void> {
	await apiClient.instance.delete(
		`/projects/${projectId}/environments/${environmentId}/folders/${folderId}`,
	);
}

// browseEnvironment lists the immediate children of path (defaults
// server-side to the environment's fixed folders root when omitted)
// inside a running environment's own container/Pod — used by
// FolderCreateDialog's "browse instead of typing blind" affordance.
// Requires the environment to be running (a 409/error otherwise — see
// ErrEnvironmentNotRunning on the backend).
export async function browseEnvironment(
	projectId: string,
	environmentId: string,
	path?: string,
): Promise<{ path: string; entries: EnvironmentBrowseEntry[] }> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<{ path: string; entries: EnvironmentBrowseEntry[] }>
	>(`/projects/${projectId}/environments/${environmentId}/browse`, {
		params: path ? { path } : undefined,
	});
	return data.data;
}

// ── SSH Keys ──────────────────────────────────────────────────────────────────

/** One page of an environment's SSH keys, oldest first. */
export async function listSSHKeys(
	projectId: string,
	environmentId: string,
	opts: Pick<EnvironmentListOptions, "cursor" | "pageSize"> = {},
): Promise<EnvironmentListPage<EnvironmentSSHKey>> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<EnvironmentListPage<EnvironmentSSHKey>>
	>(`/projects/${projectId}/environments/${environmentId}/ssh-keys`, {
		params: listParams(opts),
	});
	return data.data;
}

export async function addSSHKey(
	projectId: string,
	environmentId: string,
	payload: { label: string; public_key: string },
): Promise<EnvironmentSSHKey> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<EnvironmentSSHKey>
	>(`/projects/${projectId}/environments/${environmentId}/ssh-keys`, payload);
	return data.data;
}

export async function deleteSSHKey(
	projectId: string,
	environmentId: string,
	keyId: string,
): Promise<void> {
	await apiClient.instance.delete(
		`/projects/${projectId}/environments/${environmentId}/ssh-keys/${keyId}`,
	);
}

// ── Port Forwards ─────────────────────────────────────────────────────────────

/** One page of an environment's port forwards, oldest first. */
export async function listPortForwards(
	projectId: string,
	environmentId: string,
	opts: Pick<EnvironmentListOptions, "cursor" | "pageSize"> = {},
): Promise<EnvironmentListPage<EnvironmentPortForward>> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<EnvironmentListPage<EnvironmentPortForward>>
	>(`/projects/${projectId}/environments/${environmentId}/port-forwards`, {
		params: listParams(opts),
	});
	return data.data;
}

export async function getPortForward(
	projectId: string,
	environmentId: string,
	portForwardId: string,
): Promise<EnvironmentPortForward> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<EnvironmentPortForward>
	>(
		`/projects/${projectId}/environments/${environmentId}/port-forwards/${portForwardId}`,
	);
	return data.data;
}

export async function addPortForward(
	projectId: string,
	environmentId: string,
	payload: { label?: string; container_port: number },
): Promise<EnvironmentPortForward> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<EnvironmentPortForward>
	>(
		`/projects/${projectId}/environments/${environmentId}/port-forwards`,
		payload,
	);
	return data.data;
}

export async function deletePortForward(
	projectId: string,
	environmentId: string,
	portForwardId: string,
): Promise<void> {
	await apiClient.instance.delete(
		`/projects/${projectId}/environments/${environmentId}/port-forwards/${portForwardId}`,
	);
}

// ── Environment tickets (terminal + stats WebSockets) ───────────────────────────
//
// Both endpoints below mint a short-lived signed ticket one of
// agent-runner's browser-facing WebSocket endpoints verifies on its own —
// see services/api's EnvironmentHandler.TerminalTicket/StatsTicket for the
// full contract. resolveWsUrl below is shared by both the terminal
// (environment-terminal.tsx) and the live-usage stream
// (environment-status-ring.tsx)'s own WebSocket connection setup.

export interface EnvironmentTicket {
	ticket: string;
	ws_url: string;
}

export async function getTerminalTicket(
	projectId: string,
	environmentId: string,
): Promise<EnvironmentTicket> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<EnvironmentTicket>
	>(`/projects/${projectId}/environments/${environmentId}/terminal-ticket`);
	return data.data;
}

export async function getStatsTicket(
	projectId: string,
	environmentId: string,
): Promise<EnvironmentTicket> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<EnvironmentTicket>
	>(`/projects/${projectId}/environments/${environmentId}/stats-ticket`);
	return data.data;
}

/**
 * Resolves a ticket response's `ws_url` against the current origin — the
 * same "treat window.location as the connection's base" convention
 * socket-client.ts uses for its Socket.IO origin. Already-absolute
 * ws(s):// URLs (the expected shape) pass through untouched; a bare path is
 * resolved against the page's own host, swapping http(s) for the matching
 * ws(s) scheme.
 */
export function resolveWsUrl(wsUrl: string): string {
	if (/^wss?:\/\//i.test(wsUrl)) return wsUrl;
	const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
	const path = wsUrl.startsWith("/") ? wsUrl : `/${wsUrl}`;
	return `${proto}//${window.location.host}${path}`;
}

// ── Deployment config ────────────────────────────────────────────────────────

// EnvironmentDeploymentConfig is public, deployment-wide (not per-project)
// config the Connect page needs to show a real `ssh` command / port-
// forward address instead of a placeholder host — see
// docs/ai-agent/environment-management.md's "Terminal / SSH Access" and
// "Port Forwarding" sections. Either field is "" when the operator hasn't
// configured that feature on this deployment.
export interface EnvironmentDeploymentConfig {
	ssh_bastion_host: string;
	port_forward_host: string;
	// False when this deployment's sandbox namespace cannot run the
	// privileged DinD sidecar a docker-enabled sandbox needs — the docker
	// toggles stay hidden rather than offering a setting agent-runner will
	// refuse.
	docker_in_sandbox: boolean;
}

export async function getEnvironmentConfig(): Promise<EnvironmentDeploymentConfig> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<EnvironmentDeploymentConfig>
	>("/environments/config");
	return data.data;
}

/**
 * Builds the URL to open a forwarded port at, using the current page's own
 * protocol rather than hardcoding http: — a forwarded preview shares the
 * Paca app's own hostname, differing only by port (see services/api's
 * corsMiddleware doc comment and the extension's content script, which
 * builds its own baseUrl the same way), so a deployment fronting previews
 * over TLS via a proxy on PORT_FORWARD_HOST would otherwise get a URL that
 * opens a failing plain-HTTP origin instead of the real one.
 */
export function portForwardUrl(host: string, port: number, path = ""): string {
	return `${window.location.protocol}//${host}:${port}${path}`;
}

// Not project- or environment-scoped (the same deployment-wide values for
// everyone), so one shared query key/cache entry — mirrors how
// currentUserQueryOptions/branding-style global config is fetched
// elsewhere in this app. staleTime: Infinity since this can only change by
// redeploying the backend, never during a session.
/** One folder looked up by id (null when it no longer exists), so a picker can
 *  show the selected folder's path without loading the whole folder list. */
export const environmentFolderQueryOptions = (
	projectId: string,
	environmentId: string,
	folderId: string,
) =>
	queryOptions({
		queryKey: [
			"projects",
			projectId,
			"environments",
			environmentId,
			"folder",
			folderId,
		] as const,
		queryFn: async () => {
			const page = await listFolders(projectId, environmentId, {
				ids: [folderId],
				pageSize: 1,
			});
			return page.items[0] ?? null;
		},
	});

export const environmentConfigQueryOptions = () =>
	queryOptions({
		queryKey: ["environments", "config"],
		queryFn: getEnvironmentConfig,
		staleTime: Number.POSITIVE_INFINITY,
	});

// ── Query Options ─────────────────────────────────────────────────────────────

/** Key prefix of every cached environment query for a project (lists and
 *  single environments, with their sub-resources) — invalidate it after an
 *  environment changes. */
export const environmentsKey = (projectId: string) =>
	["projects", projectId, "environments"] as const;

export const environmentsInfiniteQueryOptions = (
	projectId: string,
	search = "",
) =>
	infiniteQueryOptions({
		queryKey: [...environmentsKey(projectId), "list", search] as const,
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listEnvironments(projectId, { search, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

// No refetchInterval: kept live via useProjectRealtime's socket-driven
// invalidation on "environment.status_changed" instead of polling while the
// environment is in a transitional status (creating/starting/stopping) —
// same posture as every other socket-covered query in this app (tasks,
// docs, sprints, ...), none of which keep a fallback poll either.
export const environmentQueryOptions = (
	projectId: string,
	environmentId: string,
) =>
	queryOptions({
		queryKey: ["projects", projectId, "environments", environmentId],
		queryFn: () => getEnvironment(projectId, environmentId),
	});

// environmentBrowseQueryOptions is keyed by path (undefined path collapses
// to "" so the root listing has a stable key) — FolderCreateDialog issues
// one of these per directory it navigates into. staleTime: 0 (the
// default) is deliberate: the container's own filesystem can change under
// an agent's feet between browses, unlike everything else in this file.
export const environmentBrowseQueryOptions = (
	projectId: string,
	environmentId: string,
	path?: string,
) =>
	queryOptions({
		queryKey: [
			"projects",
			projectId,
			"environments",
			environmentId,
			"browse",
			path ?? "",
		],
		queryFn: () => browseEnvironment(projectId, environmentId, path),
	});

export const environmentFoldersInfiniteQueryOptions = (
	projectId: string,
	environmentId: string,
	search = "",
) =>
	infiniteQueryOptions({
		queryKey: [
			"projects",
			projectId,
			"environments",
			environmentId,
			"folders",
			search,
		] as const,
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listFolders(projectId, environmentId, { search, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

export const environmentSSHKeysInfiniteQueryOptions = (
	projectId: string,
	environmentId: string,
) =>
	infiniteQueryOptions({
		queryKey: [
			"projects",
			projectId,
			"environments",
			environmentId,
			"ssh-keys",
		] as const,
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listSSHKeys(projectId, environmentId, { cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

export const environmentPortForwardsInfiniteQueryOptions = (
	projectId: string,
	environmentId: string,
) =>
	infiniteQueryOptions({
		queryKey: [
			"projects",
			projectId,
			"environments",
			environmentId,
			"port-forwards",
		] as const,
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listPortForwards(projectId, environmentId, { cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

export const portForwardQueryOptions = (
	projectId: string,
	environmentId: string,
	portForwardId: string,
) =>
	queryOptions({
		queryKey: [
			"projects",
			projectId,
			"environments",
			environmentId,
			"port-forwards",
			portForwardId,
		],
		queryFn: () => getPortForward(projectId, environmentId, portForwardId),
	});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Colors only — unlike agent-api.ts's CONVERSATION_STATUS_LABELS, the label
// text itself is looked up via i18n (`environments.status.<status>`, see
// environment-detail.tsx) rather than hardcoded here, so every status string
// shown to a user goes through translation instead of staying English-only.
export const ENVIRONMENT_STATUS_COLORS: Record<EnvironmentStatus, string> = {
	creating: "text-amber-500",
	starting: "text-amber-500",
	running: "text-emerald-500",
	stopping: "text-amber-500",
	stopped: "text-muted-foreground",
	suspended: "text-muted-foreground",
	error: "text-destructive",
	deleting: "text-amber-500",
};
