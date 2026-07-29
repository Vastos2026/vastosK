import { Icon } from "./icon";

/** Bordered, icon-led error banner — the treatment already used ad hoc across
 *  the app (upload/design/walkthrough pages); this makes it the shared
 *  default instead of the bare `<p className="text-danger">` a few forms
 *  still used. */
export function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-3 text-sm text-danger">
      <Icon name="CircleAlert" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
