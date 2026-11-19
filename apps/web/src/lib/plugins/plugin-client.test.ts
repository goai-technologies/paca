import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api-client";
import { createPluginApiClient } from "./plugin-client";

function stubFetch(data: unknown) {
	const fetchMock = vi.fn().mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => ({ success: true, data }),
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("plugin api client tasks", () => {
	const page = {
		items: [{ id: "t1" }, { id: "t2" }],
		page_size: 200,
		next_cursor: "c2",
		total_count: 450,
	};

	it("listTasksPage keeps the cursor and total so a plugin can read on", async () => {
		const fetchMock = stubFetch(page);
		const api = createPluginApiClient("p1");

		await expect(
			api.listTasksPage({ cursor: "c1", sprint_id: "s1" }),
		).resolves.toEqual(page);

		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.pathname).toBe("/api/v1/projects/p1/tasks");
		expect(url.searchParams.get("cursor")).toBe("c1");
		expect(url.searchParams.get("sprint_id")).toBe("s1");
		expect(url.searchParams.get("page_size")).toBe("200");
	});

	it("listTasks still returns the plain first-page array", async () => {
		stubFetch(page);
		const api = createPluginApiClient("p1");
		await expect(api.listTasks()).resolves.toEqual(page.items);
	});

	it("ignores the old numbered `page` filter, which the task list does not take", async () => {
		const fetchMock = stubFetch(page);
		await createPluginApiClient("p1").listTasksPage({ page: 3 });
		const url = new URL(fetchMock.mock.calls[0][0] as string);
		expect(url.searchParams.has("page")).toBe(false);
	});
});

describe("plugin api client session renewal", () => {
	const unauthorized = {
		ok: false,
		status: 401,
		text: async () => '{"error_code":"AUTH_UNAUTHENTICATED"}',
	};
	const okResponse = {
		ok: true,
		status: 200,
		json: async () => ({ success: true, data: { done: true } }),
	};

	it("refreshes the session and retries once after a 401", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(unauthorized)
			.mockResolvedValueOnce(okResponse);
		vi.stubGlobal("fetch", fetchMock);
		const refresh = vi
			.spyOn(apiClient, "refreshSession")
			.mockResolvedValue(undefined);

		await expect(
			createPluginApiClient().pluginPost("com.paca.x", "/apps/callback", {
				a: 1,
			}),
		).resolves.toEqual({ done: true });

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		refresh.mockRestore();
	});

	it("reports the 401 when the session cannot be refreshed", async () => {
		const fetchMock = vi.fn().mockResolvedValue(unauthorized);
		vi.stubGlobal("fetch", fetchMock);
		const refresh = vi
			.spyOn(apiClient, "refreshSession")
			.mockRejectedValue(new Error("refresh failed"));

		await expect(
			createPluginApiClient().pluginGet("com.paca.x", "/apps"),
		).rejects.toThrow(/401/);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		refresh.mockRestore();
	});

	it("does not retry other failures", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			text: async () => "forbidden",
		});
		vi.stubGlobal("fetch", fetchMock);
		const refresh = vi.spyOn(apiClient, "refreshSession");

		await expect(
			createPluginApiClient().pluginGet("com.paca.x", "/apps"),
		).rejects.toThrow(/403/);

		expect(refresh).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		refresh.mockRestore();
	});
});
