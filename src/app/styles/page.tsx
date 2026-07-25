import { STYLES } from "@/lib/data";
import { RenderPreview } from "@/components/project/render-preview";
import { Icon } from "@/components/ui/icon";

export default function StylesPage() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-8 py-4">
        <h1 className="text-xl font-semibold tracking-tight">Design Styles</h1>
        <p className="text-sm text-muted">
          Indian-focused presets — each defines a palette, materials and lighting for AI rendering.
        </p>
      </header>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-8 py-6">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {STYLES.map((s) => (
            <div
              key={s.id}
              className="animate-fade-up overflow-hidden rounded-2xl border border-border bg-surface transition-colors hover:border-border-strong"
            >
              <div className="aspect-[16/10] overflow-hidden border-b border-border">
                <RenderPreview style={s} view="corner" />
              </div>
              <div className="p-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">{s.name}</h3>
                  <Icon name="Palette" className="size-4 text-muted" />
                </div>
                <p className="mt-0.5 text-sm text-muted">{s.tagline}</p>
                <div className="mt-3 flex gap-1.5">
                  {s.palette.map((c, i) => (
                    <span
                      key={i}
                      className="size-5 rounded-md ring-1 ring-inset ring-white/10"
                      style={{ background: c }}
                      title={c}
                    />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
