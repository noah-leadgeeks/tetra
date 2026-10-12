import { auth } from "@/server/auth";
import { AgentAccessView } from "@/components/settings/agent-access-view";

export const metadata = {
  title: "Agent access — TETRA",
};

export default async function AgentSettingsPage() {
  await auth();
  return <AgentAccessView />;
}
