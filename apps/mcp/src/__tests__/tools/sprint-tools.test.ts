import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/index.js", () => ({
	formatSprint: vi.fn((s: any) => `sprint:${s.id}`),
	formatList: vi.fn((items: any[], fn: any) => items.map(fn).join("---")),
}));

import { getSprintTools, handleSprintTool } from "../../tools/sprint-tools.js";

const sprint = {
	id: "s1",
	project_id: "p1",
	name: "Sprint 1",
	status: "active" as const,
	created_at: "2024-01-01T00:00:00Z",
	updated_at: "2024-01-02T00:00:00Z",
};

function makeClient(overrides: Record<string, any> = {}) {
	return {
		listSprints: vi
			.fn()
			.mockResolvedValue({ items: [sprint], nextCursor: null }),
		getSprint: vi.fn().mockResolvedValue(sprint),
		createSprint: vi.fn().mockResolvedValue(sprint),
		updateSprint: vi.fn().mockResolvedValue({ ...sprint, name: "Sprint 2" }),
		deleteSprint: vi.fn().mockResolvedValue(undefined),
		completeSprint: vi
			.fn()
			.mockResolvedValue({ ...sprint, status: "completed" }),
		...overrides,
	} as any;
}

// ---------------------------------------------------------------------------
// getSprintTools
// ---------------------------------------------------------------------------

describe("getSprintTools", () => {
	it("returns 6 tools", () => {
		expect(getSprintTools()).toHaveLength(6);
	});
});

// ---------------------------------------------------------------------------
// list_sprints
// ---------------------------------------------------------------------------

