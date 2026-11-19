export const ACTIVITY_WIDTH_STORAGE_KEY = "paca:activity-pane-width";
export const ACTIVITY_WIDTH_DEFAULT = 320;
export const ACTIVITY_WIDTH_MIN = 280;
export const ACTIVITY_WIDTH_MAX = 760;
export const ACTIVITY_WIDTH_KEY_STEP = 16;

/** Largest width the pane may take: the hard cap, or half the window. */
export function maxActivityWidth(viewportWidth: number): number {
	return Math.max(
		ACTIVITY_WIDTH_MIN,
		Math.min(ACTIVITY_WIDTH_MAX, viewportWidth * 0.5),
	);
}

export function clampActivityWidth(
	width: number,
	viewportWidth: number,
): number {
	const max = maxActivityWidth(viewportWidth);
	return Math.round(Math.max(ACTIVITY_WIDTH_MIN, Math.min(width, max)));
}

// The app is a client-only SPA, so reading window/localStorage while
// initialising state is safe; revisit if this is ever server-rendered.
export function readStoredActivityWidth(viewportWidth: number): number {
	try {
		const stored = Number(localStorage.getItem(ACTIVITY_WIDTH_STORAGE_KEY));
		return Number.isFinite(stored) && stored > 0
			? clampActivityWidth(stored, viewportWidth)
			: ACTIVITY_WIDTH_DEFAULT;
	} catch {
		return ACTIVITY_WIDTH_DEFAULT;
	}
}

export function storeActivityWidth(width: number) {
	try {
		localStorage.setItem(ACTIVITY_WIDTH_STORAGE_KEY, String(width));
	} catch {
		// Persisting the width is best-effort.
	}
}
