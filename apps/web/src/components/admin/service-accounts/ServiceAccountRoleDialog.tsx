import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { RolesQueryBoundary } from "@/components/admin/global-roles/role-option-list";
import { isFullAccessRole } from "@/components/admin/global-roles/role-picker";
import { roleErrorKey } from "@/components/roles/role-errors";
import { InlineNotice } from "@/components/shared/inline-notice";
import { RoleChangeDialog } from "@/components/shared/role-change-dialog";
import { isProjectTemplate } from "@/lib/policy";
import { serviceAccountAvatar } from "@/lib/provider-logos";
import { platformRolesQueryOptions } from "@/lib/role-api";
import {
	replaceServiceAccountRoles,
	type ServiceAccount,
	serviceAccountsKey,
} from "@/lib/service-account-api";

interface ServiceAccountRoleDialogProps {
	account: ServiceAccount;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Changes a service account's workspace roles in the same dialog as a user's
 * (see RoleChangeDialog), from the accounts list and from the Roles tab of its
 * detail page. A new account holds none, so it can do nothing until someone
 * grants it roles (`roles:assign`); unticking every role removes them all.
 */
export function ServiceAccountRoleDialog({
	account,
	open,
	onOpenChange,
}: ServiceAccountRoleDialogProps) {
	const { t } = useTranslation("admin");
	const { t: tr } = useTranslation("roles");
	const queryClient = useQueryClient();
	const [error, setError] = useState<string | null>(null);

	const rolesQuery = useQuery({ ...platformRolesQueryOptions, enabled: open });
	// The account carries the roles it holds (the list and detail both load it).
	const currentIds = account.roles.map((r) => r.id);
	// A project template only works attached per project; given platform-wide it
	// would reach every project. One the account already holds stays listed.
	const roles = (rolesQuery.data ?? []).filter(
		(r) => !isProjectTemplate(r.policy) || currentIds.includes(r.id),
	);

	const mutation = useMutation({
		mutationFn: (roleIds: string[]) =>
			replaceServiceAccountRoles(account.id, roleIds),
		onSuccess: () => {
			setError(null);
			// The roles shown on the list and on the detail page come from the
			// account itself, so refresh those with the account's own role set.
			void queryClient.invalidateQueries({
				queryKey: serviceAccountsKey,
			});
			onOpenChange(false);
		},
		onError: (err: unknown) =>
			setError(tr(`errors.${roleErrorKey(err)}` as never)),
	});

	return (
		<RoleChangeDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) setError(null);
				onOpenChange(next);
			}}
			title={t("serviceAccounts.roleDialog.title")}
			description={t("serviceAccounts.roleDialog.description", {
				name: account.name,
			})}
			person={{ avatar: serviceAccountAvatar(account) }}
			roles={roles}
			status={
				roles.length === 0 ? (
					<RolesQueryBoundary query={{ ...rolesQuery, data: roles }}>
						{() => null}
					</RolesQueryBoundary>
				) : undefined
			}
			currentIds={currentIds}
			saveLabel={t("serviceAccounts.roleDialog.assign")}
			savingLabel={t("serviceAccounts.roleDialog.assigning")}
			cancelLabel={t("serviceAccounts.formDialog.cancel")}
			isPending={mutation.isPending}
			error={error}
			onPick={() => setError(null)}
			onSave={(ids) => mutation.mutate(ids)}
			warnings={({ roles: picked }) =>
				picked.some(
					(r) => !currentIds.includes(r.id) && isFullAccessRole(r),
				) ? (
					<InlineNotice tone="warning">
						{t("serviceAccounts.roleDialog.fullAccessWarning")}
					</InlineNotice>
				) : null
			}
		/>
	);
}
