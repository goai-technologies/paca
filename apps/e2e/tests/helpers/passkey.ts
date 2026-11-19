import type { Page } from "@playwright/test";

/** A software authenticator attached to the page's browser (Chromium only). */
export interface VirtualAuthenticator {
	/** Forgets every credential it holds, as if the user lost the device. */
	clearCredentials(): Promise<void>;
	remove(): Promise<void>;
}

/**
 * Attaches a CTAP2 platform authenticator that approves every prompt with
 * user verification, so passkey registration and sign-in run without a
 * human. The credentials live in the authenticator, not the page: they
 * survive clearing cookies, which is how a "sign out" is simulated.
 */
export async function addVirtualAuthenticator(
	page: Page,
): Promise<VirtualAuthenticator> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send(
		"WebAuthn.addVirtualAuthenticator",
		{
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		},
	);
	return {
		clearCredentials: async () => {
			await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
		},
		remove: async () => {
			await cdp.send("WebAuthn.removeVirtualAuthenticator", {
				authenticatorId,
			});
			await cdp.send("WebAuthn.disable");
		},
	};
}
