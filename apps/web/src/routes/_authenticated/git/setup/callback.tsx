import { createFileRoute } from "@tanstack/react-router";
import { GitSetupCallback } from "@/components/git/GitSetupCallback";

export const Route = createFileRoute("/_authenticated/git/setup/callback")({
	component: GitSetupCallbackPage,
});

function GitSetupCallbackPage() {
	return <GitSetupCallback search={window.location.search} />;
}
