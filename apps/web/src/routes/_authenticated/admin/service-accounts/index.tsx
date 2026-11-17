import {
	keepPreviousData,
	useInfiniteQuery,
	useQuery,
} from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Plus, Search, ServerCog } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { DeleteServiceAccountDialog } from "@/components/admin/service-accounts/DeleteServiceAccountDialog";
import { ServiceAccountFormDialog } from "@/components/admin/service-accounts/ServiceAccountFormDialog";
import { ServiceAccountRoleDialog } from "@/components/admin/service-accounts/ServiceAccountRoleDialog";
import { ServiceAccountsTable } from "@/components/admin/service-accounts/ServiceAccountsTable";
import { LoadMoreSentinel } from "@/components/shared/load-more-sentinel";
import { NoPermissionState } from "@/components/shared/no-permission-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCanAssignGlobalRole } from "@/hooks/use-can-assign-global-role";
import { useDebouncedCallback } from "@/hooks/use-debounced-callback";
import { usePermissions } from "@/hooks/use-permissions";
import { myPermissionsQueryOptions } from "@/lib/admin-api";
import { hasPermission } from "@/lib/permissions";
import { platformRolesQueryOptions } from "@/lib/role-api";
import {
	type ServiceAccount,
	serviceAccountsInfiniteQueryOptions,
} from "@/lib/service-account-api";

export const Route = createFileRoute("/_authenticated/admin/service-accounts/")(
	{
		beforeLoad: async ({ context: { queryClient } }) => {
			const permissions = await queryClient
				.fetchQuery(myPermissionsQueryOptions)
				.catch(() => [] as string[]);
			if (
				!hasPermission(permissions, "service_accounts:read") &&
				!hasPermission(permissions, "service_accounts:write")
			) {
				throw redirect({ to: "/home" });
			}
		},
		component: ServiceAccountsPage,
	},
);

function ServiceAccountsPage() {
	const { t } = useTranslation("admin");
	const { hasPermission: can, isLoading: isPermissionsLoading } =
		usePermissions();
	const canRead = can("service_accounts:read");
	const canWrite = can("service_accounts:write");
	// Granting roles is its own privilege, separate from editing the account.
	// The roles route needs service_accounts:write on top of roles:assign.
	const canAssignRole = useCanAssignGlobalRole() && canWrite;

	// Search runs on the server (debounced); accounts page in by cursor.
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const applySearch = useDebouncedCallback(setDebouncedSearch, 300);
	const {
		data: accountPages,
		isLoading: isDataLoading,
		isError,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
		isFetchNextPageError,
	} = useInfiniteQuery({
		...serviceAccountsInfiniteQueryOptions(debouncedSearch),
		enabled: canRead,
		placeholderData: keepPreviousData,
	});
	const accounts = useMemo(
		() => accountPages?.pages.flatMap((p) => p.items) ?? [],
		[accountPages],
	);
	const isLoading = isPermissionsLoading || isDataLoading;
	// Role badges show descriptions when the viewer can read the roles list.
	const { data: roleDirectory } = useQuery({
		...platformRolesQueryOptions,
		retry: false,
	});

	const [createOpen, setCreateOpen] = useState(false);
	const [editAccount, setEditAccount] = useState<ServiceAccount | null>(null);
	const [rolesAccount, setRolesAccount] = useState<ServiceAccount | null>(null);
	const [deleteAccount, setDeleteAccount] = useState<ServiceAccount | null>(
		null,
	);

	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<div className="mb-1 flex items-center gap-2.5">
						<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
							<ServerCog className="size-4" />
						</div>
						<h1 className="text-xl font-semibold tracking-tight">
							{t("serviceAccounts.header.title")}
						</h1>
					</div>
					<p className="ml-10 text-sm text-muted-foreground">
						{t("serviceAccounts.header.description")}
					</p>
				</div>
				{canWrite ? (
					<Button
						size="sm"
						className="shrink-0"
						onClick={() => setCreateOpen(true)}
					>
						<Plus className="size-4" />
						{t("serviceAccounts.header.newAccount")}
					</Button>
				) : null}
			</div>

			{canWrite ? (
				<ServiceAccountFormDialog
					open={createOpen}
					onOpenChange={setCreateOpen}
				/>
			) : null}

			{!isPermissionsLoading && !canRead ? (
				<NoPermissionState
					icon={ServerCog}
					title={t("serviceAccounts.noPermission.title")}
					description={t("serviceAccounts.noPermission.description")}
				/>
			) : isLoading ? (
				<div className="flex flex-col gap-2">
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
				</div>
			) : isError ? (
				<NoPermissionState
					title={t("serviceAccounts.errors.loadFailed")}
					description={t("serviceAccounts.errors.tryAgain")}
				/>
			) : accounts.length === 0 && !debouncedSearch.trim() ? (
				<div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-14 text-center">
					<ServerCog className="size-9 text-muted-foreground/50" />
					<div>
						<p className="font-medium">{t("serviceAccounts.empty.title")}</p>
						<p className="text-sm text-muted-foreground">
							{t("serviceAccounts.empty.description")}
						</p>
					</div>
					{canWrite ? (
						<Button size="sm" onClick={() => setCreateOpen(true)}>
							<Plus className="size-4" />
							{t("serviceAccounts.empty.create")}
						</Button>
					) : null}
				</div>
			) : (
				<>
					<div className="relative max-w-sm">
						<Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							type="search"
							value={search}
							onChange={(e) => {
								setSearch(e.target.value);
								applySearch(e.target.value);
							}}
							placeholder={t("serviceAccounts.searchPlaceholder")}
							aria-label={t("serviceAccounts.searchPlaceholder")}
							className="pl-8"
						/>
					</div>
					<ServiceAccountsTable
						accounts={accounts}
						canWrite={canWrite}
						canAssignRole={canAssignRole}
						roleDirectory={roleDirectory}
						onEdit={setEditAccount}
						onDelete={setDeleteAccount}
						onChangeRole={setRolesAccount}
					/>
					<LoadMoreSentinel
						hasMore={!!hasNextPage}
						isLoadingMore={isFetchingNextPage}
						isError={isFetchNextPageError}
						onLoadMore={() => void fetchNextPage()}
					/>
				</>
			)}

			{editAccount ? (
				<ServiceAccountFormDialog
					key={editAccount.id}
					account={editAccount}
					open
					onOpenChange={(open) => !open && setEditAccount(null)}
				/>
			) : null}
			{rolesAccount ? (
				<ServiceAccountRoleDialog
					account={rolesAccount}
					open
					onOpenChange={(open) => !open && setRolesAccount(null)}
				/>
			) : null}
			{deleteAccount ? (
				<DeleteServiceAccountDialog
					account={deleteAccount}
					open
					onOpenChange={(open) => !open && setDeleteAccount(null)}
				/>
			) : null}
		</div>
	);
}
