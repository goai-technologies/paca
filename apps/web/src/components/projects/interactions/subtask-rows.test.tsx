import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/interaction-api";
import type { TaskStatus } from "@/lib/project-api";
import { SubtaskRows } from "./subtask-rows";
import { TaskRow } from "./task-row";

const get = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { get, post: vi.fn() } },
}));

const makeTask = (overrides: Partial<Task> = {}): Task => ({
	id: "t1",
	project_id: "p1",
	title: "Parent",
	task_number: 1,
	importance: 0,
	custom_fields: {},
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	assignment_mode: "manual",
	...overrides,
});

const statuses: TaskStatus[] = [];

function withClient(ui: React.ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("TaskRow subtask affordances", () => {
	it("shows a progress chip and toggles without opening the task", () => {
		const onToggle = vi.fn();
		const onClick = vi.fn();
		withClient(
			<TaskRow
				task={makeTask({ subtask_count: 5, subtask_done_count: 3 })}
				statuses={statuses}
				taskTypes={[]}
				visibleFields={[]}
				onClick={onClick}
				subtasks={{ expanded: false, onToggle }}
			/>,
		);
		expect(screen.getByText("3/5")).toBeTruthy();
		const toggle = screen.getByRole("button");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(toggle);
		expect(onToggle).toHaveBeenCalledOnce();
		expect(onClick).not.toHaveBeenCalled();
	});

	it("renders no chevron for a task without subtasks", () => {
		withClient(
			<TaskRow
				task={makeTask()}
				statuses={statuses}
				taskTypes={[]}
				visibleFields={[]}
				subtasks={{ expanded: false, onToggle: vi.fn() }}
			/>,
		);
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("SubtaskRows", () => {
	beforeEach(() => get.mockReset());

	it("fetches the parent's children with the view filters, ignoring sprint/type scope", async () => {
		get.mockResolvedValue({
			data: {
				data: {
					items: [makeTask({ id: "c1", title: "Child one" })],
					page_size: 50,
					next_cursor: null,
				},
			},
		});
		withClient(
			<SubtaskRows
				projectId="p1"
				parent={makeTask({ subtask_count: 1 })}
				depth={1}
				filters={{ statusIds: ["s1"], sortBy: "importance" }}
				filtersActive
				rowProps={{ statuses, taskTypes: [], visibleFields: [] }}
				statuses={statuses}
				creatableTypes={[]}
				canCreate={false}
				isExpanded={() => false}
				onToggle={vi.fn()}
				onTaskClick={vi.fn()}
			/>,
		);
		expect(await screen.findByText("Child one")).toBeTruthy();
		const params = get.mock.calls[0][1].params;
		expect(params.parent_task_id).toBe("t1");
		expect(params.status_ids).toBe("s1");
		expect(params.sort_by).toBe("importance");
		expect(params.sprint_id).toBeUndefined();
		expect(params.task_type_ids).toBeUndefined();
	});
});
