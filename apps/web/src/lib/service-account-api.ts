import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";
import {
	API_KEYS_PAGE_SIZE,
	type APIKeyPage,
	type CreateAPIKeyRequest,
	type CreateAPIKeyResponse,
} from "./apikey-api";
import type { Role, RoleSummary } from "./role-api";

/**
 * A service account: a workspace-level, non-human account that authenticates
 * with its own API keys and holds roles like a user, but cannot sign in.
 */
export interface ServiceAccount {
	id: string;
	name: string;
	description: string;
	created_by?: string;
	/** The workspace roles the account holds, sorted by name. */
	roles: RoleSummary[];
	created_at: string;
	updated_at: string;
	avatar_url?: string | null;
	avatar_thumb_url?: string | null;
}

export interface CreateServiceAccountRequest {
	name: string;
	description?: string;
}

export interface UpdateServiceAccountRequest {
	name?: string;
	description?: string;
}

const BASE = "/admin/service-accounts";

export const SERVICE_ACCOUNTS_PAGE_SIZE = 30;

export interface ServiceAccountPage {
	items: ServiceAccount[];
	page_size: number;
	next_cursor: string | null;
	/** Accounts matching the search, across all pages. */
	total_count?: number;
}

/** One page of service accounts ordered by name; `search` matches every word
 *  against the name or description. Follow next_cursor for further pages. */
export async function listServiceAccounts(
	opts: {
		search?: string;
		cursor?: string;
		/** Numbered page (1-indexed) instead of a cursor — for tables. */
		page?: number;
		pageSize?: number;
	} = {},
): Promise<ServiceAccountPage> {
	const params: Record<string, string | number> = {
		page_size: opts.pageSize ?? SERVICE_ACCOUNTS_PAGE_SIZE,
	};
	if (opts.search?.trim()) params.search = opts.search.trim();
	if (opts.cursor) params.cursor = opts.cursor;
	if (opts.page) params.page = opts.page;
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<ServiceAccountPage>
	>(BASE, { params });
	return data.data;
}

export async function getServiceAccount(id: string): Promise<ServiceAccount> {
	const { data } = await apiClient.instance.get<
		SuccessEnvelope<ServiceAccount>
	>(`${BASE}/${id}`);
	return data.data;
}

export async function createServiceAccount(
	payload: CreateServiceAccountRequest,
): Promise<ServiceAccount> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<ServiceAccount>
	>(BASE, payload);
	return data.data;
}

export async function updateServiceAccount(
	id: string,
	payload: UpdateServiceAccountRequest,
): Promise<ServiceAccount> {
	const { data } = await apiClient.instance.patch<
		SuccessEnvelope<ServiceAccount>
	>(`${BASE}/${id}`, payload);
	return data.data;
}

export async function deleteServiceAccount(id: string): Promise<void> {
	await apiClient.instance.delete(`${BASE}/${id}`);
}

export async function listServiceAccountKeys(
	id: string,
	cursor?: string,
): Promise<APIKeyPage> {
	const { data } = await apiClient.instance.get<SuccessEnvelope<APIKeyPage>>(
		`${BASE}/${id}/api-keys`,
		{ params: { page_size: API_KEYS_PAGE_SIZE, cursor } },
	);
	return data.data;
}

export async function createServiceAccountKey(
	id: string,
	payload: CreateAPIKeyRequest,
): Promise<CreateAPIKeyResponse> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<CreateAPIKeyResponse>
	>(`${BASE}/${id}/api-keys`, payload);
	return data.data;
}

export async function revokeServiceAccountKey(
	id: string,
	keyId: string,
): Promise<void> {
	await apiClient.instance.delete(`${BASE}/${id}/api-keys/${keyId}`);
}

export async function listServiceAccountRoles(id: string): Promise<Role[]> {
	const { data } = await apiClient.instance.get<SuccessEnvelope<Role[]>>(
		`${BASE}/${id}/roles`,
	);
	return data.data;
}

export async function replaceServiceAccountRoles(
	id: string,
	roleIds: string[],
): Promise<Role[]> {
	const { data } = await apiClient.instance.put<SuccessEnvelope<Role[]>>(
		`${BASE}/${id}/roles`,
		{ role_ids: roleIds },
	);
	return data.data;
}

/** Key prefix of every cached service account query (lists and single
 *  accounts) — invalidate it after an account changes. */
export const serviceAccountsKey = ["admin", "service-accounts"] as const;

export const serviceAccountsInfiniteQueryOptions = (search = "") =>
	infiniteQueryOptions({
		queryKey: [...serviceAccountsKey, "list", search],
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listServiceAccounts({ search, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

/** One numbered page of service accounts — backs the accounts table. */
export const serviceAccountsPageQueryOptions = (
	page: number,
	pageSize: number,
	search = "",
) =>
	queryOptions({
		queryKey: [...serviceAccountsKey, "page", page, pageSize, search] as const,
		queryFn: () => listServiceAccounts({ search, page, pageSize }),
	});

export const serviceAccountQueryOptions = (id: string) =>
	queryOptions({
		queryKey: ["admin", "service-accounts", id],
		queryFn: () => getServiceAccount(id),
	});

export const serviceAccountKeysInfiniteQueryOptions = (id: string) =>
	infiniteQueryOptions({
		queryKey: ["admin", "service-accounts", id, "api-keys"],
		queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
			listServiceAccountKeys(id, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
	});

export const serviceAccountRolesQueryOptions = (id: string) =>
	queryOptions({
		queryKey: ["admin", "service-accounts", id, "roles"],
		queryFn: () => listServiceAccountRoles(id),
	});
