import { afterEach, describe, expect, it } from "bun:test";

import { fetchProjectPermissions } from "./api-client.ts";
import { hasProjectPermission, NAMESPACE_PERMISSIONS } from "./permissions.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function mockFetch(status: number, body: unknown, seen?: string[]) {
	globalThis.fetch = (async (url: string) => {
		seen?.push(String(url));
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
}

describe("fetchProjectPermissions", () => {
	it("turns the actions list into an action -> true map, project-wide scope", async () => {
		const seen: string[] = [];
		mockFetch(200, { data: { actions: ["tasks:read", "docs:read"] } }, seen);
		const perms = await fetchProjectPermissions("http://api", "tok", "p1");
		expect(perms).toEqual({ "tasks:read": true, "docs:read": true });
		expect(seen[0]).toContain(
			"/projects/p1/members/me/permissions?scope=project",
		);
	});

	it("returns an empty map when no actions come back", async () => {
		mockFetch(200, { data: {} });
		expect(await fetchProjectPermissions("http://api", "tok", "p1")).toEqual(
			{},
		);
	});

	it("returns null for a non-member (404)", async () => {
		mockFetch(404, {});
		expect(await fetchProjectPermissions("http://api", "tok", "p1")).toBeNull();
	});

	it("throws on other failures", async () => {
		mockFetch(500, {});
		await expect(
			fetchProjectPermissions("http://api", "tok", "p1"),
		).rejects.toThrow();
	});
});

describe("namespace permissions", () => {
	it("use domain:action names that the API actions satisfy", () => {
		for (const required of Object.values(NAMESPACE_PERMISSIONS)) {
			expect(required).toContain(":");
			expect(hasProjectPermission({ [required]: true }, required)).toBe(true);
		}
		expect(hasProjectPermission({ "tasks:*": true }, "tasks:read")).toBe(true);
		expect(hasProjectPermission({ "docs:read": true }, "tasks:read")).toBe(
			false,
		);
	});
});
