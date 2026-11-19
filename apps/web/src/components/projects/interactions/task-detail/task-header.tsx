import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Check,
	ChevronRight,
	FolderInput,
	Hash,
	Loader2,
	MoreVertical,
	Search,
	Share2,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { commitmentsProjectIdQueryOptions } from "@/lib/commitment-api";
import { formatDate } from "@/lib/format-date";
import type { Task } from "@/lib/interaction-api";
import { deleteTask, moveTaskToProject } from "@/lib/interaction-api";
import { projectsLookupInfiniteQueryOptions } from "@/lib/project-api";
import { cn } from "@/lib/utils";
import { shortId } from "./helpers";

interface TaskHeaderProps {
	task: Task;
	mode: "modal" | "page";
	projectName?: string;
	interactionName?: string;
	projectId?: string;
	taskIdPrefix?: string;
	canDelete?: boolean;
	onClose: () => void;
	onDeleted?: () => void;
	/** Called after a successful cross-project move with the new project id. */
	onMoved?: (targetProjectId: string) => void;
}

export function TaskHeader({
	task,
	mode,
	projectName,
	interactionName,
	projectId,
	taskIdPrefix = "",
	canDelete = false,
	onClose,
	onDeleted,
	onMoved,
}: TaskHeaderProps) {
	const { t } = useTranslation("projects");
	const qc = useQueryClient();
	const [linkCopied, setLinkCopied] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmMove, setConfirmMove] = useState(false);
	const [moveSearch, setMoveSearch] = useState("");
	const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);

	const { data: commitmentsProjectId } = useQuery(commitmentsProjectIdQueryOptions());
	const {
		data: projectsData,
		isLoading: projectsLoading,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isFetchNextPageError,
	} = useInfiniteQuery({
		...projectsLookupInfiniteQueryOptions(),
		enabled: confirmMove,
	});
	useEffect(() => {
		if (
			confirmMove &&
			hasNextPage &&
			!isFetchingNextPage &&
			!isFetchNextPageError
		) {
			void fetchNextPage();
		}
	}, [
		confirmMove,
		hasNextPage,
		isFetchingNextPage,
		isFetchNextPageError,
		fetchNextPage,
	]);

	const moveTargets = useMemo(() => {
		const items = projectsData?.pages.flatMap((p) => p.items) ?? [];
		return items
			.filter(
				(p) =>
					p.id !== projectId &&
					(!commitmentsProjectId || p.id !== commitmentsProjectId),
			)
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [projectsData, projectId, commitmentsProjectId]);

	const moveQuery = moveSearch.trim().toLowerCase();
	const filteredTargets = moveQuery
		? moveTargets.filter(
				(p) =>
					p.name.toLowerCase().includes(moveQuery) ||
					p.task_id_prefix.toLowerCase().includes(moveQuery),
			)
		: moveTargets;

	const deleteMutation = useMutation({
		mutationFn: () => {
			if (!projectId || !task) throw new Error("missing context");
			return deleteTask(projectId, task.id);
		},
		onSuccess: () => {
			if (projectId) {
				qc.invalidateQueries({
					queryKey: ["projects", projectId],
					predicate: (q) => {
						const key = q.queryKey as string[];
						return key.includes("tasks") || key.includes("backlog-tasks");
					},
				});
			}
			setConfirmDelete(false);
			onDeleted?.();
		},
	});

	const moveMutation = useMutation({
		mutationFn: () => {
			if (!projectId || !task || !selectedTargetId) {
				throw new Error("missing context");
			}
			return moveTaskToProject(projectId, task.id, selectedTargetId);
		},
		onSuccess: (moved) => {
			if (projectId) {
				qc.invalidateQueries({ queryKey: ["projects", projectId] });
			}
			qc.invalidateQueries({ queryKey: ["projects", moved.project_id] });
			qc.invalidateQueries({ queryKey: ["projects", "all"] });
			setConfirmMove(false);
			setSelectedTargetId(null);
			setMoveSearch("");
			onMoved?.(moved.project_id);
		},
	});

	const handleShare = () => {
		// Always share the canonical task detail page URL, not modal URLs with query params
		const taskUrl = projectId
			? `${window.location.origin}/projects/${projectId}/tasks/${task.id}`
			: window.location.href;
		navigator.clipboard?.writeText(taskUrl)?.catch(() => {});
		setLinkCopied(true);
		setTimeout(() => setLinkCopied(false), 2000);
	};

	return (
		<div className="flex shrink-0 items-center gap-2 lg:gap-3 border-b border-border/30 px-4 py-2.5 bg-muted/20">
			{/* Breadcrumb (page mode only) */}
			{mode === "page" && projectName && (
				<nav className="hidden md:flex items-center gap-1.5 text-sm text-muted-foreground/80 mr-2">
					<span className="hover:text-foreground transition-colors cursor-pointer">
						{projectName}
					</span>
					<ChevronRight className="size-3 text-muted-foreground/45" />
					{interactionName && (
						<>
							<span className="hover:text-foreground transition-colors cursor-pointer">
								{interactionName}
							</span>
							<ChevronRight className="size-3 text-muted-foreground/45" />
						</>
					)}
					<span className="text-foreground/80 truncate max-w-36 font-medium">
						{task.title}
					</span>
				</nav>
			)}

			{/* Task short ID */}
			<div className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 border border-border/30">
				<Hash className="size-3 text-muted-foreground/60" />
				<span className="font-[JetBrains_Mono,monospace] text-xs font-semibold text-muted-foreground tracking-wider">
					{taskIdPrefix && task.task_number > 0
						? `${taskIdPrefix}-${task.task_number}`
						: shortId(task.id)}
				</span>
			</div>

			<span className="hidden md:inline text-xs text-muted-foreground/60 font-medium">
				{t("taskDetail.header.created", { date: formatDate(task.created_at) })}
			</span>

			<div className="ml-auto flex items-center gap-1">
				<button
					type="button"
					onClick={handleShare}
					className={cn(
						"flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-all duration-150",
						linkCopied
							? "text-emerald-500 bg-emerald-500/10"
							: "text-muted-foreground/70 hover:text-foreground hover:bg-muted/60",
					)}
				>
					{linkCopied ? (
						<>
							<Check className="size-3 text-emerald-500" />
							<span>{t("taskDetail.header.copied")}</span>
						</>
					) : (
						<>
							<Share2 className="size-3" />
							<span>{t("taskDetail.header.share")}</span>
						</>
					)}
				</button>

				{canDelete && (
					<DropdownMenu>
						<DropdownMenuTrigger
							className="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-all duration-150"
							aria-label={t("taskDetail.header.taskActions")}
						>
							<MoreVertical className="size-4" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-48">
							<DropdownMenuItem
								onClick={() => {
									setSelectedTargetId(null);
									setMoveSearch("");
									setConfirmMove(true);
								}}
							>
								<FolderInput className="size-3.5 mr-2" />
								{t("taskDetail.header.moveToProject")}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={() => setConfirmDelete(true)}
							>
								<Trash2 className="size-3.5 mr-2" />
								{t("taskDetail.header.delete")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}

				{mode === "modal" && (
					<button
						type="button"
						onClick={onClose}
						className="flex size-7 items-center justify-center rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/60 transition-all duration-150"
						aria-label={t("taskDetail.header.closeTaskDetail")}
					>
						<X className="size-3.5" />
					</button>
				)}
			</div>

			{/* Delete confirmation dialog */}
			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{t("taskDetail.header.deleteDialog.title")}
						</DialogTitle>
						<DialogDescription>
							{t("taskDetail.header.deleteDialog.description", {
								title: task.title,
							})}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConfirmDelete(false)}
							disabled={deleteMutation.isPending}
						>
							{t("taskDetail.header.deleteDialog.cancel")}
						</Button>
						<Button
							variant="destructive"
							onClick={() => deleteMutation.mutate()}
							disabled={deleteMutation.isPending}
						>
							{deleteMutation.isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								t("taskDetail.header.deleteDialog.delete")
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Move to project dialog */}
			<Dialog
				open={confirmMove}
				onOpenChange={(open) => {
					setConfirmMove(open);
					if (!open) {
						setSelectedTargetId(null);
						setMoveSearch("");
						moveMutation.reset();
					}
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>{t("taskDetail.header.moveDialog.title")}</DialogTitle>
						<DialogDescription>
							{t("taskDetail.header.moveDialog.description", {
								title: task.title,
							})}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-3">
						<div className="relative">
							<Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<input
								value={moveSearch}
								onChange={(e) => setMoveSearch(e.target.value)}
								placeholder={t(
									"taskDetail.header.moveDialog.searchPlaceholder",
								)}
								className="w-full rounded-md border border-border/60 bg-background py-2 pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
							/>
						</div>
						<div className="max-h-56 overflow-y-auto rounded-md border border-border/50">
							{projectsLoading ||
							(hasNextPage && !isFetchNextPageError) ||
							isFetchingNextPage ? (
								<div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
									<Loader2 className="size-3.5 animate-spin" />
								</div>
							) : filteredTargets.length === 0 ? (
								<p className="px-3 py-6 text-center text-sm text-muted-foreground">
									{t("taskDetail.header.moveDialog.noProjects")}
								</p>
							) : (
								filteredTargets.map((p) => (
									<button
										key={p.id}
										type="button"
										onClick={() => setSelectedTargetId(p.id)}
										className={cn(
											"flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
											selectedTargetId === p.id
												? "bg-primary/10 text-primary"
												: "hover:bg-muted/60",
										)}
									>
										<span className="truncate font-medium">{p.name}</span>
										{p.task_id_prefix ? (
											<span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
												{p.task_id_prefix}
											</span>
										) : null}
									</button>
								))
							)}
						</div>
						{moveMutation.isError ? (
							<p className="text-sm text-destructive">
								{t("taskDetail.header.moveDialog.error")}
							</p>
						) : null}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConfirmMove(false)}
							disabled={moveMutation.isPending}
						>
							{t("taskDetail.header.moveDialog.cancel")}
						</Button>
						<Button
							onClick={() => moveMutation.mutate()}
							disabled={!selectedTargetId || moveMutation.isPending}
						>
							{moveMutation.isPending ? (
								<>
									<Loader2 className="size-4 animate-spin" />
									{t("taskDetail.header.moveDialog.moving")}
								</>
							) : (
								t("taskDetail.header.moveDialog.confirm")
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
