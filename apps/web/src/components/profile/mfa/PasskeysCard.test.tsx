import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueries } from "@/test/render-with-queries";
import { PasskeysCard } from "./PasskeysCard";

const http = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	delete: vi.fn(),
}));
const webauthn = vi.hoisted(() => ({
	startRegistration: vi.fn(),
	startAuthentication: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({ apiClient: { instance: http } }));
vi.mock("@simplewebauthn/browser", () => ({
	browserSupportsWebAuthn: () => true,
	startRegistration: webauthn.startRegistration,
	startAuthentication: webauthn.startAuthentication,
}));

const key = {
	id: "pk1",
	name: "Work laptop",
	created_at: "2026-10-01T10:00:00Z",
	last_used_at: null,
};

function serve(available: boolean, passkeys = [key]) {
	http.get.mockImplementation(async (url: string) => ({
		data: {
			data:
				url === "/users/me/passkeys"
					? passkeys
					: {
							enabled: false,
							recovery_codes_left: 0,
							passkeys_available: available,
						},
		},
	}));
}

beforeEach(() => vi.clearAllMocks());

describe("PasskeysCard", () => {
	it("is absent when the server has no relying party", async () => {
		serve(false);
		const { container } = renderWithQueries(<PasskeysCard />);
		await waitFor(() => expect(http.get).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();
		expect(http.get).not.toHaveBeenCalledWith("/users/me/passkeys");
	});

	it("lists the registered passkeys", async () => {
		serve(true);
		renderWithQueries(<PasskeysCard />);
		expect(await screen.findByText("Work laptop")).toBeInTheDocument();
		expect(screen.getByText(/never used/i)).toBeInTheDocument();
	});

	it("registers a passkey: options, the browser prompt, then the result", async () => {
		serve(true, []);
		webauthn.startRegistration.mockResolvedValue({ id: "cred" });
		http.post.mockImplementation(async (url: string) =>
			url.endsWith("/options")
				? { data: { data: { options: { publicKey: { challenge: "c" } } } } }
				: { data: { data: key } },
		);
		const user = userEvent.setup();
		renderWithQueries(<PasskeysCard />);

		await user.click(
			await screen.findByRole("button", { name: /add a passkey/i }),
		);
		await user.type(screen.getByLabelText(/^name$/i), "Phone");
		await user.click(screen.getByRole("button", { name: /continue/i }));

		await waitFor(() =>
			expect(http.post).toHaveBeenCalledWith(
				"/users/me/passkeys/register/finish",
				{ name: "Phone", credential: { id: "cred" } },
			),
		);
		expect(webauthn.startRegistration).toHaveBeenCalledWith({
			optionsJSON: { challenge: "c" },
		});
	});

	it("says so when the prompt is dismissed", async () => {
		serve(true, []);
		webauthn.startRegistration.mockRejectedValue(
			Object.assign(new Error("x"), { name: "NotAllowedError" }),
		);
		http.post.mockResolvedValue({
			data: { data: { options: { publicKey: {} } } },
		});
		const user = userEvent.setup();
		renderWithQueries(<PasskeysCard />);

		await user.click(
			await screen.findByRole("button", { name: /add a passkey/i }),
		);
		await user.click(screen.getByRole("button", { name: /continue/i }));

		expect(
			await screen.findByText(/cancelled or timed out/i),
		).toBeInTheDocument();
	});

	it("needs a passkey prompt to remove a passkey, and asks for no password", async () => {
		serve(true);
		http.post.mockResolvedValue({
			data: { data: { options: { publicKey: { challenge: "v" } } } },
		});
		webauthn.startAuthentication.mockResolvedValue({ id: "cred" });
		http.delete.mockResolvedValue({});
		const user = userEvent.setup();
		renderWithQueries(<PasskeysCard />);

		await user.click(
			await screen.findByRole("button", { name: /remove work laptop/i }),
		);
		expect(screen.queryByLabelText(/password/i)).toBeNull();
		await user.click(screen.getByRole("button", { name: /^remove$/i }));

		await waitFor(() =>
			expect(http.delete).toHaveBeenCalledWith("/users/me/passkeys/pk1", {
				data: { credential: { id: "cred" } },
			}),
		);
		expect(http.post).toHaveBeenCalledWith("/users/me/passkeys/verify/options");
		expect(webauthn.startAuthentication).toHaveBeenCalledWith({
			optionsJSON: { challenge: "v" },
		});
	});

	it("keeps the passkey when the prompt is dismissed", async () => {
		serve(true);
		http.post.mockResolvedValue({
			data: { data: { options: { publicKey: {} } } },
		});
		webauthn.startAuthentication.mockRejectedValue(
			Object.assign(new Error("x"), { name: "NotAllowedError" }),
		);
		const user = userEvent.setup();
		renderWithQueries(<PasskeysCard />);

		await user.click(
			await screen.findByRole("button", { name: /remove work laptop/i }),
		);
		await user.click(screen.getByRole("button", { name: /^remove$/i }));

		expect(await screen.findByText(/cancelled or timed out/i)).toBeVisible();
		expect(http.delete).not.toHaveBeenCalled();
	});

	it("starts each add dialog clean after an earlier failure", async () => {
		serve(true, []);
		webauthn.startRegistration.mockRejectedValue(
			Object.assign(new Error("x"), { name: "NotAllowedError" }),
		);
		http.post.mockResolvedValue({
			data: { data: { options: { publicKey: {} } } },
		});
		const user = userEvent.setup();
		renderWithQueries(<PasskeysCard />);

		await user.click(
			await screen.findByRole("button", { name: /add a passkey/i }),
		);
		await user.type(screen.getByLabelText(/^name$/i), "Phone");
		await user.click(screen.getByRole("button", { name: /continue/i }));
		expect(await screen.findByText(/cancelled or timed out/i)).toBeVisible();

		await user.click(screen.getByRole("button", { name: /cancel/i }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await user.click(screen.getByRole("button", { name: /add a passkey/i }));

		expect(screen.getByLabelText(/^name$/i)).toHaveValue("");
		expect(screen.queryByText(/cancelled or timed out/i)).toBeNull();
	});
});
