import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	type CommitmentCatalog,
	commitmentCatalogAllQueryOptions,
} from "@/lib/commitment-api";
import type { Task } from "@/lib/interaction-api";
import {
	type Project,
	projectsLookupInfiniteQueryOptions,
	type TaskType,
} from "@/lib/project-api";
import { getPriority } from "../priority";
import { PropertiesPanel } from "./properties-panel";

// PropertiesPanel's epic picker calls useEpicSearch (useInfiniteQuery)
// unconditionally, so it needs a QueryClientProvider ancestor even though the
// query stays disabled (the dropdown is never opened) in these tests.
function wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeTask = (overrides: Partial<Task> = {}): Task => ({
	id: "task-1",
	project_id: "proj-1",
	title: "Fix the login bug",
	task_number: 1,
	sprint_id: null,
	status_id: null,
	task_type_id: "type-task",
	parent_task_id: null,
	description: null,
	importance: 0,
	assignee_ids: [],
	reporter_id: null,
	custom_fields: {},
	view_position: null,
	view_group_key: null,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	assignment_mode: "manual",
	...overrides,
});

const epicType: TaskType = {
	id: "type-epic",
	project_id: "proj-1",
	name: "Epic",
	icon: null,
	color: "#8b5cf6",
	description: null,
	is_system: true,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const storyType: TaskType = {
	id: "type-story",
	project_id: "proj-1",
	name: "Story",
	icon: null,
	color: "#22c55e",
	description: null,
	is_system: false,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const TASK_TYPES = [epicType, storyType];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PropertiesPanel epic field", () => {
	it("resolves the epic from epicTasks when it's already paginated", () => {
		const epic = makeTask({
			id: "epic-1",
			title: "Epic Already Loaded",
			task_type_id: "type-epic",
		});
		const task = makeTask({ parent_task_id: "epic-1" });

		render(
			<PropertiesPanel
				task={task}
				status={undefined}
				taskType={storyType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={TASK_TYPES}
				taskRole="normal"
				epicTasks={[epic]}
			/>,
			{ wrapper },
		);

		expect(screen.getByText("Epic Already Loaded")).toBeInTheDocument();
	});

	it("falls back to parentTask when the epic isn't in the paginated epicTasks list", () => {
		// Regression test for the bug fixed in this change: epicTasks is
		// paginated 20-per-page, so a task's own epic can legitimately be
		// missing from it. The field must still resolve via parentTask
		// (fetched directly, independent of pagination) instead of rendering
		// as unset.
		const parentTask = makeTask({
			id: "epic-1",
			title: "Unpaginated Epic",
			task_type_id: "type-epic",
		});
		const task = makeTask({ parent_task_id: "epic-1" });

		render(
			<PropertiesPanel
				task={task}
				status={undefined}
				taskType={storyType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={TASK_TYPES}
				taskRole="normal"
				epicTasks={[]}
				parentTask={parentTask}
			/>,
			{ wrapper },
		);

		expect(screen.getByText("Unpaginated Epic")).toBeInTheDocument();
		// It must resolve via the Epic field specifically, not the generic
		// Parent field (which is where pre-fix code rendered it, since it only
		// checked epicTasks membership rather than parentTask's actual type).
		expect(screen.queryByText("Parent")).not.toBeInTheDocument();
	});

	it("does not fall back to parentTask when it isn't Epic-typed", () => {
		// A non-epic parentTask (story/task nesting) is a legitimate value for
		// the *Parent* field, but must never be picked up by the Epic field's
		// fallback. If it were, "Nested Story" would render twice: once
		// (wrongly) as the epic and once (correctly) in the Parent field.
		const parentTask = makeTask({
			id: "story-1",
			title: "Nested Story",
			task_type_id: "type-story",
		});
		const task = makeTask({ parent_task_id: "story-1" });

		render(
			<PropertiesPanel
				task={task}
				status={undefined}
				taskType={storyType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={TASK_TYPES}
				taskRole="normal"
				epicTasks={[]}
				parentTask={parentTask}
			/>,
			{ wrapper },
		);

		expect(screen.getAllByText("Nested Story")).toHaveLength(1);
	});
});

describe("PropertiesPanel parent field", () => {
	it("shows the Parent field when parentTask is not Epic-typed", () => {
		const parentTask = makeTask({
			id: "story-1",
			title: "Parent Story",
			task_type_id: "type-story",
		});
		const task = makeTask({ parent_task_id: "story-1" });

		render(
			<PropertiesPanel
				task={task}
				status={undefined}
				taskType={storyType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={TASK_TYPES}
				taskRole="normal"
				epicTasks={[]}
				parentTask={parentTask}
			/>,
			{ wrapper },
		);

		expect(screen.getByText("Parent Story")).toBeInTheDocument();
	});

	it("hides the Parent field when parentTask is Epic-typed but absent from paginated epicTasks", () => {
		// Regression test: previously this checked `epicTasks.find(...)`, so an
		// unpaginated epic parent would be misclassified as a generic "Parent"
		// instead of being recognized as the task's epic.
		const parentTask = makeTask({
			id: "epic-1",
			title: "Unpaginated Epic",
			task_type_id: "type-epic",
		});
		const task = makeTask({ parent_task_id: "epic-1" });

		render(
			<PropertiesPanel
				task={task}
				status={undefined}
				taskType={storyType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={TASK_TYPES}
				taskRole="normal"
				epicTasks={[]}
				parentTask={parentTask}
			/>,
			{ wrapper },
		);

		expect(screen.queryByText("Parent")).not.toBeInTheDocument();
		// The epic field should be the one rendering it, not a generic parent field.
		expect(screen.getByText("Unpaginated Epic")).toBeInTheDocument();
	});
});

// ── Commitment Project field ─────────────────────────────────────────────────

const COMMITMENTS_PROJECT_ID = "proj-commitments";

const commitmentType: TaskType = {
	id: "type-commitment",
	project_id: COMMITMENTS_PROJECT_ID,
	name: "Commitment",
	icon: null,
	color: "#0ea5e9",
	description: null,
	is_system: false,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

const makeProject = (id: string, name: string, prefix: string): Project => ({
	id,
	name,
	description: "",
	task_id_prefix: prefix,
	settings: {},
	jev_configured: false,
	jev_base_url: "",
	jev_model: "",
	created_at: "2026-01-01T00:00:00Z",
});

const PROJECTS: Project[] = [
	makeProject(COMMITMENTS_PROJECT_ID, "Commitments", "COM"),
	makeProject("proj-portal", "Customer portal", "OPS"),
	makeProject("proj-billing", "Billing", "BIL"),
];

/**
 * A QueryClient that already holds the commitment catalog (which names the
 * Commitments project) and the project list, so nothing is fetched.
 */
function seededWrapper(catalog: Partial<CommitmentCatalog> = {}) {
	const qc = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
	qc.setQueryData(commitmentCatalogAllQueryOptions().queryKey, {
		items: [],
		commitments_project_id: COMMITMENTS_PROJECT_ID,
		task_id_prefix: "COM",
		...catalog,
	});
	qc.setQueryData(projectsLookupInfiniteQueryOptions().queryKey, {
		pages: [
			{ items: PROJECTS, total: PROJECTS.length, page: 1, page_size: 50 },
		],
		pageParams: [1],
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
}

const makeCommitment = (overrides: Partial<Task> = {}): Task =>
	makeTask({
		id: "commitment-1",
		project_id: COMMITMENTS_PROJECT_ID,
		title: "Launch the customer portal",
		task_type_id: "type-commitment",
		...overrides,
	});

describe("PropertiesPanel commitment Project field", () => {
	it("shows the Project field on a commitment in the Commitments project", () => {
		render(
			<PropertiesPanel
				task={makeCommitment()}
				status={undefined}
				taskType={commitmentType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
			/>,
			{ wrapper: seededWrapper() },
		);

		expect(screen.getByText("Project")).toBeInTheDocument();
		expect(
			screen.getByTitle("Which project this commitment is for"),
		).toHaveTextContent("None");
	});

	it("hides the Project field on a Commitment-typed task outside the Commitments project", () => {
		render(
			<PropertiesPanel
				task={makeCommitment({ project_id: "proj-portal" })}
				status={undefined}
				taskType={{ ...commitmentType, project_id: "proj-portal" }}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
			/>,
			{ wrapper: seededWrapper() },
		);

		expect(screen.queryByText("Project")).not.toBeInTheDocument();
	});

	it("hides the Project field on any other type, even in the Commitments project", () => {
		render(
			<PropertiesPanel
				task={makeTask({
					project_id: COMMITMENTS_PROJECT_ID,
					task_type_id: "type-story",
				})}
				status={undefined}
				taskType={storyType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={TASK_TYPES}
			/>,
			{ wrapper: seededWrapper() },
		);

		expect(screen.queryByText("Project")).not.toBeInTheDocument();
		expect(screen.getByText("Commitment")).toBeInTheDocument();
	});

	it("shows the current project's name and prefix", () => {
		render(
			<PropertiesPanel
				task={makeCommitment({ home_project_id: "proj-portal" })}
				status={undefined}
				taskType={commitmentType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
			/>,
			{ wrapper: seededWrapper() },
		);

		const trigger = screen.getByTitle("Which project this commitment is for");
		expect(trigger).toHaveTextContent("Customer portal");
		expect(trigger).toHaveTextContent("OPS");
	});

	it("falls back to the catalog's name for a project the reader cannot list", () => {
		render(
			<PropertiesPanel
				task={makeCommitment({ home_project_id: "proj-hidden" })}
				status={undefined}
				taskType={commitmentType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
			/>,
			{
				wrapper: seededWrapper({
					items: [
						{
							id: "commitment-1",
							project_id: COMMITMENTS_PROJECT_ID,
							task_id_prefix: "COM",
							task_number: 1,
							ref: "COM-1",
							title: "Launch the customer portal",
							is_closed: false,
							custom_fields: {},
							home_project_id: "proj-hidden",
							home_project_name: "Data platform",
							home_project_task_id_prefix: "DAT",
						},
					],
				}),
			},
		);

		expect(
			screen.getByTitle("Which project this commitment is for"),
		).toHaveTextContent("Data platform");
	});

	it("shows a muted Unknown project for a project that no longer resolves", () => {
		render(
			<PropertiesPanel
				task={makeCommitment({ home_project_id: "proj-deleted" })}
				status={undefined}
				taskType={commitmentType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
			/>,
			{ wrapper: seededWrapper() },
		);

		expect(screen.getByText("Unknown project")).toBeInTheDocument();
	});

	it("offers every project except the Commitments project and sends the chosen id", async () => {
		const onUpdate = vi.fn();
		const user = userEvent.setup();
		render(
			<PropertiesPanel
				task={makeCommitment()}
				status={undefined}
				taskType={commitmentType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
				onUpdate={onUpdate}
			/>,
			{ wrapper: seededWrapper() },
		);

		await user.click(screen.getByTitle("Which project this commitment is for"));
		const options = await screen.findAllByRole("menuitem");
		// Sorted by name; the Commitments project is never offered.
		expect(options.map((o) => o.textContent)).toEqual([
			"BillingBIL",
			"Customer portalOPS",
		]);

		await user.click(screen.getByRole("menuitem", { name: /Customer portal/ }));
		expect(onUpdate).toHaveBeenCalledWith({ home_project_id: "proj-portal" });
	});

	it("searches projects by name and clears the value", async () => {
		const onUpdate = vi.fn();
		const user = userEvent.setup();
		render(
			<PropertiesPanel
				task={makeCommitment({ home_project_id: "proj-portal" })}
				status={undefined}
				taskType={commitmentType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
				onUpdate={onUpdate}
			/>,
			{ wrapper: seededWrapper() },
		);

		await user.click(screen.getByTitle("Which project this commitment is for"));
		fireEvent.change(await screen.findByPlaceholderText("Search projects…"), {
			target: { value: "bill" },
		});
		expect(
			screen.queryByRole("menuitem", { name: /Customer portal/ }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /Billing/ }),
		).toBeInTheDocument();

		await user.click(screen.getByRole("menuitem", { name: "Clear project" }));
		expect(onUpdate).toHaveBeenCalledWith({ home_project_id: null });
	});

	it("is read-only without edit rights", () => {
		render(
			<PropertiesPanel
				task={makeCommitment({ home_project_id: "proj-portal" })}
				status={undefined}
				taskType={commitmentType}
				priority={getPriority(0)}
				reporter={undefined}
				taskTypes={[commitmentType]}
				canEdit={false}
			/>,
			{ wrapper: seededWrapper() },
		);

		const value = screen.getByTitle("Which project this commitment is for");
		expect(value).toHaveTextContent("Customer portal");
		expect(value.tagName).not.toBe("BUTTON");
	});
});
