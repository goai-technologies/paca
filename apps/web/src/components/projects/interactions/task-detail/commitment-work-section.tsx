import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, FolderKanban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { commitmentWorkQueryOptions } from "@/lib/commitment-api";

interface CommitmentWorkSectionProps {
	commitmentId: string;
}

/**
 * On a Commitment-typed task: every ticket attached to it, from every
 * project, grouped by project. This is the same set the commitments API
 * returns, so what PACA shows and what any reporting dashboard shows are the
 * same list.
 */
export function CommitmentWorkSection({
	commitmentId,
}: CommitmentWorkSectionProps) {
	const { t } = useTranslation("projects");
	const navigate = useNavigate();
	const { data, isLoading, isError } = useQuery(
		commitmentWorkQueryOptions(commitmentId),
	);

	const total = data?.projects.reduce((n, g) => n + g.tasks.length, 0) ?? 0;

	return (
		<div>
			<h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 mb-3 flex items-center gap-2">
				<span>
					{t("taskDetail.commitment.workTitle")}
					{data && (
						<span className="ml-1.5 font-mono text-[11px] normal-case tracking-normal text-muted-foreground/60">
							{total}
						</span>
					)}
				</span>
				<div className="flex-1 h-px bg-linear-to-r from-border/40 to-transparent" />
			</h3>

			{isLoading ? (
				<p className="text-xs text-muted-foreground">
					{t("taskDetail.commitment.loading")}
				</p>
			) : isError ? (
				<p className="text-xs text-destructive">
					{t("taskDetail.commitment.workError")}
				</p>
			) : !data || data.projects.length === 0 ? (
				<p className="text-xs text-muted-foreground italic">
					{t("taskDetail.commitment.workEmpty")}
				</p>
			) : (
				<div className="space-y-4">
					{data.projects.map((group) => (
						<div key={group.project_id}>
							<div className="flex items-center gap-2 mb-1.5 text-sm font-medium">
								<FolderKanban className="size-3.5 text-muted-foreground" />
								<span>{group.project_name}</span>
								<span className="font-mono text-[11px] text-muted-foreground">
									{group.task_id_prefix}
								</span>
								<span className="text-xs text-muted-foreground">
									· {group.tasks.length}
								</span>
							</div>
							<ul className="divide-y divide-border/40 rounded-md border border-border/50">
								{group.tasks.map((task) => (
									<li key={task.id}>
										<button
											type="button"
											onClick={() =>
												navigate({
													to: "/projects/$projectId/tasks/$taskId",
													params: {
														projectId: task.project_id,
														taskId: task.id,
													},
												})
											}
											className="group flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-muted/40"
										>
											<span className="font-mono text-xs text-muted-foreground w-20 shrink-0">
												{task.ref}
											</span>
											<span className="truncate flex-1">{task.title}</span>
											<ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
										</button>
									</li>
								))}
							</ul>
						</div>
					))}
					{data.hidden_project_count > 0 && (
						<p className="text-xs text-muted-foreground">
							{t("taskDetail.commitment.hiddenProjects", {
								count: data.hidden_project_count,
							})}
						</p>
					)}
				</div>
			)}
		</div>
	);
}
