import { cn } from "@/lib/utils";

/**
 * A ring of dots that orbits (outer container spins via the existing
 * `vasto-spin` keyframe) while each dot individually scale-pulses on a
 * staggered delay — the "AI is generating an image" motif (ChatGPT-style),
 * built entirely from transform/opacity so it stays compositor-only.
 */
export function GeneratingLoader({ className }: { className?: string }) {
  const dots = Array.from({ length: 8 });
  return (
    <div className={cn("relative size-10", className)} role="status" aria-label="Generating">
      <div className="absolute inset-0 animate-[vasto-spin_2.4s_linear_infinite]">
        {dots.map((_, i) => {
          const angle = (360 / dots.length) * i;
          return (
            <span
              key={i}
              className="absolute left-1/2 top-1/2 size-1.5 rounded-full bg-accent"
              style={{
                transform: `translate(-50%, -50%) rotate(${angle}deg) translate(0, -16px)`,
                animation: `vasto-dot-pulse 1.2s ease-in-out ${(i / dots.length) * 1.2}s infinite`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
