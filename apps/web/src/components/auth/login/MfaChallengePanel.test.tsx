import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadPendingMfa, savePendingMfa } from "@/lib/mfa-challenge";
import { renderWithQueries } from "@/test/render-with-queries";
import { MfaChallengePanel } from "./MfaChallengePanel";

const mocks = vi.hoisted(() => ({
	navigate: vi.fn(),
	post: vi.fn(),
	startAuthentication: vi.fn(),
	supported: true,
}));
vi.mock("@simplewebauthn/browser", () => ({
	browserSupportsWebAuthn: () => mocks.supported,
	startAuthentication: mocks.startAuthentication,
}));
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => mocks.navigate,
}));
vi.mock("@/lib/api-client", () => ({
	apiClient: { instance: { post: mocks.post } },
}));

const pending = { challenge: "chal" };

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	savePendingMfa(pending);
	mocks.navigate.mockResolvedValue(undefined);
	mocks.supported = true;
});

describe("MfaChallengePanel", () => {
	it("verifies the code against the challenge, then opens the app", async () => {
		mocks.post.mockResolvedValue({ data: {} });
		const user = userEvent.setup();
		renderWithQueries(<MfaChallengePanel pending={pending} />);

		await user.type(screen.getByLabelText(/authentication code/i), "123456");
		await user.click(screen.getByRole("button", { name: /^verify$/i }));

		await waitFor(() =>
			expect(mocks.post).toHaveBeenCalledWith("/auth/mfa/verify", {
				challenge: "chal",
				code: "123456",
			}),
		);
		await waitFor(() =>
			expect(mocks.navigate).toHaveBeenCalledWith({ to: "/home" }),
		);
		expect(loadPendingMfa()).toBeNull();
	});

	it("keeps the page and the challenge after a wrong code", async () => {
		mocks.post.mockRejectedValue({
			response: { data: { error_code: "AUTH_MFA_INVALID_CODE" } },
		});
		const user = userEvent.setup();
		renderWithQueries(<MfaChallengePanel pending={pending} />);

		await user.type(screen.getByLabelText(/authentication code/i), "000000");
		await user.click(screen.getByRole("button", { name: /^verify$/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/invalid or was already used/i,
		);
		expect(mocks.navigate).not.toHaveBeenCalled();
		expect(loadPendingMfa()).not.toBeNull();
	});

	it("sends the user back to sign in when the challenge has expired", async () => {
		mocks.post.mockRejectedValue({
			response: { data: { error_code: "AUTH_TOKEN_INVALID" } },
		});
		const user = userEvent.setup();
		renderWithQueries(<MfaChallengePanel pending={pending} />);

		await user.type(screen.getByLabelText(/authentication code/i), "123456");
		await user.click(screen.getByRole("button", { name: /^verify$/i }));

		await waitFor(() =>
			expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", search: {} }),
		);
		expect(loadPendingMfa()).toBeNull();
	});

	it("does not submit an empty code", () => {
		renderWithQueries(<MfaChallengePanel pending={pending} />);
		expect(screen.getByRole("button", { name: /^verify$/i })).toBeDisabled();
	});

	describe("with a passkey", () => {
		const both = { challenge: "chal", methods: ["totp", "passkey"] as const };

		it("signs the server's request and exchanges it for a session", async () => {
			mocks.post
				.mockResolvedValueOnce({
					data: { data: { options: { publicKey: { challenge: "c" } } } },
				})
				.mockResolvedValueOnce({ data: {} });
			mocks.startAuthentication.mockResolvedValue({ id: "cred" });
			const user = userEvent.setup();
			renderWithQueries(
				<MfaChallengePanel pending={{ ...both, methods: [...both.methods] }} />,
			);

			await user.click(screen.getByRole("button", { name: /use a passkey/i }));

			await waitFor(() =>
				expect(mocks.post).toHaveBeenCalledWith("/auth/mfa/passkey/verify", {
					challenge: "chal",
					credential: { id: "cred" },
				}),
			);
			expect(mocks.post).toHaveBeenCalledWith("/auth/mfa/passkey/options", {
				challenge: "chal",
			});
			expect(mocks.startAuthentication).toHaveBeenCalledWith({
				optionsJSON: { challenge: "c" },
			});
			await waitFor(() =>
				expect(mocks.navigate).toHaveBeenCalledWith({ to: "/home" }),
			);
			expect(loadPendingMfa()).toBeNull();
		});

		it("still offers the code form alongside the passkey", () => {
			renderWithQueries(
				<MfaChallengePanel pending={{ ...both, methods: [...both.methods] }} />,
			);
			expect(screen.getByLabelText(/authentication code/i)).toBeInTheDocument();
		});

		it("takes a dismissed prompt calmly and keeps the challenge", async () => {
			mocks.post.mockResolvedValueOnce({
				data: { data: { options: { publicKey: {} } } },
			});
			mocks.startAuthentication.mockRejectedValue(
				Object.assign(new Error("dismissed"), { name: "NotAllowedError" }),
			);
			const user = userEvent.setup();
			renderWithQueries(
				<MfaChallengePanel pending={{ ...both, methods: [...both.methods] }} />,
			);

			await user.click(screen.getByRole("button", { name: /use a passkey/i }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				/cancelled or timed out/i,
			);
			expect(mocks.navigate).not.toHaveBeenCalled();
			expect(loadPendingMfa()).not.toBeNull();
		});

		it("shows only the passkey when the account has no authenticator app", () => {
			renderWithQueries(
				<MfaChallengePanel
					pending={{ challenge: "chal", methods: ["passkey"] }}
				/>,
			);
			expect(
				screen.getByRole("button", { name: /use a passkey/i }),
			).toBeVisible();
			expect(screen.queryByLabelText(/authentication code/i)).toBeNull();
		});

		it("explains when the browser can't do passkeys and there's no code to fall back on", () => {
			mocks.supported = false;
			renderWithQueries(
				<MfaChallengePanel
					pending={{ challenge: "chal", methods: ["passkey"] }}
				/>,
			);
			expect(screen.getByText(/can't use passkeys/i)).toBeVisible();
			expect(
				screen.queryByRole("button", { name: /use a passkey/i }),
			).toBeNull();
		});
	});
});
