import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	type CommitmentCatalogItem,
	commitmentCatalogQueryOptions,
} from "@/lib/commitment-api";
import type { Task } from "@/lib/interaction-api";
import { CommitmentField } from "./commitment-field";

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const makeCommitment = (
	n: number,
	title: string,
	home?: { id: string; name: string; prefix: string },
): CommitmentCatalogItem => ({
	id: `commitment-${n}`,
	project_id: "proj-commitments",
	task_id_prefix: "COM",
	task_number: n,
	ref: `COM-${n}`,
	title,
	status_name: "In Progress",
	is_closed: false,
	custom_fields: {},
	...(home && {
		home_project_id: home.id,
		home_project_name: home.name,
		home_project_task_id_prefix: home.prefix,
	}),
});

const PORTAL = { id: "proj-portal", name: "Customer portal", prefix: "OPS" };
const BILLING = { id: "proj-billing", name: "Billing", prefix: "BIL" };

// Catalog order on purpose puts this project's commitments last.
const CATALOG: CommitmentCatalogItem[] = [
	makeCommitment(1, "Invoice export", BILLING),
	makeCommitment(2, "Shared reporting"),
	makeCommitment(3, "Self-service sign-up", PORTAL),
	makeCommitment(4, "Single sign-on", PORTAL),
];

const makeTask = (overrides: Partial<Task> = {}): Task => ({
	id: "task-1",
	project_id: PORTAL.id,
	title: "Add the sign-up form",
	task_number: 12,
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

function renderField(task: Task, items = CATALOG) {
	const qc = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	qc.setQueryData(commitmentCatalogQueryOptions().queryKey, {
		items,
		commitments_project_id: "proj-commitments",
		task_id_prefix: "COM",
	});
	const onChange = vi.fn();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	render(
		<CommitmentField
			task={task}
			canEdit
			inherited={false}
			onChange={onChange}
		/>,
		{ wrapper },
	);
	return { onChange };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CommitmentField", () => {
	it("lists this project's commitments first, under headings, with each one's project", async () => {
		const user = userEvent.setup();
		renderField(makeTask());

		await user.click(screen.getByRole("button", { name: /None/ }));
		const options = await screen.findAllByRole("menuitem");
		expect(options.map((o) => o.textContent?.match(/COM-\d+/)?.[0])).toEqual([
			"COM-3",
			"COM-4",
			"COM-1",
			"COM-2",
		]);
		expect(screen.getByText("This project")).toBeInTheDocument();
		expect(screen.getByText("Other projects")).toBeInTheDocument();
		expect(options[0]).toHaveTextContent("Customer portal");
		expect(options[2]).toHaveTextContent("Billing");
	});

	it("drops the headings when every commitment is for another project", async () => {
		const user = userEvent.setup();
		renderField(makeTask({ project_id: "proj-elsewhere" }));

		await user.click(screen.getByRole("button", { name: /None/ }));
		const options = await screen.findAllByRole("menuitem");
		// Catalog order is kept.
		expect(options.map((o) => o.textContent?.match(/COM-\d+/)?.[0])).toEqual([
			"COM-1",
			"COM-2",
			"COM-3",
			"COM-4",
		]);
		expect(screen.queryByText("This project")).not.toBeInTheDocument();
	});

	it("matches the search against the commitment's project name", async () => {
		const user = userEvent.setup();
		const { onChange } = renderField(makeTask());

		await user.click(screen.getByRole("button", { name: /None/ }));
		// fireEvent rather than user.type: typing inside the open menu makes
		// React warn about an un-awaited suspension; the change is the same.
		fireEvent.change(
			await screen.findByPlaceholderText("Search commitments…"),
			{ target: { value: "billing" } },
		);
		const options = screen.getAllByRole("menuitem");
		expect(options).toHaveLength(1);
		expect(options[0]).toHaveTextContent("Invoice export");

		await user.click(options[0]);
		expect(onChange).toHaveBeenCalledWith("commitment-1");
	});
});
