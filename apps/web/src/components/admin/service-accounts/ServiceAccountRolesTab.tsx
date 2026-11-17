import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PermissionSummary } from "@/components/admin/global-roles/permission-summary";
import { ServiceAccountRoleDialog } from "@/components/admin/service-accounts/ServiceAccountRoleDialog";
import { InlineNotice } from "@/components/shared/inline-notice";
import { RoleBadgeList, toRoleBadgeData } from "@/components/shared/role-badge";
import { Button } from "@/components/ui/button";
import { useCanAssignGlobalRole } from "@/hooks/use-can-assign-global-role";
import { usePermissions } from "@/hooks/use-permissions";
import { platformRolesQueryOptions } from "@/lib/role-api";
import type { ServiceAccount } from "@/lib/service-account-api";

/** How many of the role's permissions to list before folding the rest into "+N". */
const SUMMARY_LIMIT = 12;

/**
 * A service account's workspace roles: what it may do. A new account holds none,
 * so it can do nothing until someone grants it roles. Granting them is its own
 * privilege (`roles:assign`) on top of `service_accounts:write`. The roles are
 * changed in the same dialog as a user's.
 */
export function ServiceAccountRolesTab({
	account,
	canWrite,
}: {
	account: ServiceAccount;
	/** Whether the viewer may write this account (`service_accounts:write`). */
	canWrite: boolean;
}) {
	const { t } = useTranslation("admin");
	const { hasPermission } = usePermissions();
	const canAssignRole = useCanAssignGlobalRole();
	const canChange = canWrite && canAssignRole;
	const [dialogOpen, setDialogOpen] = useState(false);

	// The account only carries its roles' ids and names; what they grant comes
	// from the roles list, which needs roles:read.
	const { data: allRoles } = useQuery({
		...platformRolesQueryOptions,
		enabled: hasPermission("roles:read"),
	});
	const heldIds = account.roles.map((r) => r.id);
	const heldRoles = (allRoles ?? []).filter((r) => heldIds.includes(r.id));
	const hasRole = heldIds.length > 0;

	return (
		<div className="max-w-2xl space-y-4">
			<p className="text-sm text-muted-foreground">
				{t("serviceAccounts.detail.roles.description")}
			</p>

			<div className="space-y-4 rounded-xl border border-border/60 bg-card p-5">
				<div className="flex items-start gap-3">
					<div
						className={
							hasRole
								? "flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
								: "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
						}
					>
						{hasRole ? (
							<ShieldCheck className="size-4" aria-hidden="true" />
						) : (
							<ShieldOff className="size-4" aria-hidden="true" />
						)}
					</div>
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						{hasRole ? (
							heldRoles.length > 0 ? (
								heldRoles.map((role) => (
									<div key={role.id} className="flex flex-col gap-1.5">
										<RoleBadgeList
											roles={[toRoleBadgeData(role)]}
											className="[&_[data-kind]]:text-sm"
										/>
										{role.description ? (
											<p className="text-xs text-muted-foreground">
												{role.description}
											</p>
										) : null}
										<PermissionSummary role={role} limit={SUMMARY_LIMIT} />
									</div>
								))
							) : (
								<RoleBadgeList
									roles={account.roles.map((r) => ({ id: r.id, name: r.name }))}
								/>
							)
						) : (
							<div className="flex flex-col gap-1.5">
								<span className="text-sm font-semibold">
									{t("serviceAccounts.detail.roles.none")}
								</span>
								<span className="text-sm text-muted-foreground">
									{t("serviceAccounts.detail.roles.noneHint")}
								</span>
							</div>
						)}
					</div>
				</div>

				{canChange ? (
					<div className="flex justify-end border-t pt-4">
						<Button
							variant={hasRole ? "outline" : "default"}
							onClick={() => setDialogOpen(true)}
						>
							{t("serviceAccounts.detail.roles.change")}
						</Button>
					</div>
				) : null}
			</div>

			{canChange ? null : (
				<InlineNotice tone="info">
					{t("serviceAccounts.detail.roles.readOnly")}
				</InlineNotice>
			)}

			{canChange ? (
				<ServiceAccountRoleDialog
					account={account}
					open={dialogOpen}
					onOpenChange={setDialogOpen}
				/>
			) : null}
		</div>
	);
}
