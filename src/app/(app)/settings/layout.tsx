import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { logout } from "@/app/actions/auth";
import { buttonClass, PageHeader } from "@/components/ui";
import { SettingsTabs } from "./settings-client";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader
        title="Settings"
        tabs={
          <div className="flex items-end gap-2 border-b border-line">
            <SettingsTabs />
            {/* Phones have no sidebar footer, so Log out lives here. */}
            <form action={logout} className="md:hidden shrink-0 pb-1">
              <button type="submit" className={buttonClass("ghost", "sm", "h-8")}><LogOut size={15} />Log out</button>
            </form>
          </div>
        }
      />
      {children}
    </>
  );
}
