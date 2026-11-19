import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";
import type { Policy, PolicyIssue } from "./policy";

/** A role as the roles API returns it. */
export interface Role {
	id: string;
	name: string;
	description: string;
	policy: Policy;
	/** The owning project, or null for a platform role. */
	project_id: string | null;
	is_system: boolean;
	is_default: boolean;
	/** How many attachments reference the role (those inside the project in a
	 *  project listing). */
	attachment_count: number;
	created_at: string;
	updated_at: string;
}

export interface RoleSummary {
	id: string;
	name: string;
}

export interface RoleInput {
	name: string;
	description: string;
	policy: Policy;
}

export interface ValidateResult {
	valid: boolean;
	issues: PolicyIssue[];
}

export interface SimulateInput {
	policy: Policy;
	principal?: { type: "user" | "agent"; id: string };
	action: string;
	resource: string;
	attributes?: Record<string, string | boolean | string[]>;
}

export interface SimulateResult {
	allowed: boolean;
	matched: { role_id: string; sid: string; effect: string; index: number }[];
}

export interface AttributeDef {
	key: string;
	resource_kind: string;
	type: string;
	multi_valued: boolean;
	label_key: string;
}

/** Roles live under /admin/roles (platform) or /projects/{id}/roles (project). */
function base(projectId?: string): string {
	return projectId ? `/projects/${projectId}/roles` : "/admin/roles";
}

/** Role-less helpers (validate, simulate, actions, attribute schema) have a
 *  workspace-wide route and a per-project one for callers who only hold
 *  roles:read inside a project. */
function helperBase(projectId?: string): string {
	return projectId ? `/projects/${projectId}/roles` : "/roles";
}

export const ROLES_PAGE_SIZE = 30;

/** One page of roles. `total_count` covers every role matching the filters. */
export interface RolePage {
	items: Role[];
	page_size: number;
	next_cursor: string | null;
	total_count: number;
}

export interface ListRolesOptions {
	/** Words that must all appear in the role's name or description. */
	search?: string;
	/** Only these roles (at most 100) — a batch lookup. */
	ids?: string[];
	cursor?: string;
	/** Numbered page (1-indexed) instead of a cursor — for tables. */
	page?: number;
	pageSize?: number;
}

/** One page of the platform roles, or — with a projectId — of the roles that
 *  can be used inside that project (its own, then the platform roles attached
 *  there). */
export async function listRoles(
	projectId?: string,
	opts: ListRolesOptions = {},
): Promise<RolePage> {
	const params: Record<string, string | number> = {
		page_size: opts.pageSize ?? ROLES_PAGE_SIZE,
	};
	if (opts.search?.trim()) params.search = opts.search.trim();
	if (opts.ids?.length) params.ids = opts.ids.join(",");
	if (opts.cursor) params.cursor = opts.cursor;
	if (opts.page) params.page = opts.page;
	const { data } = await apiClient.instance.get<SuccessEnvelope<RolePage>>(
		base(projectId),
		{ params },
	);
	return data.data;
}

export async function getRole(
	roleId: string,
	projectId?: string,
): Promise<Role> {
	const { data } = await apiClient.instance.get<SuccessEnvelope<Role>>(
		`${base(projectId)}/${roleId}`,
	);
	return data.data;
}

export async function createRole(
	input: RoleInput,
	projectId?: string,
): Promise<Role> {
	const { data } = await apiClient.instance.post<SuccessEnvelope<Role>>(
		base(projectId),
		input,
	);
	return data.data;
}

export async function updateRole(
	roleId: string,
	input: RoleInput,
	projectId?: string,
): Promise<Role> {
	const { data } = await apiClient.instance.put<SuccessEnvelope<Role>>(
		`${base(projectId)}/${roleId}`,
		input,
	);
	return data.data;
}

export async function deleteRole(
	roleId: string,
	projectId?: string,
): Promise<void> {
	await apiClient.instance.delete(`${base(projectId)}/${roleId}`);
}

/** Makes a platform role the one new users and global agents start with. */
export async function setDefaultRole(roleId: string): Promise<Role> {
	const { data } = await apiClient.instance.put<SuccessEnvelope<Role>>(
		`/admin/roles/${roleId}/default`,
	);
	return data.data;
}

export async function validatePolicy(
	policy: Policy,
	projectId?: string,
): Promise<ValidateResult> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<ValidateResult>
	>(`${helperBase(projectId)}/validate`, { policy });
	return data.data;
}

export async function simulatePolicy(
	input: SimulateInput,
	projectId?: string,
): Promise<SimulateResult> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<SimulateResult>
	>(`${helperBase(projectId)}/simulate`, input);
	return data.data;
}

