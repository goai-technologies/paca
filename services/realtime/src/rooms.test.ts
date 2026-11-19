import { describe, expect, it } from "bun:test";

import { syncProjectRooms } from "./rooms.ts";

function fakeSocket(initial: string[] = []) {
	const rooms = new Set(initial);
	return {
		rooms,
		join: (r: string) => rooms.add(r),
		leave: (r: string) => rooms.delete(r),
	};
}

describe("syncProjectRooms", () => {
	it("joins the rooms the effective actions allow, including child-only grants", () => {
		const s = fakeSocket();
		const joined = syncProjectRooms(s, "p1", {
			"tasks:read": true,
			"views:read": true,
		});
		expect(joined.sort()).toEqual(["tasks", "views"]);
		expect([...s.rooms].sort()).toEqual([
			"project:p1:tasks",
			"project:p1:views",
		]);
	});

	it("takes the socket out of rooms whose action was revoked", () => {
		const s = fakeSocket(["project:p1:tasks", "project:p1:docs", "other"]);
		syncProjectRooms(s, "p1", { "tasks:read": true });
		expect([...s.rooms].sort()).toEqual(["other", "project:p1:tasks"]);
	});

	it("leaves every room of the project for a non-member, and no other project's", () => {
		const s = fakeSocket(["project:p1:tasks", "project:p2:tasks"]);
		expect(syncProjectRooms(s, "p1", null)).toEqual([]);
		expect([...s.rooms]).toEqual(["project:p2:tasks"]);
	});
});
