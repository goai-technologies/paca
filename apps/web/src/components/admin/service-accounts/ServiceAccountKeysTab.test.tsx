import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ServiceAccount } from "@/lib/service-account-api";
import { renderWithQueries } from "@/test/render-with-queries";
import { ServiceAccountKeysTab } from "./ServiceAccountKeysTab";

const http = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	delete: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ apiClient: { instance: http } }));

const account: ServiceAccount = {
	id: "sa1",
	name: "CI bot",
	description: "",
	roles: [],
	created_at: "2026-01-15T00:00:00.000Z",
	updated_at: "2026-01-15T00:00:00.000Z",
};

const existing = {
	id: "k1",
	name: "GitHub Actions",
	key_prefix: "abcd1234",
	last_used_at: null,
	expires_at: null,
	created_at: "2026-02-01T00:00:00.000Z",
};

beforeEach(() => {
	vi.clearAllMocks();
	http.get.mockResolvedValue({
		data: {
			data: {
				items: [existing],
				page_size: 30,
				next_cursor: null,
				total_count: 1,
			},
		},
	});
});

describe("ServiceAccountKeysTab", () => {
	it("lists the keys without a secret", async () => {
		renderWithQueries(<ServiceAccountKeysTab account={account} canWrite />);
		expect(await screen.findByText("GitHub Actions")).toBeInTheDocument();
		expect(screen.getByText(/abcd1234/)).toBeInTheDocument();
	});

	it("creates a key from a dialog and reveals the secret once", async () => {
		http.post.mockResolvedValue({
			data: {
				data: { ...existing, id: "k2", name: "Deploy", key: "paca_secret" },
			},
		});
		const user = userEvent.setup();
		renderWithQueries(<ServiceAccountKeysTab account={account} canWrite />);
		await screen.findByText("GitHub Actions");

		await user.click(screen.getByRole("button", { name: /new key/i }));
		await user.type(screen.getByLabelText(/key name/i), "Deploy");
		await user.click(screen.getByRole("button", { name: /^create key$/i }));

		expect(await screen.findByText(/paca_secret/)).toBeInTheDocument();
		expect(http.post).toHaveBeenCalledWith(
			"/admin/service-accounts/sa1/api-keys",
			expect.objectContaining({ name: "Deploy" }),
		);
	});

	it("revokes a key after confirmation", async () => {
		http.delete.mockResolvedValue({});
		const user = userEvent.setup();
		renderWithQueries(<ServiceAccountKeysTab account={account} canWrite />);
		await screen.findByText("GitHub Actions");

		await user.click(
			screen.getByRole("button", { name: /revoke key github actions/i }),
		);
		expect(http.delete).not.toHaveBeenCalled();
		await user.click(
			await screen.findByRole("button", { name: /^revoke key$/i }),
		);

		await waitFor(() =>
			expect(http.delete).toHaveBeenCalledWith(
				"/admin/service-accounts/sa1/api-keys/k1",
			),
		);
	});

	it("gives a reader no way to create or revoke", async () => {
		renderWithQueries(
			<ServiceAccountKeysTab account={account} canWrite={false} />,
		);
		await screen.findByText("GitHub Actions");
		expect(screen.queryByRole("button", { name: /new key/i })).toBeNull();
		expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
	});
});