describe("handleSprintTool – list_sprints", () => {
	it("calls client.listSprints with projectId", async () => {
		const client = makeClient();
		await handleSprintTool("list_sprints", { projectId: "p1" }, client);
		expect(client.listSprints).toHaveBeenCalledWith("p1", {
			cursor: undefined,
			pageSize: undefined,
		});
	});

	it("tells the agent how to fetch the next page, and passes the cursor on", async () => {
		const client = makeClient({
			listSprints: vi.fn().mockResolvedValue({
				items: [sprint],
				nextCursor: "c2",
				total: 7,
			}),
		});
		const result = await handleSprintTool(
			"list_sprints",
			{ projectId: "p1", cursor: "c1", pageSize: 1 },
			client,
		);
		expect(client.listSprints).toHaveBeenCalledWith("p1", {
			cursor: "c1",
			pageSize: 1,
		});
		const text = result.content[0].text;
		expect(text).toContain("Showing 1 of 7");
		expect(text).toContain('call list_sprints again with cursor="c2"');
	});

	it("returns formatted sprint list", async () => {
		const result = await handleSprintTool(
			"list_sprints",
			{ projectId: "p1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("sprint:s1");
	});

	it("throws ZodError when projectId is missing", async () => {
		await expect(
			handleSprintTool("list_sprints", {}, makeClient()),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// get_sprint
// ---------------------------------------------------------------------------

describe("handleSprintTool – get_sprint", () => {
	it("calls client.getSprint with projectId and sprintId", async () => {
		const client = makeClient();
		await handleSprintTool(
			"get_sprint",
			{ projectId: "p1", sprintId: "s1" },
			client,
		);
		expect(client.getSprint).toHaveBeenCalledWith("p1", "s1");
	});

	it("returns formatted sprint text", async () => {
		const result = await handleSprintTool(
			"get_sprint",
			{ projectId: "p1", sprintId: "s1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("sprint:s1");
	});
});

// ---------------------------------------------------------------------------
// create_sprint
// ---------------------------------------------------------------------------

describe("handleSprintTool – create_sprint", () => {
	it("calls client.createSprint with mapped fields", async () => {
		const client = makeClient();
		await handleSprintTool(
			"create_sprint",
			{
				projectId: "p1",
				name: "Sprint 1",
				startDate: "2024-01-01",
				endDate: "2024-01-14",
			},
			client,
		);
		expect(client.createSprint).toHaveBeenCalledWith({
			project_id: "p1",
			name: "Sprint 1",
			start_date: "2024-01-01",
			end_date: "2024-01-14",
			goal: undefined,
		});
	});

	it("passes goal through to client.createSprint", async () => {
		const client = makeClient();
		await handleSprintTool(
			"create_sprint",
			{
				projectId: "p1",
				name: "Sprint 1",
				startDate: "2024-01-01",
				endDate: "2024-01-14",
				goal: "Ship the demo",
			},
			client,
		);
		expect(client.createSprint).toHaveBeenCalledWith(
			expect.objectContaining({ goal: "Ship the demo" }),
		);
	});

	it("accepts goal null on create", async () => {
		const client = makeClient();
		await handleSprintTool(
			"create_sprint",
			{
				projectId: "p1",
				name: "Sprint 1",
				startDate: "2024-01-01",
				endDate: "2024-01-14",
				goal: null,
			},
			client,
		);
		expect(client.createSprint).toHaveBeenCalledWith(
			expect.objectContaining({ goal: null }),
		);
	});

	it("includes 'created successfully' in response", async () => {
		const result = await handleSprintTool(
			"create_sprint",
			{
				projectId: "p1",
				name: "S1",
				startDate: "2024-01-01",
				endDate: "2024-01-14",
			},
			makeClient(),
		);
		expect(result.content[0].text).toContain("created successfully");
	});

	it("throws ZodError when required fields are missing", async () => {
		await expect(
			handleSprintTool("create_sprint", { projectId: "p1" }, makeClient()),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// update_sprint
// ---------------------------------------------------------------------------

describe("handleSprintTool – update_sprint", () => {
	it("calls client.updateSprint with mapped optional fields", async () => {
		const client = makeClient();
		await handleSprintTool(
			"update_sprint",
			{ projectId: "p1", sprintId: "s1", name: "Sprint 2" },
			client,
		);
		expect(client.updateSprint).toHaveBeenCalledWith("p1", "s1", {
			name: "Sprint 2",
			start_date: undefined,
			end_date: undefined,
			goal: undefined,
		});
	});

	it("passes goal through to client.updateSprint", async () => {
		const client = makeClient();
		await handleSprintTool(
			"update_sprint",
			{ projectId: "p1", sprintId: "s1", goal: "Ship the demo" },
			client,
		);
		expect(client.updateSprint).toHaveBeenCalledWith(
			"p1",
			"s1",
			expect.objectContaining({ goal: "Ship the demo" }),
		);
	});

	it("passes goal null through to clear the goal", async () => {
		const client = makeClient();
		await handleSprintTool(
			"update_sprint",
			{ projectId: "p1", sprintId: "s1", goal: null },
			client,
		);
		expect(client.updateSprint).toHaveBeenCalledWith(
			"p1",
			"s1",
			expect.objectContaining({ goal: null }),
		);
	});

	it("sends an empty goal as null so the column is cleared, not blanked", async () => {
		const client = makeClient();
		await handleSprintTool(
			"update_sprint",
			{ projectId: "p1", sprintId: "s1", goal: "" },
			client,
		);
		expect(client.updateSprint).toHaveBeenCalledWith(
			"p1",
			"s1",
			expect.objectContaining({ goal: null }),
		);
	});

	it("includes 'updated successfully' in response", async () => {
		const result = await handleSprintTool(
			"update_sprint",
			{ projectId: "p1", sprintId: "s1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("updated successfully");
	});
});

// ---------------------------------------------------------------------------
// delete_sprint
// ---------------------------------------------------------------------------

describe("handleSprintTool – delete_sprint", () => {
	it("calls client.deleteSprint with projectId and sprintId", async () => {
		const client = makeClient();
		await handleSprintTool(
			"delete_sprint",
			{ projectId: "p1", sprintId: "s1" },
			client,
		);
		expect(client.deleteSprint).toHaveBeenCalledWith("p1", "s1");
	});

	it("includes 'deleted successfully' in response", async () => {
		const result = await handleSprintTool(
			"delete_sprint",
			{ projectId: "p1", sprintId: "s1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("deleted successfully");
	});
});

// ---------------------------------------------------------------------------
// complete_sprint
// ---------------------------------------------------------------------------

describe("handleSprintTool – complete_sprint", () => {
	it("calls client.completeSprint with projectId and sprintId", async () => {
		const client = makeClient();
		await handleSprintTool(
			"complete_sprint",
			{ projectId: "p1", sprintId: "s1" },
			client,
		);
		expect(client.completeSprint).toHaveBeenCalledWith("p1", "s1");
	});

	it("includes 'completed successfully' in response", async () => {
		const result = await handleSprintTool(
			"complete_sprint",
			{ projectId: "p1", sprintId: "s1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("completed successfully");
	});
});

// ---------------------------------------------------------------------------
// unknown tool
// ---------------------------------------------------------------------------

describe("handleSprintTool – unknown tool", () => {
	it("throws for an unknown tool name", async () => {
		await expect(
			handleSprintTool("nonexistent", {}, makeClient()),
		).rejects.toThrow("Unknown sprint tool");
	});
});
