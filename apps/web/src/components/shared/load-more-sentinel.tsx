import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

interface LoadMoreSentinelProps {
	hasMore: boolean;
	isLoadingMore: boolean;
	onLoadMore: () => void;
	/** Set when the last page request failed, so the observer doesn't retry
	 *  in a tight loop; the button still lets the user retry by hand. */
	isError?: boolean;
	/** Smaller, left-aligned control for dense lists such as the sidebar. */
	compact?: boolean;
}

/** End-of-list marker for an infinite list: loads the next page when it
 *  scrolls into view and also renders a "Load more" button, so paging works
 *  by scroll or by click. Renders nothing once there are no more pages. */
export function LoadMoreSentinel({
	hasMore,
	isLoadingMore,
	onLoadMore,
	isError = false,
	compact = false,
}: LoadMoreSentinelProps) {
	const { t } = useTranslation("common");
	const ref = useRef<HTMLDivElement>(null);
	const onLoadMoreRef = useRef(onLoadMore);
	onLoadMoreRef.current = onLoadMore;

	useEffect(() => {
		const el = ref.current;
		if (!el || !hasMore || isLoadingMore || isError) return;
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current();
			},
			{ rootMargin: "200px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore, isLoadingMore, isError]);

	if (!hasMore) return null;
	return (
		<div
			ref={ref}
			className={compact ? "flex py-1" : "flex justify-center py-4"}
		>
			<Button
				type="button"
				variant={compact ? "ghost" : "outline"}
				size={compact ? "xs" : "sm"}
				disabled={isLoadingMore}
				onClick={onLoadMore}
			>
				{isLoadingMore ? t("common.loadingMore") : t("common.loadMore")}
			</Button>
		</div>
	);
}
