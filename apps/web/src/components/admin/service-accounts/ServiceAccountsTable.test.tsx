import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ServiceAccount } from "@/lib/service-account-api";
import { ServiceAccountsTable } from "./ServiceAccountsTable";

// The row name links to the detail page; render the link as a plain anchor.
vi.mock("@tanstack/react-router", () => ({
	Link: ({
		children,
		params,
		className,
	}: {
		children: ReactNode;
		params: { serviceAccountId: string };
		className?: string;
	}) => (
		<a
			href={`/admin/service-accounts/${params.serviceAccountId}`}
			className={className}
		>
			{children}
		</a>
	),
}));

const ci: ServiceAccount = {
	id: "sa1",
	name: "CI bot",
	description: "deploys",
	roles: [{ id: "r-reader", name: "Reader" }],
	created_at: "2026-01-15T00:00:00.000Z",
	updated_at: "2026-01-15T00:00:00.000Z",
};
const bare: ServiceAccount = {
	...ci,
	id: "sa2",
	name: "Backup",
	description: "",
	roles: [],
};

function renderTable(
	accounts: ServiceAccount[],
	opts: { canWrite?: boolean; canAssignRole?: boolean } = {},
) {
	const { canWrite = true, canAssignRole = false } = opts;
	const onEdit = vi.fn<(a: ServiceAccount) => void>();
	const onDelete = vi.fn<(a: ServiceAccount) => void>();
	const onChangeRole = vi.fn<(a: ServiceAccount) => void>();
	render(
		<ServiceAccountsTable
			accounts={accounts}
			canWrite={canWrite}
			canAssignRole={canAssignRole}
			onEdit={onEdit}
			onDelete={onDelete}
			onChangeRole={onChangeRole}
		/>,
	);
	return { onEdit, onDelete, onChangeRole };
}

describe("ServiceAccountsTable", () => {
	it("shows the name, the description and the roles of each account", () => {
		renderTable([ci, bare]);
		expect(screen.getByText("CI bot")).toBeInTheDocument();
		expect(screen.getByText("deploys")).toBeInTheDocument();
		expect(screen.getByText("Reader")).toBeInTheDocument();
		expect(screen.getByText("Backup")).toBeInTheDocument();
	});

	it("has a roles column and no created column", () => {
		renderTable([ci]);
		expect(screen.getByText("Roles")).toBeInTheDocument();
		expect(screen.queryByText("Created")).not.toBeInTheDocument();
		expect(screen.queryByText("Jan 15, 2026")).not.toBeInTheDocument();
	});

	it("links the name to the account's detail page", () => {
		renderTable([ci]);
		expect(screen.getByRole("link", { name: /CI bot/ })).toHaveAttribute(
			"href",
			"/admin/service-accounts/sa1",
		);
	});

	it("lets someone with roles:assign change the roles from the roles cell", async () => {
		const user = userEvent.setup();
		const { onChangeRole } = renderTable([ci], { canAssignRole: true });
		await user.click(screen.getByRole("button", { name: /Change roles/ }));
		expect(onChangeRole).toHaveBeenCalledWith(ci);
	});

	it("shows the roles read-only without roles:assign", () => {
		renderTable([ci], { canAssignRole: false });
		expect(screen.queryByRole("button", { name: /Change roles/ })).toBeNull();
		expect(screen.getByText("Reader")).toBeInTheDocument();
	});

	it("offers edit and delete only to a writer", async () => {
		const user = userEvent.setup();
		const { onEdit, onDelete } = renderTable([ci], { canWrite: true });
		await user.click(
			screen.getByRole("button", { name: "Edit service account" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Delete service account" }),
		);
		expect(onEdit).toHaveBeenCalledWith(ci);
		expect(onDelete).toHaveBeenCalledWith(ci);
	});

	it("hides the actions column from a reader", () => {
		renderTable([ci], { canWrite: false });
		expect(
			screen.queryByRole("button", { name: "Edit service account" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Delete service account" }),
		).toBeNull();
	});
});
