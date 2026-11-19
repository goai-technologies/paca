import { queryOptions } from "@tanstack/react-query";
import { apiClient } from "./api-client";
import type { SuccessEnvelope } from "./api-error";

export interface APIKey {
	id: string;
	name: string;
	key_prefix: string;
	last_used_at: string | null;
	expires_at: string | null;
	created_at: string;
}

export interface CreateAPIKeyRequest {
	name: string;
	expires_at?: string | null;
}

export interface CreateAPIKeyResponse extends APIKey {
	/** Raw key — shown ONCE immediately after creation */
	key: string;
}

export const API_KEYS_PAGE_SIZE = 30;

/** One page of an account's active API keys, newest first. */
export interface APIKeyPage {
	items: APIKey[];
	page_size: number;
	next_cursor: string | null;
	/** All of the account's active keys, not just this page. */
	total_count: number;
}

export async function listAPIKeys(
	opts: { page?: number; pageSize?: number } = {},
): Promise<APIKeyPage> {
	const { data } = await apiClient.instance.get<SuccessEnvelope<APIKeyPage>>(
		"/users/me/api-keys",
		{
			params: {
				page_size: opts.pageSize ?? API_KEYS_PAGE_SIZE,
				page: opts.page,
			},
		},
	);
	return data.data;
}

export async function createAPIKey(
	payload: CreateAPIKeyRequest,
): Promise<CreateAPIKeyResponse> {
	const { data } = await apiClient.instance.post<
		SuccessEnvelope<CreateAPIKeyResponse>
	>("/users/me/api-keys", payload);
	return data.data;
}

export async function revokeAPIKey(id: string): Promise<void> {
	await apiClient.instance.delete(`/users/me/api-keys/${id}`);
}

/** Key prefix of every cached API key query — invalidate it after a change. */
export const apiKeysKey = ["api-keys"] as const;

/** One numbered page of the signed-in user's API keys — backs the keys table. */
export const apiKeysPageQueryOptions = (page: number, pageSize: number) =>
	queryOptions({
		queryKey: [...apiKeysKey, "page", page, pageSize] as const,
		queryFn: () => listAPIKeys({ page, pageSize }),
	});
