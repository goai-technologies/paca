import { useInfiniteQuery, useQueries } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, Loader2, Search } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ListGroup } from "@/components/projects/interactions/list-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type SearchTasksOptions,
	searchTasksQueryOptions,
	type Task,
} from "@/lib/interaction-api";
import {
	projectsLookupInfiniteQueryOptions,
	taskStatusesQueryOptions,
	taskTypesQueryOptions,
} from "@/lib/project-api";

/** Title is always first; assignee sits between Title and Type. People come
 *  from the search response (include=assignees) via the member directory. */
const VISIBLE_FIELDS = ["assignee", "type", "status", "importance", "due_date"];

function ResultsSkeleton() {
	return (
		<div className="rounded-xl border border-border/60 bg-card overflow-hidden">
			{[0, 1, 2, 3].map((i) => (
				<div
					key={i}
					className="flex items-center gap-3 px-4 py-2.5 border-b border-border/20 last:border-0"
				>
					<Skeleton className="h-3.5 w-14 shrink-0" />
					<Skeleton className="h-3.5 flex-1" />
					<Skeleton className="h-3.5 w-16 shrink-0" />
					<Skeleton className="h-3.5 w-20 shrink-0" />
				</div>
			))}
		</div>
	);
}

export function GlobalTaskResults({ opts }: { opts: SearchTasksOptions }) {
	const { t } = useTranslation("shared");
	const navigate = useNavigate();

	const {
		data,
		isLoading,
		isError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery(searchTasksQueryOptions(opts));

	const {
		data: projectsData,
		fetchNextPage: fetchNextProjectsPage,
		hasNextPage: hasMoreProjects,
		isFetchingNextPage: isFetchingMoreProjects,
	} = useInfiniteQuery(projectsLookupInfiniteQueryOptions());

	useEffect(() => {
		if (hasMoreProjects && !isFetchingMoreProjects) {
			void fetchNextProjectsPage();
		}
	}, [hasMoreProjects, isFetchingMoreProjects, fetchNextProjectsPage]);

	const tasks = useMemo(
		() => data?.pages.flatMap((page) => page.items) ?? [],
		[data],
	);
	const totalCount = data?.pages[0]?.total_count ?? 0;

	const projectIds = useMemo(
		() => [...new Set(tasks.map((task) => task.project_id))],
		[tasks],
	);

	const tasksByProject = useMemo(() => {
		const map = new Map<string, Task[]>();
		for (const task of tasks) {
			const list = map.get(task.project_id);
			if (list) list.push(task);
			else map.set(task.project_id, [task]);
		}
		return map;
	}, [tasks]);

	const statusQueries = useQueries({
		queries: projectIds.map((id) => taskStatusesQueryOptions(id)),
	});
	const typeQueries = useQueries({
		queries: projectIds.map((id) => taskTypesQueryOptions(id)),
	});

	const projectsById = useMemo(
		() =>
			new Map(
				(projectsData?.pages.flatMap((p) => p.items) ?? []).map((p) => [
					p.id,
					p,
				]),
			),
		[projectsData],
	);

	if (isLoading) return <ResultsSkeleton />;

	if (isError) {
		return (
			<div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 py-10 text-center">
				<AlertCircle className="size-6 text-destructive/40" />
				<p className="text-sm font-medium text-destructive">
					{t("home.globalTaskFilter.loadError")}
				</p>
			</div>
		);
	}

	if (tasks.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/60 bg-muted/10 py-10 text-center">
				<Search className="size-6 text-muted-foreground/30" />
				<p className="text-sm font-medium text-foreground/70">
					{t("home.globalTaskFilter.emptyTitle")}
				</p>
				<p className="text-xs text-muted-foreground/70 max-w-xs">
					{t("home.globalTaskFilter.emptyDescription")}
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<p className="text-xs text-muted-foreground px-0.5">
				{t("home.globalTaskFilter.resultCount", { count: totalCount })}
			</p>
			<div className="rounded-xl border border-border/60 bg-card overflow-hidden">
				{projectIds.map((projectId, idx) => {
					const project = projectsById.get(projectId);
					return (
						<ListGroup
							key={projectId}
							projectId={projectId}
							groupDef={{
								key: projectId,
								label: project?.name ?? projectId,
								fieldValue: null,
							}}
							swimlaneDefs={[]}
							swimlaneBy={undefined}
							tasks={tasksByProject.get(projectId) ?? []}
							statuses={statusQueries[idx]?.data ?? []}
							taskTypes={typeQueries[idx]?.data ?? []}
							members={[]}
							customFields={[]}
							canCreate={false}
							isStatusGrouping={false}
							visibleFields={VISIBLE_FIELDS}
							taskIdPrefix={project?.task_id_prefix}
							onCreateTask={async () => {}}
							onTaskClick={(task) => {
								void navigate({
									to: "/projects/$projectId/tasks/$taskId",
									params: { projectId: task.project_id, taskId: task.id },
								});
							}}
						/>
					);
				})}
				{hasNextPage ? (
					<button
						type="button"
						onClick={() => void fetchNextPage()}
						disabled={isFetchingNextPage}
						className="flex w-full items-center justify-center gap-1.5 border-t border-border/10 py-2.5 text-xs font-medium text-muted-foreground/60 hover:text-primary hover:bg-primary/5 transition-all duration-150 disabled:opacity-50"
					>
						{isFetchingNextPage ? (
							<>
								<Loader2 className="size-3 animate-spin" />
								{t("home.globalTaskFilter.loading")}
							</>
						) : (
							t("home.globalTaskFilter.loadMore")
						)}
					</button>
				) : null}
			</div>
		</div>
	);
}
