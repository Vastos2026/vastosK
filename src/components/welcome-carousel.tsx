"use client";

/**
 * Google Flow-style looping carousel: several columns of cards drifting
 * upward at different speeds, behind the welcome greeting. Takes real
 * reference-image URLs once the user's image folder lands (revamp plan,
 * "Deferred to next phase" — carousel image assets); until then each column
 * renders elegant gradient placeholder cards so the layout/motion is real
 * today, not just a mock.
 */

// Black & white, with the mild dark-green glow as the only colour — matches
// the rest of the theme (globals.css), never a saturated accent.
const PALETTES = [
  "from-white/10 to-transparent",
  "from-[#1f4d3a]/25 to-transparent",
  "from-surface-3 to-surface",
  "from-white/5 to-surface-2",
  "from-[#1f4d3a]/15 to-surface",
];

function Column({ seed, duration, reverse }: { seed: number; duration: number; reverse?: boolean }) {
  const cards = Array.from({ length: 6 }, (_, i) => PALETTES[(seed + i) % PALETTES.length]);
  const doubled = [...cards, ...cards];

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        className={reverse ? "animate-carousel-up" : "animate-carousel-down"}
        style={{ animationDuration: `${duration}s` }}
      >
        {doubled.map((gradient, i) => (
          <div
            key={i}
            className={`mb-4 aspect-[3/4] w-full rounded-2xl border border-white/5 bg-gradient-to-br ${gradient} shadow-lg`}
          />
        ))}
      </div>
    </div>
  );
}

export function WelcomeCarousel() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 grid grid-cols-4 gap-4 px-4 opacity-40 sm:grid-cols-6 lg:grid-cols-8"
      style={{
        maskImage: "linear-gradient(to bottom, transparent, black 25%, black 75%, transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent, black 25%, black 75%, transparent)",
      }}
    >
      {Array.from({ length: 8 }, (_, i) => (
        <Column key={i} seed={i} duration={26 + i * 3} reverse={i % 2 === 0} />
      ))}
    </div>
  );
}
