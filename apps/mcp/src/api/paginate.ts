/** Upper bound on how many items a "list everything" helper collects, so a
 *  huge project can't make one tool call page through unbounded data. */
export const MAX_LISTED_ITEMS = 5000;

/** Page size requested from list endpoints (their maximum is 100-200). */
export const LIST_PAGE_SIZE = 100;

/**
 * Collects a cursor-paginated list into one array by following `next_cursor`
 * until the last page or `maxItems`. `fetchPage` receives the cursor to resume
 * from (undefined for the first page) and returns the endpoint's
 * `{ items, next_cursor }` body.
 */
export async function fetchAllPages<T>(
	fetchPage: (cursor?: string) => Promise<any>,
	maxItems: number = MAX_LISTED_ITEMS,
): Promise<T[]> {
	const out: T[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await fetchPage(cursor);
		if (Array.isArray(page)) {
			out.push(...(page as T[]));
			break;
		}
		out.push(...((page?.items ?? []) as T[]));
		cursor = page?.next_cursor ?? undefined;
		if (!cursor || out.length >= maxItems) break;
	}
	return out.slice(0, maxItems);
}

/** Appends `page_size` and `cursor` to a list path. */
export function withPaging(
	path: string,
	cursor: string | undefined,
	pageSize: number = LIST_PAGE_SIZE,
): string {
	const sep = path.includes("?") ? "&" : "?";
	return `${path}${sep}page_size=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
}
