import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/index.js", () => ({
	formatProject: vi.fn((p: any) => `project:${p.id}`),
	formatList: vi.fn((items: any[], fn: any) => items.map(fn).join("---")),
}));

import {
	getProjectTools,
	handleProjectTool,
} from "../../tools/project-tools.js";

const proj = {
	id: "p1",
	name: "Alpha",
	description: "desc",
	task_id_prefix: "AL",
	settings: {},
	created_at: "2024-01-01T00:00:00Z",
};

function makeClient(overrides: Record<string, any> = {}) {
	return {
		listProjects: vi
			.fn()
			.mockResolvedValue({ items: [proj], nextCursor: null }),
		getProject: vi.fn().mockResolvedValue(proj),
		createProject: vi.fn().mockResolvedValue(proj),
		updateProject: vi.fn().mockResolvedValue({ ...proj, name: "Beta" }),
		deleteProject: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as any;
}

// ---------------------------------------------------------------------------
// getProjectTools
// ---------------------------------------------------------------------------

describe("getProjectTools", () => {
	it("returns exactly 5 tools", () => {
		expect(getProjectTools()).toHaveLength(5);
	});

	it("includes list_projects, get_project, create_project, update_project, delete_project", () => {
		const names = getProjectTools().map((t) => t.name);
		expect(names).toContain("list_projects");
		expect(names).toContain("get_project");
		expect(names).toContain("create_project");
		expect(names).toContain("update_project");
		expect(names).toContain("delete_project");
	});
});

// ---------------------------------------------------------------------------
// handleProjectTool – list_projects
// ---------------------------------------------------------------------------

describe("handleProjectTool – list_projects", () => {
	it("calls client.listProjects and returns formatted text", async () => {
		const client = makeClient();
		const result = await handleProjectTool("list_projects", {}, client);
		expect(client.listProjects).toHaveBeenCalledWith({
			cursor: undefined,
			pageSize: undefined,
		});
		expect(result.content[0].text).toContain("project:p1");
	});

	it("points the agent at the next page instead of reading it", async () => {
		const client = makeClient({
			listProjects: vi
				.fn()
				.mockResolvedValue({ items: [proj], nextCursor: "2", total: 120 }),
		});
		const result = await handleProjectTool("list_projects", {}, client);
		expect(client.listProjects).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain('cursor="2"');
	});

	it("returns a Projects: header in the response", async () => {
		const result = await handleProjectTool("list_projects", {}, makeClient());
		expect(result.content[0].text).toContain("Projects:");
	});
});

// ---------------------------------------------------------------------------
// handleProjectTool – get_project
// ---------------------------------------------------------------------------

describe("handleProjectTool – get_project", () => {
	it("calls client.getProject with the parsed projectId", async () => {
		const client = makeClient();
		await handleProjectTool("get_project", { projectId: "p1" }, client);
		expect(client.getProject).toHaveBeenCalledWith("p1");
	});

	it("returns formatted project text", async () => {
		const result = await handleProjectTool(
			"get_project",
			{ projectId: "p1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("project:p1");
	});

	it("throws ZodError when projectId is missing", async () => {
		await expect(
			handleProjectTool("get_project", {}, makeClient()),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// handleProjectTool – create_project
// ---------------------------------------------------------------------------

describe("handleProjectTool – create_project", () => {
	it("calls client.createProject with name and description", async () => {
		const client = makeClient();
		await handleProjectTool(
			"create_project",
			{ name: "Alpha", description: "A desc" },
			client,
		);
		expect(client.createProject).toHaveBeenCalledWith({
			name: "Alpha",
			description: "A desc",
		});
	});

	it("includes 'created successfully' in the response", async () => {
		const result = await handleProjectTool(
			"create_project",
			{ name: "Alpha" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("created successfully");
	});

	it("throws ZodError when name is missing", async () => {
		await expect(
			handleProjectTool("create_project", {}, makeClient()),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// handleProjectTool – update_project
// ---------------------------------------------------------------------------

describe("handleProjectTool – update_project", () => {
	it("calls client.updateProject with projectId and optional fields", async () => {
		const client = makeClient();
		await handleProjectTool(
			"update_project",
			{ projectId: "p1", name: "Beta" },
			client,
		);
		expect(client.updateProject).toHaveBeenCalledWith("p1", {
			name: "Beta",
			description: undefined,
		});
	});

	it("includes 'updated successfully' in the response", async () => {
		const result = await handleProjectTool(
			"update_project",
			{ projectId: "p1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("updated successfully");
	});
});

// ---------------------------------------------------------------------------
// handleProjectTool – delete_project
// ---------------------------------------------------------------------------

describe("handleProjectTool – delete_project", () => {
	it("calls client.deleteProject with the projectId", async () => {
		const client = makeClient();
		await handleProjectTool("delete_project", { projectId: "p1" }, client);
		expect(client.deleteProject).toHaveBeenCalledWith("p1");
	});

	it("includes 'deleted successfully' in the response", async () => {
		const result = await handleProjectTool(
			"delete_project",
			{ projectId: "p1" },
			makeClient(),
		);
		expect(result.content[0].text).toContain("deleted successfully");
	});
});

// ---------------------------------------------------------------------------
// handleProjectTool – unknown tool
// ---------------------------------------------------------------------------

describe("handleProjectTool – unknown tool", () => {
	it("throws for an unknown tool name", async () => {
		await expect(
			handleProjectTool("unknown_tool", {}, makeClient()),
		).rejects.toThrow("Unknown project tool");
	});
});
