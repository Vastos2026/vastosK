import { CATALOG, FURNITURE_CATEGORIES } from "@/lib/data";
import { Icon } from "@/components/ui/icon";

export default function AssetsPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-8 py-4">
        <h1 className="text-xl font-semibold tracking-tight">Asset Library</h1>
        <p className="text-sm text-muted">Furniture & decor available to place in the 3D studio.</p>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-8 py-6">
        <div className="space-y-8">
          {FURNITURE_CATEGORIES.map((cat) => {
            const items = CATALOG.filter((c) => c.category === cat.id);
            if (!items.length) return null;
            return (
              <section key={cat.id}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">{cat.label}</h2>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {items.map((c) => (
                    <div
                      key={c.id}
                      className="group rounded-2xl border border-border bg-surface p-4 transition-colors hover:border-border-strong"
                    >
                      <div className="grid aspect-square place-items-center rounded-xl bg-grid bg-bg">
                        <span
                          className="grid size-12 place-items-center rounded-xl"
                          style={{ background: `${c.color}22`, color: c.color }}
                        >
                          <Icon name={c.icon} className="size-6" />
                        </span>
                      </div>
                      <p className="mt-3 truncate text-sm font-medium">{c.name}</p>
                      <p className="text-xs text-muted">{c.w}×{c.d} ft</p>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
