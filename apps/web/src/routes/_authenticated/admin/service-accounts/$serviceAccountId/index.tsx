import { createFileRoute, redirect } from "@tanstack/react-router";

import { ServiceAccountDetailView } from "@/components/admin/service-accounts/ServiceAccountDetailView";
import { myPermissionsQueryOptions } from "@/lib/admin-api";
import { hasPermission } from "@/lib/permissions";

// The service account counterpart of routes/.../admin/agents/$agentId: the same
// layout (header, tabs, one pane per tab), see ServiceAccountDetailView.
export const Route = createFileRoute(
	"/_authenticated/admin/service-accounts/$serviceAccountId/",
)({
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
	component: ServiceAccountDetailPage,
});

function ServiceAccountDetailPage() {
	const { serviceAccountId } = Route.useParams();
	return <ServiceAccountDetailView accountId={serviceAccountId} />;
}
