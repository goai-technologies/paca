import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/index.js", () => ({
	blocknoteToMarkdown: vi.fn(() => "comment markdown"),
}));

import {
	getTaskActivityTools,
	handleTaskActivityTool,
} from "../../tools/task-activity-tools.js";

const activity = {
	id: "act-1",
	activity_type: "status_change",
	actor_id: "user-1",
	actor_name: "Alice",
	content: { field: "status", old: "todo", new: "done" },
	created_at: "2024-01-01T00:00:00Z",
};

const comment = {
	id: "cmt-1",
	activity_type: "comment",
	actor_id: "user-1",
	actor_name: "Bob",
	content: null,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-02T00:00:00Z",
};

function makeClient(overrides: Record<string, any> = {}) {
	return {
		listTaskActivities: vi
			.fn()
			.mockResolvedValue({ items: [activity], nextCursor: null }),
		addTaskComment: vi.fn().mockResolvedValue(comment),
		updateTaskComment: vi
			.fn()
			.mockResolvedValue({ ...comment, content: "updated" }),
		deleteTaskComment: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as any;
}

// ---------------------------------------------------------------------------
// getTaskActivityTools
// ---------------------------------------------------------------------------

describe("getTaskActivityTools", () => {
	it("returns 4 tools", () => {
		expect(getTaskActivityTools()).toHaveLength(4);
	});

	it("includes all expected tool names", () => {
		const names = getTaskActivityTools().map((t) => t.name);
		expect(names).toContain("list_task_activities");
		expect(names).toContain("add_task_comment");
		expect(names).toContain("update_task_comment");
		expect(names).toContain("delete_task_comment");
	});
});

// ---------------------------------------------------------------------------
// list_task_activities
// ---------------------------------------------------------------------------

describe("handleTaskActivityTool – list_task_activities", () => {
	it("calls client.listTaskActivities with projectId and taskId", async () => {
		const client = makeClient();
		await handleTaskActivityTool(
			"list_task_activities",
			{ projectId: "p1", taskId: "t1" },
			client,
		);
		expect(client.listTaskActivities).toHaveBeenCalledWith("p1", "t1", {
			cursor: undefined,
			pageSize: undefined,
		});
	});

	it("tells the agent how to reach older activity", async () => {
		const client = makeClient({
			listTaskActivities: vi
				.fn()
				.mockResolvedValue({ items: [activity], nextCursor: "older" }),
		});
		const result = await handleTaskActivityTool(
			"list_task_activities",
			{ projectId: "p1", taskId: "t1" },
			client,
		);
		expect(result.content[0].text).toContain(
			'call list_task_activities again with cursor="older"',
		);
	});

	it("includes 'Task Activities:' header and activity type in response", async () => {
		const result = await handleTaskActivityTool(
			"list_task_activities",
			{ projectId: "p1", taskId: "t1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("Task Activities");
		expect(result.content[0].text).toContain("status_change");
	});

	it("throws ZodError when required args are missing", async () => {
		await expect(
			handleTaskActivityTool(
				"list_task_activities",
				{ projectId: "p1" },
				makeClient(),
			),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// add_task_comment
// ---------------------------------------------------------------------------

describe("handleTaskActivityTool – add_task_comment", () => {
	it("calls client.addTaskComment with projectId, taskId, and content", async () => {
		const client = makeClient();
		await handleTaskActivityTool(
			"add_task_comment",
			{ projectId: "p1", taskId: "t1", content: "LGTM" },
			client,
		);
		expect(client.addTaskComment).toHaveBeenCalledWith("p1", "t1", {
			content: "LGTM",
		});
	});

	it("includes 'added successfully' in the response", async () => {
		const result = await handleTaskActivityTool(
			"add_task_comment",
			{ projectId: "p1", taskId: "t1", content: "LGTM" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("added successfully");
	});

	it("throws ZodError when content is missing", async () => {
		await expect(
			handleTaskActivityTool(
				"add_task_comment",
				{ projectId: "p1", taskId: "t1" },
				makeClient(),
			),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// update_task_comment
// ---------------------------------------------------------------------------

describe("handleTaskActivityTool – update_task_comment", () => {
	it("calls client.updateTaskComment with all four IDs and content", async () => {
		const client = makeClient();
		await handleTaskActivityTool(
			"update_task_comment",
			{ projectId: "p1", taskId: "t1", commentId: "cmt-1", content: "edited" },
			client,
		);
		expect(client.updateTaskComment).toHaveBeenCalledWith("p1", "t1", "cmt-1", {
			content: "edited",
		});
	});

	it("includes 'updated successfully' in the response", async () => {
		const result = await handleTaskActivityTool(
			"update_task_comment",
			{ projectId: "p1", taskId: "t1", commentId: "cmt-1", content: "edited" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("updated successfully");
	});
});

// ---------------------------------------------------------------------------
// delete_task_comment
// ---------------------------------------------------------------------------

describe("handleTaskActivityTool – delete_task_comment", () => {
	it("calls client.deleteTaskComment with projectId, taskId, and commentId", async () => {
		const client = makeClient();
		await handleTaskActivityTool(
			"delete_task_comment",
			{ projectId: "p1", taskId: "t1", commentId: "cmt-1" },
			client,
		);
		expect(client.deleteTaskComment).toHaveBeenCalledWith("p1", "t1", "cmt-1");
	});

	it("includes 'deleted successfully' and commentId in the response", async () => {
		const result = await handleTaskActivityTool(
			"delete_task_comment",
			{ projectId: "p1", taskId: "t1", commentId: "cmt-1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("cmt-1");
		expect(result.content[0].text).toContain("deleted successfully");
	});
});

// ---------------------------------------------------------------------------
// unknown tool
// ---------------------------------------------------------------------------

describe("handleTaskActivityTool – unknown tool", () => {
	it("throws for an unknown tool name", async () => {
		await expect(
			handleTaskActivityTool("unknown", {}, makeClient()),
		).rejects.toThrow("Unknown task activity tool");
	});
});
