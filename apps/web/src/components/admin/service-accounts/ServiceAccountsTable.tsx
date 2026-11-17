import { Link } from "@tanstack/react-router";
import { Edit2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EntityAvatar } from "@/components/shared/entity-avatar";
import {
	enrichRoles,
	RoleBadgeList,
	type RoleLike,
} from "@/components/shared/role-badge";
import { RoleChangeTrigger } from "@/components/shared/role-change-trigger";
import { Button } from "@/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { serviceAccountAvatar } from "@/lib/provider-logos";
import type { ServiceAccount } from "@/lib/service-account-api";

interface ServiceAccountsTableProps {
	accounts: ServiceAccount[];
	/** Whether the viewer may edit and delete accounts (`service_accounts:write`). */
	canWrite: boolean;
	/** Whether the viewer may change an account's roles. That is its own
	 * permission, apart from `canWrite`, so it is shown (and hidden)
	 * independently. */
	canAssignRole: boolean;
	/** The roles list, when the viewer can read it: lets role badges show
	 * descriptions and the kind of role. Without it they show names only. */
	roleDirectory?: RoleLike[];
	onEdit: (account: ServiceAccount) => void;
	onDelete: (account: ServiceAccount) => void;
	onChangeRole: (account: ServiceAccount) => void;
}

const HEAD = "px-4 text-xs font-semibold uppercase tracking-wide sm:px-5";

export function ServiceAccountsTable({
	accounts,
	canWrite,
	canAssignRole,
	roleDirectory,
	onEdit,
	onDelete,
	onChangeRole,
}: ServiceAccountsTableProps) {
	const { t } = useTranslation("admin");

	return (
		<div className="overflow-x-auto rounded-xl border">
			<Table>
				<TableHeader>
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className={HEAD}>
							{t("serviceAccounts.table.columnAccount")}
						</TableHead>
						<TableHead className={`${HEAD} w-56 sm:w-64`}>
							{t("serviceAccounts.table.columnRole")}
						</TableHead>
						{canWrite ? (
							<TableHead className={`${HEAD} w-24 sm:w-28`}>
								<span className="sr-only">
									{t("serviceAccounts.table.columnActions")}
								</span>
							</TableHead>
						) : null}
					</TableRow>
				</TableHeader>
				<TableBody>
					{accounts.map((account) => {
						const roles = enrichRoles(account.roles, roleDirectory);
						return (
							<TableRow key={account.id} className="group">
								<TableCell className="px-4 sm:px-5">
									<Link
										to="/admin/service-accounts/$serviceAccountId"
										params={{ serviceAccountId: account.id }}
										className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										<EntityAvatar {...serviceAccountAvatar(account)} />
										<div className="min-w-0">
											<span className="block truncate text-sm font-medium hover:underline">
												{account.name}
											</span>
											<p className="truncate text-xs text-muted-foreground">
												{account.description ||
													t("serviceAccounts.table.noDescription")}
											</p>
										</div>
									</Link>
								</TableCell>
								<TableCell className="px-4 sm:px-5">
									{canAssignRole ? (
										<RoleChangeTrigger
											roles={roles}
											label={t("serviceAccounts.table.changeRoleAction")}
											onClick={() => onChangeRole(account)}
										/>
									) : (
										<RoleBadgeList roles={roles} max={2} />
									)}
								</TableCell>
								{canWrite ? (
									<TableCell className="px-4 sm:px-5">
										<div className="flex items-center justify-end gap-0.5 opacity-100 transition-opacity focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
											<Button
												variant="ghost"
												size="icon-sm"
												onClick={() => onEdit(account)}
												title={t("serviceAccounts.table.editAction")}
												aria-label={t("serviceAccounts.table.editAction")}
											>
												<Edit2 className="size-3.5" />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												className="text-destructive hover:bg-destructive/10 hover:text-destructive"
												onClick={() => onDelete(account)}
												title={t("serviceAccounts.table.deleteAction")}
												aria-label={t("serviceAccounts.table.deleteAction")}
											>
												<Trash2 className="size-3.5" />
											</Button>
										</div>
									</TableCell>
								) : null}
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}