/** Every action the server knows (built-in and plugin-declared), sorted. */
export async function getKnownActions(projectId?: string): Promise<string[]> {
	const { data } = await apiClient.instance.get<SuccessEnvelope<string[]>>(
		`${helperBase(projectId)}/actions`,
	);
	return data.data;
}

export async function getAttributeSchema(
	projectId?: string,
): Promise<AttributeDef[]> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<AttributeDef[]>
	>(`${helperBase(projectId)}/attribute-schema`);
	return data.data;
}

// --- Assignment -------------------------------------------------------------

/** Replaces the set of platform roles a user holds. */
export async function replaceUserRoles(
	userId: string,
	roleIds: string[],
): Promise<Role[]> {
	const { data } = await apiClient.instance.put<SuccessEnvelope<Role[]>>(
		`/admin/users/${userId}/roles`,
		{ role_ids: roleIds },
	);
	return data.data;
}

/** Replaces the set of platform roles a global agent holds. */
export async function replaceAgentRoles(
	agentId: string,
	roleIds: string[],
): Promise<Role[]> {
	const { data } = await apiClient.instance.put<SuccessEnvelope<Role[]>>(
		`/admin/agents/${agentId}/roles`,
		{ role_ids: roleIds },
	);
	return data.data;
}

/** Replaces the set of roles a project member holds inside the project. */
export async function replaceMemberRoles(
	projectId: string,
	memberId: string,
	roleIds: string[],
): Promise<Role[]> {
	const { data } = await apiClient.instance.put<SuccessEnvelope<Role[]>>(
		`/projects/${projectId}/members/${memberId}/roles`,
		{ role_ids: roleIds },
	);
	return data.data;
}

// --- Query options ----------------------------------------------------------

/** Key prefix of every cached platform-role query (lists and single roles). */
export const platformRolesKey = ["admin", "roles"] as const;

/** Key prefix of every cached role query of a project. */
export const projectRolesKey = (projectId: string) =>
	["projects", projectId, "roles"] as const;

/** Cursor-paged platform roles, optionally filtered by search. */
export const platformRolesInfiniteQueryOptions = (search = "") =>
	infiniteQueryOptions({
		queryKey: [...platformRolesKey, "list", search] as const,
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listRoles(undefined, { search, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

/** Cursor-paged roles usable inside a project, optionally filtered by search. */
export const projectRolesInfiniteQueryOptions = (
	projectId: string,
	search = "",
) =>
	infiniteQueryOptions({
		queryKey: [...projectRolesKey(projectId), "list", search] as const,
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listRoles(projectId, { search, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

/** One numbered page of the platform roles — backs the roles table. */
export const platformRolesPageQueryOptions = (page: number, pageSize: number) =>
	queryOptions({
		queryKey: [...platformRolesKey, "page", page, pageSize] as const,
		queryFn: () => listRoles(undefined, { page, pageSize }),
	});

/** One numbered page of a project's roles — backs the project roles table. */
export const projectRolesPageQueryOptions = (
	projectId: string,
	page: number,
	pageSize: number,
) =>
	queryOptions({
		queryKey: [...projectRolesKey(projectId), "page", page, pageSize] as const,
		queryFn: () => listRoles(projectId, { page, pageSize }),
	});

/** A batch of roles looked up by id (at most 100), so a screen can show the
 *  roles an account holds without loading the whole list. */
export const rolesByIdsQueryOptions = (
	projectId: string | undefined,
	ids: string[],
) => {
	const sorted = [...new Set(ids)].sort();
	return queryOptions({
		queryKey: [
			...(projectId ? projectRolesKey(projectId) : platformRolesKey),
			"ids",
			sorted,
		] as const,
		queryFn: async () =>
			sorted.length === 0
				? []
				: (await listRoles(projectId, { ids: sorted, pageSize: 100 })).items,
		// Display-only: a caller without roles:read just shows plain names.
		retry: false,
	});
};

/** Every action the server knows; the JSON editor autocompletes from it. */
export const knownActionsQueryOptions = (projectId?: string) =>
	queryOptions({
		queryKey: ["roles", "actions", projectId ?? null],
		queryFn: () => getKnownActions(projectId),
		staleTime: 5 * 60 * 1000,
		retry: false,
	});

/** The condition attributes the server knows; drives "Limit to…" and the
 *  JSON editor's key suggestions. */
export const attributeSchemaQueryOptions = (projectId?: string) =>
	queryOptions({
		queryKey: ["roles", "attribute-schema", projectId ?? null],
		queryFn: () => getAttributeSchema(projectId),
		staleTime: 5 * 60 * 1000,
		retry: false,
	});
