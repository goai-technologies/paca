import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemberDirectory } from "./member-directory";
import * as projectApi from "./project-api";

const member = (over: Partial<projectApi.ProjectMember>) =>
	({
		id: "m1",
		project_id: "p",
		user_id: "u1",
		roles: [],
		username: "alice",
		full_name: "Alice",
		...over,
	}) as projectApi.ProjectMember;

const page = (items: projectApi.ProjectMember[]) => ({
	items,
	page_size: 100,
	next_cursor: null,
	total_count: items.length,
});

describe("MemberDirectory", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("batches ids asked for together into one request and resolves both id kinds", async () => {
		const spy = vi
			.spyOn(projectApi, "listProjectMembers")
			.mockResolvedValue(page([member({})]));
		const dir = new MemberDirectory("p");

		expect(dir.get("m1")).toBeUndefined();
		expect(dir.get("u1")).toBeUndefined();
		expect(dir.get("m1")).toBeUndefined(); // no duplicate request while pending
		await vi.runAllTimersAsync();

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]?.ids).toEqual(["m1", "u1"]);
		expect(dir.get("m1")?.username).toBe("alice");
		expect(dir.get("u1")?.username).toBe("alice");
	});

	it("caches ids that are not members and does not ask again", async () => {
		const spy = vi
			.spyOn(projectApi, "listProjectMembers")
			.mockResolvedValue(page([]));
		const dir = new MemberDirectory("p");
		dir.get("gone");
		await vi.runAllTimersAsync();
		expect(dir.get("gone")).toBeUndefined();
		await vi.runAllTimersAsync();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("notifies subscribers when a batch lands", async () => {
		vi.spyOn(projectApi, "listProjectMembers").mockResolvedValue(
			page([member({})]),
		);
		const dir = new MemberDirectory("p");
		const listener = vi.fn();
		dir.subscribe(listener);
		dir.get("m1");
		await vi.runAllTimersAsync();
		expect(listener).toHaveBeenCalled();
	});

	it("retries failed lookups only after the retry delay", async () => {
		const spy = vi
			.spyOn(projectApi, "listProjectMembers")
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValue(page([member({})]));
		const dir = new MemberDirectory("p");
		dir.get("m1");
		await vi.runAllTimersAsync();
		dir.get("m1");
		await vi.runAllTimersAsync();
		expect(spy).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(16_000);
		dir.get("m1");
		await vi.runAllTimersAsync();
		expect(spy).toHaveBeenCalledTimes(2);
		expect(dir.get("m1")?.username).toBe("alice");
	});

	it("refetches in-use ids after invalidate", async () => {
		const spy = vi
			.spyOn(projectApi, "listProjectMembers")
			.mockResolvedValue(page([member({})]));
		const dir = new MemberDirectory("p");
		dir.get("m1");
		await vi.runAllTimersAsync();
		dir.invalidate();
		dir.get("m1");
		await vi.runAllTimersAsync();
		expect(spy).toHaveBeenCalledTimes(2);
	});
});
