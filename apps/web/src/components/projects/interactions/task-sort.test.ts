import { describe, expect, it } from "vitest";
import type { Task } from "@/lib/interaction-api";
import type { ProjectMember, TaskStatus } from "@/lib/project-api";
import { sortTasks } from "./task-sort";

function mockTask(partial: Partial<Task>): Task {
	return {
		id: `task-${Math.random().toString(36).substring(2, 9)}`,
		project_id: "proj-1",
		title: "Sample Task",
		task_number: 1,
		importance: 50,
		custom_fields: {},
		created_at: "2026-01-01T10:00:00Z",
		updated_at: "2026-01-01T10:00:00Z",
		assignment_mode: "manual",
		...partial,
	};
}

describe("task-sort", () => {
	it("returns identical order when field is manual or empty", () => {
		const t1 = mockTask({ id: "1", task_number: 10 });
		const t2 = mockTask({ id: "2", task_number: 5 });
		expect(sortTasks([t1, t2], "manual")).toEqual([t1, t2]);
		expect(sortTasks([t1, t2], undefined)).toEqual([t1, t2]);
	});

	it("sorts by card_id (task_number) asc and desc", () => {
		const t1 = mockTask({ id: "1", task_number: 10 });
		const t2 = mockTask({ id: "2", task_number: 5 });
		const t3 = mockTask({ id: "3", task_number: 20 });

		const asc = sortTasks([t1, t2, t3], "card_id", "asc");
		expect(asc.map((t) => t.task_number)).toEqual([5, 10, 20]);

		const desc = sortTasks([t1, t2, t3], "card_id", "desc");
		expect(desc.map((t) => t.task_number)).toEqual([20, 10, 5]);
	});

	it("sorts by priority (importance) asc and desc", () => {
		const low = mockTask({ id: "1", importance: 10 });
		const mid = mockTask({ id: "2", importance: 50 });
		const high = mockTask({ id: "3", importance: 100 });

		const asc = sortTasks([mid, high, low], "priority", "asc");
		expect(asc.map((t) => t.importance)).toEqual([10, 50, 100]);

		const desc = sortTasks([mid, high, low], "priority", "desc");
		expect(desc.map((t) => t.importance)).toEqual([100, 50, 10]);
	});

	it("sorts by status workflow position asc and desc", () => {
		const statuses: TaskStatus[] = [
			{
				id: "s-todo",
				project_id: "p1",
				name: "To Do",
				position: 1,
				category: "todo",
				is_default: true,
				created_at: "",
				updated_at: "",
			},
			{
				id: "s-progress",
				project_id: "p1",
				name: "In Progress",
				position: 2,
				category: "inprogress",
				is_default: false,
				created_at: "",
				updated_at: "",
			},
			{
				id: "s-done",
				project_id: "p1",
				name: "Done",
				position: 3,
				category: "done",
				is_default: false,
				created_at: "",
				updated_at: "",
			},
		];

		const t1 = mockTask({ id: "1", status_id: "s-done" });
		const t2 = mockTask({ id: "2", status_id: "s-todo" });
		const t3 = mockTask({ id: "3", status_id: "s-progress" });

		const asc = sortTasks([t1, t2, t3], "status", "asc", { statuses });
		expect(asc.map((t) => t.status_id)).toEqual([
			"s-todo",
			"s-progress",
			"s-done",
		]);

		const desc = sortTasks([t1, t2, t3], "status", "desc", { statuses });
		expect(desc.map((t) => t.status_id)).toEqual([
			"s-done",
			"s-progress",
			"s-todo",
		]);
	});

	it("sorts by created_at date asc and desc", () => {
		const t1 = mockTask({ id: "1", created_at: "2026-03-01T00:00:00Z" });
		const t2 = mockTask({ id: "2", created_at: "2026-01-01T00:00:00Z" });
		const t3 = mockTask({ id: "3", created_at: "2026-02-01T00:00:00Z" });

		const asc = sortTasks([t1, t2, t3], "created_at", "asc");
		expect(asc.map((t) => t.id)).toEqual(["2", "3", "1"]);

		const desc = sortTasks([t1, t2, t3], "created_at", "desc");
		expect(desc.map((t) => t.id)).toEqual(["1", "3", "2"]);
	});

	it("sorts by updated_at date asc and desc", () => {
		const t1 = mockTask({ id: "1", updated_at: "2026-05-01T00:00:00Z" });
		const t2 = mockTask({ id: "2", updated_at: "2026-02-01T00:00:00Z" });
		const t3 = mockTask({ id: "3", updated_at: "2026-04-01T00:00:00Z" });

		const asc = sortTasks([t1, t2, t3], "updated_at", "asc");
		expect(asc.map((t) => t.id)).toEqual(["2", "3", "1"]);

		const desc = sortTasks([t1, t2, t3], "updated_at", "desc");
		expect(desc.map((t) => t.id)).toEqual(["1", "3", "2"]);
	});

	it("sorts by assignee asc and desc, placing unassigned at end", () => {
		const m1: ProjectMember = {
			id: "u1",
			project_id: "p1",
			user_id: "u1",
			roles: [],
			full_name: "Alice",
			username: "alice",
			description: "",
		};
		const m2: ProjectMember = {
			id: "u2",
			project_id: "p1",
			user_id: "u2",
			roles: [],
			full_name: "Bob",
			username: "bob",
			description: "",
		};
		const m3: ProjectMember = {
			id: "u3",
			project_id: "p1",
			user_id: "u3",
			roles: [],
			full_name: "Charlie",
			username: "charlie",
			description: "",
		};

		const tBob = mockTask({ id: "1", assignees: [m2] });
		const tAlice = mockTask({ id: "2", assignees: [m1] });
		const tNone = mockTask({ id: "3", assignees: [] });
		const tCharlie = mockTask({ id: "4", assignees: [m3] });

		const asc = sortTasks([tBob, tNone, tCharlie, tAlice], "assignee", "asc");
		expect(asc.map((t) => t.id)).toEqual(["2", "1", "4", "3"]);

		const desc = sortTasks([tBob, tNone, tCharlie, tAlice], "assignee", "desc");
		expect(desc.map((t) => t.id)).toEqual(["4", "1", "2", "3"]);
	});
});
