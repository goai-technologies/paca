import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RolesQueryBoundary } from "@/components/admin/global-roles/role-option-list";
import { isFullAccessRole } from "@/components/admin/global-roles/role-picker";
import { useAssignUserRole } from "@/components/admin/users/use-assign-user-role";
import { InlineNotice } from "@/components/shared/inline-notice";
import { RoleChangeDialog } from "@/components/shared/role-change-dialog";
import type { User } from "@/lib/admin-api";
import { isProjectTemplate } from "@/lib/policy";
import { userAvatar } from "@/lib/provider-logos";
import { platformRolesQueryOptions } from "@/lib/role-api";

interface UserRoleDialogProps {
	user: User;
	/** The signed-in person is changing their own role. */
	isSelf?: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Changes a user's global roles in a dialog (see RoleChangeDialog). It is
 * apart from editing the profile because it is a different privilege
 * (`roles:assign`) and a different kind of decision: it changes what the
 * person may do.
 */
export function UserRoleDialog({
	user,
	isSelf = false,
	open,
	onOpenChange,
}: UserRoleDialogProps) {
	const { t } = useTranslation("admin");
	const rolesQuery = useQuery({ ...platformRolesQueryOptions, enabled: open });
	const currentIds = user.roles.map((r) => r.id);
	// A project template (project/*) only works attached per project; given
	// platform-wide it would reach every project. One the user already holds
	// stays listed, so saving never drops a role the person could not see.
	const roles = (rolesQuery.data ?? []).filter(
		(r) => !isProjectTemplate(r.policy) || currentIds.includes(r.id),
	);

	const { assign, isPending, error, clearError } = useAssignUserRole({
		userId: user.id,
		isSelf,
		onAssigned: () => onOpenChange(false),
	});

	return (
		<RoleChangeDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) clearError();
				onOpenChange(next);
			}}
			title={t("users.roleDialog.title")}
			description={t("users.roleDialog.description", {
				username: user.username,
			})}
			person={{ avatar: userAvatar(user), handle: user.username }}
			roles={roles}
			status={
				roles.length === 0 ? (
					<RolesQueryBoundary query={{ ...rolesQuery, data: roles }}>
						{() => null}
					</RolesQueryBoundary>
				) : undefined
			}
			currentIds={currentIds}
			saveLabel={t("users.roleDialog.assign")}
			savingLabel={t("users.roleDialog.assigning")}
			cancelLabel={t("users.formDialog.cancel")}
			isPending={isPending}
			error={error}
			onPick={clearError}
			onSave={assign}
			// Only called once the picks differ from the held roles, so the
			// own-account notice appears with a real change, not on open.
			warnings={({ roles: picked }) => (
				<>
					{picked.some(
						(r) => !currentIds.includes(r.id) && isFullAccessRole(r),
					) ? (
						<InlineNotice tone="warning">
							{t("users.roleDialog.fullAccessWarning")}
						</InlineNotice>
					) : null}
					{isSelf ? (
						<InlineNotice tone="warning">
							{t("users.roleDialog.selfWarning")}
						</InlineNotice>
					) : null}
				</>
			)}
		/>
	);
}
