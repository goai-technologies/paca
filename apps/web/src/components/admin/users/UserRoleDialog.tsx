import { useTranslation } from "react-i18next";
import { isFullAccessRole } from "@/components/admin/global-roles/role-picker";
import { useRoleChoices } from "@/components/admin/global-roles/use-role-choices";
import { useAssignUserRole } from "@/components/admin/users/use-assign-user-role";
import { InlineNotice } from "@/components/shared/inline-notice";
import { RoleChangeDialog } from "@/components/shared/role-change-dialog";
import type { User } from "@/lib/admin-api";
import { userAvatar } from "@/lib/provider-logos";

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
	const currentIds = user.roles.map((r) => r.id);
	const { roles, knownRoles, remote, status } = useRoleChoices(
		open,
		currentIds,
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
			knownRoles={knownRoles}
			remote={remote}
			status={status}
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
