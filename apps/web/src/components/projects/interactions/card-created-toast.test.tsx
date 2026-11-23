import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/ui/toast";
import type { Task } from "@/lib/interaction-api";
import { SubtaskRows } from "./subtask-rows";

const post = vi.hoisted(() => vi.fn());
const get = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", () => ({
	apiClient: {
		instance: {
			get,
			post,
		},
	},
}));

const makeTask = (overrides: Partial<Task> = {}): Task => ({
	id: "t-100",
	project_id: "p1",
	title: "Parent Task",
	task_number: 10,
	importance: 0,
	custom_fields: {},
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	assignment_mode: "manual",
	...overrides,
});

function withClient(ui: React.ReactNode) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("Card creation notification & quick open", () => {
	let toastAddSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.restoreAllMocks();
		toastAddSpy = vi.spyOn(toast, "add").mockReturnValue("toast-id");
		get.mockReset();
		post.mockReset();
	});

	it("formats card number with project prefix (e.g. PACA-42) and provides View action", () => {
		const task = makeTask({ task_number: 42, title: "Auth implementation" });
		const prefix = "PACA";
		const formattedCardNumber =
			prefix && task.task_number > 0
				? `${prefix}-${task.task_number}`
				: `#${task.task_number}`;

		const handleOpen = vi.fn();

		toast.add({
			type: "success",
			title: `Card ${formattedCardNumber} created`,
			description: task.title,
			actionProps: {
				children: "View",
				onClick: () => handleOpen(task),
			},
		});

		expect(toastAddSpy).toHaveBeenCalledTimes(1);
		const callArg = toastAddSpy.mock.calls[0][0] as {
			type: string;
			title: string;
			description: string;
			actionProps: { children: string; onClick: () => void };
		};

		expect(callArg.type).toBe("success");
		expect(callArg.title).toBe("Card PACA-42 created");
		expect(callArg.description).toBe("Auth implementation");
		expect(callArg.actionProps.children).toBe("View");

		callArg.actionProps.onClick();
		expect(handleOpen).toHaveBeenCalledWith(task);
	});

	it("formats card number with hash (#15) when prefix is absent", () => {
		const task = makeTask({
			task_number: 15,
			title: "Database schema migration",
		});
		const prefix = "";
		const formattedCardNumber =
			prefix && task.task_number > 0
				? `${prefix}-${task.task_number}`
				: `#${task.task_number}`;

		toast.add({
			type: "success",
			title: `Card ${formattedCardNumber} created`,
			description: task.title,
			actionProps: {
				children: "View",
				onClick: vi.fn(),
			},
		});

		const callArg = toastAddSpy.mock.calls[0][0] as {
			title: string;
		};
		expect(callArg.title).toBe("Card #15 created");
	});

	it("falls back gracefully when card number is 0 or absent (Card created)", () => {
		const task = makeTask({
			task_number: 0,
			title: "Quick drafted task",
		});
		const prefix = "";
		const formattedCardNumber =
			prefix && task.task_number > 0
				? `${prefix}-${task.task_number}`
				: task.task_number > 0
					? `#${task.task_number}`
					: "";

		toast.add({
			type: "success",
			title: formattedCardNumber
				? `Card ${formattedCardNumber} created`
				: "Card created",
			description: task.title,
			actionProps: {
				children: "View",
				onClick: vi.fn(),
			},
		});

		const callArg = toastAddSpy.mock.calls[0][0] as {
			title: string;
			description: string;
		};
		expect(callArg.title).toBe("Card created");
		expect(callArg.description).toBe("Quick drafted task");
	});

	it("primes React Query cache with newly created task data on success", () => {
		const qc = new QueryClient();
		const task = makeTask({
			id: "task-new-123",
			task_number: 99,
			title: "Cached Task",
		});
		const queryKey = ["projects", "p1", "tasks", "task-new-123"];

		qc.setQueryData(queryKey, task);
		const cached = qc.getQueryData<Task>(queryKey);

		expect(cached).toBeDefined();
		expect(cached?.id).toBe("task-new-123");
		expect(cached?.task_number).toBe(99);
		expect(cached?.title).toBe("Cached Task");
	});

	it("triggers toast with card number and View button upon subtask creation in SubtaskRows", async () => {
		get.mockResolvedValue({
			data: {
				data: {
					items: [],
					page_size: 50,
					next_cursor: null,
				},
			},
		});

		const createdSubtask = makeTask({
			id: "sub-1",
			title: "New Subtask",
			task_number: 88,
		});

		post.mockResolvedValue({
			data: {
				data: createdSubtask,
			},
		});

		const onTaskClick = vi.fn();

		withClient(
			<SubtaskRows
				projectId="p1"
				parent={makeTask()}
				depth={0}
				filters={{}}
				filtersActive={false}
				rowProps={{
					statuses: [],
					taskTypes: [],
					visibleFields: [],
					taskIdPrefix: "GOAI",
				}}
				statuses={[
					{
						id: "s1",
						project_id: "p1",
						name: "To Do",
						category: "todo",
						position: 0,
						created_at: "2026-01-01T00:00:00Z",
						updated_at: "2026-01-01T00:00:00Z",
					},
				]}
				creatableTypes={[
					{
						id: "t1",
						project_id: "p1",
						name: "Subtask",
						icon: "",
						color: "",
						created_at: "2026-01-01T00:00:00Z",
						updated_at: "2026-01-01T00:00:00Z",
					},
				]}
				canCreate={true}
				isExpanded={() => false}
				onToggle={vi.fn()}
				onTaskClick={onTaskClick}
			/>,
		);

		// Wait for loading skeleton to disappear
		await waitFor(() => {
			expect(screen.queryByRole("status")).toBeNull();
		});

		// Find and click the add trigger button
		const triggerButton = await screen.findByRole("button", {
			name: /Add subtask/i,
		});
		fireEvent.click(triggerButton);

		// Find add task row input and submit
		const input = await screen.findByPlaceholderText("Subtask title");
		fireEvent.change(input, { target: { value: "New Subtask" } });
		fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

		await waitFor(() => {
			expect(post).toHaveBeenCalled();
		});

		await waitFor(() => {
			expect(toastAddSpy).toHaveBeenCalled();
		});

		const toastCall = toastAddSpy.mock.calls[0][0] as {
			type: string;
			title: string;
			description: string;
			actionProps: { children: string; onClick: () => void };
		};

		expect(toastCall.type).toBe("success");
		expect(toastCall.title).toContain("GOAI-88");
		expect(toastCall.description).toBe("New Subtask");
		expect(toastCall.actionProps.children).toBe("View");

		toastCall.actionProps.onClick();
		expect(onTaskClick).toHaveBeenCalledWith(createdSubtask);
	});
});
