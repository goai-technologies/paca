import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
	DEFAULT_GLOBAL_SEARCH,
	GlobalTaskFilter,
	shouldAutoStartGlobalSearch,
} from "@/components/home/global-task-filter";
import { GlobalTaskResults } from "@/components/home/global-task-results";
import { canAccessAdmin } from "@/hooks/use-can-access-admin";
import { myPermissionsQueryOptions } from "@/lib/admin-api";
import type { SearchTasksOptions } from "@/lib/interaction-api";
import { projectsLookupInfiniteQueryOptions } from "@/lib/project-api";

export const Route = createFileRoute("/_authenticated/admin/global-tasks/")({
	beforeLoad: async ({ context: { queryClient } }) => {
		const permissions = await queryClient
			.fetchQuery(myPermissionsQueryOptions)
			.catch(() => [] as string[]);

		if (!canAccessAdmin(permissions)) {
			throw redirect({ to: "/home" });
		}
	},
	component: GlobalTasksPage,
});

function GlobalTasksPage() {
	const { t } = useTranslation("admin");
	const { t: tShared } = useTranslation("shared");
	const { data: projectsData } = useInfiniteQuery(
		projectsLookupInfiniteQueryOptions(),
	);
	const projectCount = projectsData?.pages[0]?.total ?? 0;

	const [globalSearch, setGlobalSearch] = useState<SearchTasksOptions | null>(
		null,
	);
	/** After Clear, stay idle until Apply — do not auto-restart search. */
	const [globalSearchCleared, setGlobalSearchCleared] = useState(false);

	// Auto-start an unfiltered cross-project search so GET /tasks/search runs
	// and cards are visible without waiting for Apply.
	useEffect(() => {
		if (
			!shouldAutoStartGlobalSearch({
				canAccessAdmin: true,
				projectCount,
				cleared: globalSearchCleared,
				current: globalSearch,
			})
		) {
			return;
		}
		setGlobalSearch(DEFAULT_GLOBAL_SEARCH);
	}, [projectCount, globalSearchCleared, globalSearch]);

	return (
		<div className="flex flex-col gap-6 p-6">
			<div>
				<div className="mb-1 flex items-center gap-2.5">
					<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<ListTodo className="size-4" />
					</div>
					<h1 className="text-xl font-semibold tracking-tight">
						{t("globalTasks.header.title")}
					</h1>
				</div>
				<p className="ml-10 text-sm text-muted-foreground">
					{t("globalTasks.header.description")}
				</p>
			</div>

			<div className="space-y-3">
				<GlobalTaskFilter
					applied={globalSearch != null}
					onApply={(opts) => {
						setGlobalSearchCleared(false);
						setGlobalSearch(opts);
					}}
					onClear={() => {
						setGlobalSearchCleared(true);
						setGlobalSearch(null);
					}}
				/>
				{globalSearch ? (
					<GlobalTaskResults opts={globalSearch} />
				) : (
					<p className="text-xs text-muted-foreground/70 px-0.5">
						{projectCount > 0
							? tShared("home.globalTaskFilter.idleHint")
							: tShared("home.globalTaskFilter.noProjectsHint")}
					</p>
				)}
			</div>
		</div>
	);
}
