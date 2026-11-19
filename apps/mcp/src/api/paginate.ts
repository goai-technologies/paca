import { z } from "zod";

/** Page size requested from list endpoints when the caller gives none (their
 *  maximum is 100-200). */
export const LIST_PAGE_SIZE = 50;

/** One page of a cursor-paginated list. Lists are never read to the end on the
 *  caller's behalf: a tool returns one page and tells the agent how to ask for
 *  the next one (`nextCursor`). */
export interface Page<T> {
	items: T[];
	/** Pass back as `cursor` for the next page; null on the last page. */
	nextCursor: string | null;
	/** Everything the list holds, when the endpoint reports it. */
	total?: number;
}

/** What a caller can ask of a list: where to resume and how much to read. */
export interface PageOptions {
	cursor?: string;
	pageSize?: number;
}

/** Zod fields every paged tool accepts. */
export const pagingFields = {
	cursor: z
		.string()
		.optional()
		.describe(
			"Opaque cursor from a previous call's next-page notice; omit for the first page.",
		),
	pageSize: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe(`Items per page (1-100, default ${LIST_PAGE_SIZE}).`),
};

/** JSON-schema properties matching `pagingFields`, for a tool's inputSchema. */
export const pagingProperties = {
	cursor: {
		type: "string",
		description:
			"Opaque cursor from a previous call's next-page notice; omit for the first page.",
	},
	pageSize: {
		type: "number",
		description: `Items per page (1-100, default ${LIST_PAGE_SIZE}).`,
	},
} as const;

/** Reads one list response — a bare array or an `{ items, next_cursor,
 *  total_count }` page — into a `Page`. */
export function toPage<T>(response: any): Page<T> {
	if (Array.isArray(response)) {
		return { items: response as T[], nextCursor: null };
	}
	const items = (response?.items ?? response?.data ?? []) as T[];
	const page: Page<T> = {
		items: Array.isArray(items) ? items : [],
		nextCursor: response?.next_cursor ?? null,
	};
	const total = response?.total_count ?? response?.total;
	if (typeof total === "number") page.total = total;
	return page;
}

/** Appends `page_size` and `cursor` to a list path. */
export function withPaging(path: string, opts: PageOptions = {}): string {
	const sep = path.includes("?") ? "&" : "?";
	const size = opts.pageSize ?? LIST_PAGE_SIZE;
	return `${path}${sep}page_size=${size}${opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ""}`;
}

/** A line telling the agent whether the list goes on, to append to a tool's
 *  text output. `tool` is the tool to call again with `cursor`. Empty when
 *  this was the last page. */
export function moreNotice(
	page: Pick<Page<unknown>, "nextCursor" | "total" | "items">,
	tool: string,
): string {
	const shown =
		page.total !== undefined
			? `Showing ${page.items.length} of ${page.total}. `
			: "";
	if (!page.nextCursor) {
		return page.total !== undefined && page.items.length < page.total
			? `\n\n_${shown}_`
			: "";
	}
	return `\n\n_${shown}More results available — call ${tool} again with cursor="${page.nextCursor}" for the next page._`;
}
