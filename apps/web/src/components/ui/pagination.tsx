import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Rows-per-page choices offered by table footers. */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export interface PaginationProps {
	page: number;
	totalPages: number;
	onPageChange: (page: number) => void;
	className?: string;
	/** Table footers also show the row range and a rows-per-page menu: give the
	 *  total row count, the current page size and a change handler. The footer
	 *  then shows whenever the list has rows, even on a single page. */
	total?: number;
	pageSize?: number;
	onPageSizeChange?: (pageSize: number) => void;
	pageSizeOptions?: readonly number[];
}

type PageItem = number | "ellipsis-start" | "ellipsis-end";

/** Collapses a long page range around the current page, always keeping the
 *  first and last page reachable in one click — e.g. [1, …, 4, 5, 6, …, 20]. */
function buildPageItems(page: number, totalPages: number): PageItem[] {
	if (totalPages <= 7) {
		return Array.from({ length: totalPages }, (_, i) => i + 1);
	}
	const items: PageItem[] = [1];
	const start = Math.max(2, page - 2);
	const end = Math.min(totalPages - 1, page + 2);
	if (start > 2) items.push("ellipsis-start");
	for (let p = start; p <= end; p++) items.push(p);
	if (end < totalPages - 1) items.push("ellipsis-end");
	items.push(totalPages);
	return items;
}

/** Page-number pagination for lists where the backend already returns
 *  `{ total, page, page_size }` — jumping straight to a page (or seeing
 *  "page 3 of 9") fits structured, row-actionable data better than infinite
 *  scroll. Renders nothing for a single page. */
export function Pagination({
	page,
	totalPages,
	onPageChange,
	className,
	total,
	pageSize,
	onPageSizeChange,
	pageSizeOptions = PAGE_SIZE_OPTIONS,
}: PaginationProps) {
	const { t } = useTranslation("common");
	const sized =
		total !== undefined && pageSize !== undefined && !!onPageSizeChange;

	// A table footer is always there while there are rows, so the page size can
	// be chosen (and the row range read) however short the list is; the page
	// buttons only appear once there is more than one page.
	if (sized ? total <= 0 : totalPages <= 1) return null;

	const items = buildPageItems(page, totalPages);

	return (
		<nav
			aria-label={t("pagination.navLabel")}
			className={cn(
				"flex flex-wrap items-center justify-between gap-3",
				className,
			)}
		>
			{sized ? (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
					<label className="flex items-center gap-2">
						<span>{t("pagination.rowsPerPage")}</span>
						<select
							value={pageSize}
							onChange={(e) => onPageSizeChange(Number(e.target.value))}
							className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
						>
							{pageSizeOptions.map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					</label>
					<p aria-live="polite">
						{t("pagination.range", {
							from: Math.min((page - 1) * pageSize + 1, total),
							to: Math.min(page * pageSize, total),
							total,
						})}
					</p>
				</div>
			) : (
				<p className="text-sm text-muted-foreground">
					{t("pagination.pageOfTotal", { page, totalPages })}
				</p>
			)}
			{totalPages > 1 ? (
				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						disabled={page <= 1}
						onClick={() => onPageChange(page - 1)}
						aria-label={t("pagination.previous")}
					>
						<ChevronLeft className="size-3.5" />
					</Button>
					{items.map((item) =>
						typeof item === "number" ? (
							<Button
								key={item}
								type="button"
								variant={item === page ? "secondary" : "ghost"}
								size="icon-sm"
								onClick={() => onPageChange(item)}
								aria-label={t("pagination.page", { page: item })}
								aria-current={item === page ? "page" : undefined}
							>
								{item}
							</Button>
						) : (
							<span
								key={item}
								aria-hidden="true"
								className="px-1 text-sm text-muted-foreground"
							>
								…
							</span>
						),
					)}
					<Button
						type="button"
						variant="outline"
						size="icon-sm"
						disabled={page >= totalPages}
						onClick={() => onPageChange(page + 1)}
						aria-label={t("pagination.next")}
					>
						<ChevronRight className="size-3.5" />
					</Button>
				</div>
			) : null}
		</nav>
	);
}
