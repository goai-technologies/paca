/**
 * Validates a post-login destination taken from the URL. Only a same-origin
 * path is accepted — anything else (an absolute URL to another site, a
 * protocol-relative `//host`, `javascript:`) returns null, so a crafted
 * `?redirect=` link can never send a user to another site after they sign in.
 */
export function sanitizeRedirect(
	raw: unknown,
	origin: string = window.location.origin,
): string | null {
	if (typeof raw !== "string" || raw === "") return null;
	// "/\evil.com" is read as "//evil.com" by some browsers.
	if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
		return null;
	}
	try {
		const url = new URL(raw, origin);
		if (url.origin !== origin) return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
}
