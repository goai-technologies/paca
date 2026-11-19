import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGet, mockPost, mockDelete } = vi.hoisted(() => ({
	mockGet: vi.fn(),
	mockPost: vi.fn(),
	mockDelete: vi.fn(),
}));

vi.mock("./api-client", () => ({
	apiClient: {
		instance: {
			get: mockGet,
			post: mockPost,
			delete: mockDelete,
		},
	},
}));

import {
	type APIKey,
	apiKeysPageQueryOptions,
	type CreateAPIKeyResponse,
	createAPIKey,
	listAPIKeys,
	revokeAPIKey,
} from "./apikey-api";

describe("apikey-api", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const mockKey: APIKey = {
		id: "key-1",
		name: "My Key",
		key_prefix: "paca_abc",
		last_used_at: null,
		expires_at: null,
		created_at: "2026-01-01T00:00:00.000Z",
	};

	describe("listAPIKeys", () => {
		it("calls GET /users/me/api-keys and unwraps data", async () => {
			mockGet.mockResolvedValue({
				data: {
					data: {
						items: [mockKey],
						page_size: 30,
						next_cursor: null,
						total_count: 1,
					},
					error_code: null,
					message: "ok",
				},
			});

			await expect(listAPIKeys()).resolves.toEqual({
				items: [mockKey],
				page_size: 30,
				next_cursor: null,
				total_count: 1,
			});
			expect(mockGet).toHaveBeenCalledWith("/users/me/api-keys", {
				params: { page_size: 30, page: undefined },
			});
		});

		it("throws when the API returns an error", async () => {
			mockGet.mockRejectedValue(new Error("Network Error"));
			await expect(listAPIKeys()).rejects.toThrow("Network Error");
		});
	});

	describe("createAPIKey", () => {
		it("calls POST /users/me/api-keys with payload and unwraps response", async () => {
			const created: CreateAPIKeyResponse = {
				...mockKey,
				key: "paca_abcdef1234567890",
			};
			mockPost.mockResolvedValue({
				data: { data: created, error_code: null, message: "ok" },
			});

			const payload = { name: "My Key" };
			await expect(createAPIKey(payload)).resolves.toEqual(created);
			expect(mockPost).toHaveBeenCalledWith("/users/me/api-keys", payload);
		});

		it("forwards optional expires_at field", async () => {
			const created: CreateAPIKeyResponse = {
				...mockKey,
				expires_at: "2027-01-01T00:00:00.000Z",
				key: "paca_xyz",
			};
			mockPost.mockResolvedValue({
				data: { data: created, error_code: null, message: "ok" },
			});

			const payload = {
				name: "Expiring Key",
				expires_at: "2027-01-01T00:00:00.000Z",
			};
			await expect(createAPIKey(payload)).resolves.toEqual(created);
			expect(mockPost).toHaveBeenCalledWith("/users/me/api-keys", payload);
		});

		it("throws when creation fails", async () => {
			mockPost.mockRejectedValue(new Error("Validation Failed"));
			await expect(createAPIKey({ name: "" })).rejects.toThrow(
				"Validation Failed",
			);
		});
	});

	describe("revokeAPIKey", () => {
		it("calls DELETE /users/me/api-keys/:id", async () => {
			mockDelete.mockResolvedValue({});

			await expect(revokeAPIKey("key-1")).resolves.toBeUndefined();
			expect(mockDelete).toHaveBeenCalledWith("/users/me/api-keys/key-1");
		});

		it("throws when revocation fails", async () => {
			mockDelete.mockRejectedValue(new Error("Not Found"));
			await expect(revokeAPIKey("invalid")).rejects.toThrow("Not Found");
		});
	});

	describe("apiKeysPageQueryOptions", () => {
		it("has the expected query key", () => {
			expect(apiKeysPageQueryOptions(2, 50).queryKey).toEqual([
				"api-keys",
				"page",
				2,
				50,
			]);
		});

		it("uses listAPIKeys as the query function", async () => {
			mockGet.mockResolvedValue({
				data: {
					data: {
						items: [mockKey],
						page_size: 30,
						next_cursor: null,
						total_count: 1,
					},
					error_code: null,
					message: "ok",
				},
			});

			if (typeof apiKeysPageQueryOptions(2, 50).queryFn !== "function") {
				throw new Error("queryFn is not a function");
			}

			// @ts-expect-error - queryFn type can be complex but it's a function here
			const result = await apiKeysPageQueryOptions(2, 50).queryFn({
				queryKey: ["api-keys", "page", 2, 50],
				meta: undefined,
			});
			expect(result).toEqual({
				items: [mockKey],
				page_size: 30,
				next_cursor: null,
				total_count: 1,
			});
		});
	});
});
