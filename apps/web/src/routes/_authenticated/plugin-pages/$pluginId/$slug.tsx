import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NoPermissionState } from "@/components/shared/no-permission-state";
import { myPermissionsQueryOptions } from "@/lib/admin-api";
import { hasPermission } from "@/lib/permissions";
import { pluginsQueryOptions } from "@/lib/plugin-api";
import { RemoteComponent } from "@/lib/plugins/loader";
import { usePluginBaseProps } from "@/lib/plugins/plugin-props";
import { usePluginRegistry } from "@/lib/plugins/registry";

export const Route = createFileRoute(
	"/_authenticated/plugin-pages/$pluginId/$slug",
)({
	loader: async ({ context: { queryClient } }) => {
		await Promise.all([
			queryClient.ensureQueryData(pluginsQueryOptions),
			queryClient
				.fetchQuery(myPermissionsQueryOptions)
				.catch(() => [] as string[]),
		]);
	},
	component: AppPluginPage,
});

/**
 * Full-page route that renders a plugin's `app.page` extension-point
 * component for the given plugin/nav-item slug — a top-level page that
 * belongs to neither a project nor the admin section and is not listed in
 * any sidebar. It exists so a plugin can own a URL on the Paca origin, most
 * importantly the address an external service redirects the browser back to
 * (an App-installation or OAuth callback).
 *
 * Living under `_authenticated` is the point: the layout resolves the current
 * user before the page mounts, which transparently refreshes an expired access
 * token from the refresh cookie, and — when the session is gone entirely —
 * sends the user to sign in and back here (see the `redirect` search param on
 * `/`). The plugin component then calls its own backend with the host-provided
 * `api` client, i.e. as an authenticated user, with the gates its routes
 * declare. Callers who lack the nav item's `requiredPermission` get a
 * no-permission state instead of the page; with none declared the page is open
 * to any signed-in user, so plugin pages that matter should declare one.
 */
function AppPluginPage() {
	const { t } = useTranslation("errors");
	const { pluginId, slug } = Route.useParams();
	const { getNavItems, isLoading } = usePluginRegistry();
	const navItem = getNavItems("app").find(
		(item) => item.pluginId === pluginId && item.slug === slug,
	);
	const { data: permissions = [] } = useQuery(myPermissionsQueryOptions);
	const baseProps = usePluginBaseProps(navItem?.registration);

	if (isLoading) return null;
	if (!navItem) {
		throw notFound();
	}

	if (
		navItem.requiredPermission &&
		!hasPermission(permissions, navItem.requiredPermission)
	) {
		return (
			<div className="flex flex-1 items-center justify-center p-6">
				<NoPermissionState
					title={t("pluginNoPermissionTitle")}
					description={t("pluginNoPermissionDescription", {
						pluginName: navItem.pluginName,
					})}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<RemoteComponent
				registration={navItem.registration}
				componentProps={baseProps}
				fallback={
					<div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive m-6">
						<AlertCircle className="size-3.5 shrink-0" />
						<span>
							{t("pluginLoadFailedPrefix")}{" "}
							<strong>{navItem.pluginName}</strong>{" "}
							{t("pluginLoadFailedSuffix")}
						</span>
					</div>
				}
			/>
		</div>
	);
}
