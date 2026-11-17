import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceAccount } from "@/lib/service-account-api";
import { makeRole, renderWithQueries } from "@/test/render-with-queries";
import { roleOption, toggleRole } from "@/test/role-select";
import { ServiceAccountRolesTab } from "./ServiceAccountRolesTab";

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ apiClient: { instance: http } }));

const ROLES = [
	makeRole("role-reader", "READER", { "tasks:read": true }),
	makeRole("role-admin", "ADMIN", { "users:read": true }),
];
const PERMS = ["roles:assign", "roles:read"];

const account = (roles: ServiceAccount["roles"]): ServiceAccount => ({
	id: "sa1",
	name: "CI bot",
	description: "",
	roles,
	created_at: "2026-01-15T00:00:00.000Z",
	updated_at: "2026-01-15T00:00:00.000Z",
});

beforeEach(() => {
	vi.clearAllMocks();
	http.put.mockResolvedValue({ data: { data: [] } });
});

describe("ServiceAccountRolesTab", () => {
	it("shows the held roles and changes them in the shared role dialog", async () => {
		const user = userEvent.setup();
		renderWithQueries(
			<ServiceAccountRolesTab
				account={account([{ id: "role-reader", name: "READER" }])}
				canWrite
			/>,
			{ permissions: PERMS, roles: ROLES },
		);
		expect(screen.getAllByText("READER").length).toBeGreaterThan(0);

		await user.click(screen.getByRole("button", { name: /change roles/i }));
		expect(await roleOption("READER")).toHaveAttribute("aria-selected", "true");
		await toggleRole("ADMIN");
		await user.click(screen.getByRole("button", { name: /save roles/i }));

		await waitFor(() => expect(http.put).toHaveBeenCalled());
		expect(http.put.mock.calls[0][0]).toContain("/service-accounts/sa1/roles");
	});

	it("offers the dialog for an account with no roles", async () => {
		const user = userEvent.setup();
		renderWithQueries(
			<ServiceAccountRolesTab account={account([])} canWrite />,
			{ permissions: PERMS, roles: ROLES },
		);
		await user.click(screen.getByRole("button", { name: /change roles/i }));
		expect(await roleOption("READER")).toHaveAttribute(
			"aria-selected",
			"false",
		);
	});

	it("is read-only without the assign-role permission", () => {
		renderWithQueries(
			<ServiceAccountRolesTab account={account([])} canWrite />,
			{ permissions: ["roles:read"], roles: ROLES },
		);
		expect(screen.queryByRole("button", { name: /change roles/i })).toBeNull();
	});
});
