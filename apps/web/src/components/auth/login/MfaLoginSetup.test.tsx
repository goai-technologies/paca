import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueries } from "@/test/render-with-queries";
import { MfaLoginSetup } from "./MfaLoginSetup";

const mocks = vi.hoisted(() => ({
	post: vi.fn(),
	startRegistration: vi.fn(),
	supported: true,
}));
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { post: mocks.post } },
}));
vi.mock("@simplewebauthn/browser", () => ({
	browserSupportsWebAuthn: () => mocks.supported,
	startRegistration: mocks.startRegistration,
}));

function setup() {
	const onDone = vi.fn();
	const onCancel = vi.fn();
	renderWithQueries(
		<MfaLoginSetup
			username="alice"
			password="secret123"
			onDone={onDone}
			onCancel={onCancel}
		/>,
	);
	return { onDone, onCancel };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.supported = true;
});

describe("MfaLoginSetup", () => {
	it("recommends a passkey, preselects it, and starts nothing until Continue", () => {
		setup();
		expect(screen.getByRole("radio", { name: /passkey/i })).toBeChecked();
		expect(screen.getByText(/recommended/i)).toBeVisible();
		expect(screen.getByText(/step 1 of 2/i)).toBeVisible();
		expect(mocks.post).not.toHaveBeenCalled();
	});

	it("names the account the requirement applies to", () => {
		setup();
		expect(
			screen.getByText(/signed in as alice|sign in as alice/i),
		).toBeVisible();
	});

	it("registers a passkey authorised by the password, then continues to sign in", async () => {
		mocks.post
			.mockResolvedValueOnce({
				data: { data: { options: { publicKey: { challenge: "c" } } } },
			})
			.mockResolvedValueOnce({ data: {} });
		mocks.startRegistration.mockResolvedValue({ id: "cred" });
		const user = userEvent.setup();
		const { onDone } = setup();

		await user.click(screen.getByRole("button", { name: /^continue$/i }));

		await waitFor(() =>
			expect(mocks.post).toHaveBeenCalledWith(
				"/auth/mfa/setup/passkey/finish",
				{
					username: "alice",
					password: "secret123",
					name: "Passkey",
					credential: { id: "cred" },
				},
			),
		);
		expect(mocks.post).toHaveBeenCalledWith("/auth/mfa/setup/passkey/options", {
			username: "alice",
			password: "secret123",
		});
		await user.click(
			await screen.findByRole("button", { name: /continue to sign in/i }),
		);
		expect(onDone).toHaveBeenCalled();
	});

	it("keeps the person on the passkey step with a retry when the prompt is dismissed", async () => {
		mocks.post.mockResolvedValue({
			data: { data: { options: { publicKey: {} } } },
		});
		mocks.startRegistration.mockRejectedValue(
			Object.assign(new Error("x"), { name: "NotAllowedError" }),
		);
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole("button", { name: /^continue$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/cancelled or timed out/i,
		);
		expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();

		await user.click(
			screen.getByRole("button", { name: /choose another method/i }),
		);
		expect(
			screen.getByRole("radio", { name: /authenticator app/i }),
		).toBeVisible();
	});

	it("only offers the app when the browser has no passkey support", () => {
		mocks.supported = false;
		setup();
		expect(screen.queryByRole("radio", { name: /^passkey/i })).toBeNull();
		expect(
			screen.getByRole("radio", { name: /authenticator app/i }),
		).toBeChecked();
		expect(screen.getByText(/step 1 of 3/i)).toBeVisible();
	});

	it("walks the app path: scan, verify, then confirm the recovery codes were saved", async () => {
		mocks.supported = false;
		mocks.post.mockImplementation(async (url: string) =>
			url === "/auth/mfa/setup"
				? {
						data: {
							data: { secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" },
						},
					}
				: {
						data: { data: { recovery_codes: ["aaaaa-bbbbb", "ccccc-ddddd"] } },
					},
		);
		const user = userEvent.setup();
		const { onDone } = setup();

		await user.click(screen.getByRole("button", { name: /^continue$/i }));
		await waitFor(() =>
			expect(mocks.post).toHaveBeenCalledWith("/auth/mfa/setup", {
				username: "alice",
				password: "secret123",
			}),
		);
		await user.type(await screen.findByLabelText(/6-digit code/i), "123456");
		await user.click(
			screen.getByRole("button", { name: /verify and turn on/i }),
		);

		expect(await screen.findByText("aaaaa-bbbbb")).toBeVisible();
		const finish = screen.getByRole("button", { name: /continue to sign in/i });
		expect(finish).toBeDisabled();
		await user.click(screen.getByRole("checkbox"));
		await user.click(finish);
		expect(onDone).toHaveBeenCalled();
	});

	it("goes back to the choice from the app step", async () => {
		mocks.supported = false;
		mocks.post.mockResolvedValue({
			data: { data: { secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" } },
		});
		const user = userEvent.setup();
		setup();

		await user.click(screen.getByRole("button", { name: /^continue$/i }));
		await user.click(await screen.findByRole("button", { name: /^back$/i }));

		expect(
			screen.getByRole("radio", { name: /authenticator app/i }),
		).toBeVisible();
	});
});
