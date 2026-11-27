import { usePermissions } from "@/hooks/use-permissions";
import { hasAnyPermission } from "@/lib/permissions";

/**
 * Same gate as the Administration sidebar section in AppSidebar —
 * true when the caller holds any of the admin-area permissions.
 */
export const ADMIN_ACCESS_ACTIONS = [
	"roles:read",
	"roles:write",
	"users:read",
	"users:write",
	"agents:read",
	"agents:write",
	"service_accounts:read",
	"service_accounts:write",
	"plugins:write",
	"settings:write",
	"settings.sso:write",
] as const;

/** Route/beforeLoad gate mirroring {@link useCanAccessAdmin}. */
export function canAccessAdmin(permissions: string[]): boolean {
	return hasAnyPermission(permissions, [...ADMIN_ACCESS_ACTIONS]);
}

export function useCanAccessAdmin(): boolean {
	const { hasPermission } = usePermissions();

	return ADMIN_ACCESS_ACTIONS.some((action) => hasPermission(action));
}
