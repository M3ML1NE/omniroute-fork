import { redirect } from "next/navigation";
import { DashboardLayout } from "@/shared/components";
import { getSettings } from "@/lib/localDb";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { hasManagementPasswordConfigured } from "@/lib/auth/managementPassword";

export default async function DashboardRootLayout({ children }: { children: React.ReactNode }) {
  const settings = await getSettings();
  const requireLogin = settings.requireLogin !== false;
  const hasPassword = hasManagementPasswordConfigured(settings);

  if (hasPassword && requireLogin) {
    const authenticated = await isDashboardSessionAuthenticated();
    if (!authenticated) {
      redirect("/login");
    }
  }

  return <DashboardLayout>{children}</DashboardLayout>;
}
