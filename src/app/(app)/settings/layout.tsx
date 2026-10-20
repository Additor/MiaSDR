import { Suspense } from "react";
import { SettingsHeader } from "./settings-header";
import { SettingsNav, SettingsNavFallback } from "./settings-nav";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <>
      <SettingsHeader />
      <div className="flex flex-col md:flex-row md:items-start">
        <Suspense fallback={<SettingsNavFallback />}>
          <SettingsNav />
        </Suspense>
        <div className="page min-w-0 flex-1">{children}</div>
      </div>
    </>
  );
}
