/**
 * Google Flow-style looping carousel: several columns of cards drifting
 * upward at different speeds, behind the welcome greeting. Renders real
 * interior/architecture reference photos (public/carousel/) in their true
 * color, dimmed and lightly desaturated with a dark + green tint so they
 * read as moody background texture, not a bright photo grid competing
 * with the "Hello" greeting in front of them.
 */

const IMAGES = [
  "apartment_interior_0.jpg",
  "apartment_interior_1.jpg",
  "apartment_interior_2.jpg",
  "apartment_interior_3.jpg",
  "colorful_modern_interior_0.jpg",
  "colorful_modern_interior_1.jpg",
  "colorful_modern_interior_2.jpg",
  "colorful_modern_interior_3.jpg",
  "minimalist_office_interior_0.jpg",
  "minimalist_office_interior_1.jpg",
  "minimalist_office_interior_2.jpg",
  "minimalist_office_interior_3.jpg",
  "modern_architecture_building_0.jpg",
  "modern_architecture_building_1.jpg",
  "modern_architecture_building_2.jpg",
  "modern_architecture_building_3.jpg",
  "modern_minimalist_exterior_1.jpg",
  "modern_minimalist_exterior_2.jpg",
  "modern_minimalist_exterior_3.jpg",
  "modern_minimalist_interior_0.jpg",
  "modern_minimalist_interior_1.jpg",
  "modern_minimalist_interior_2.jpg",
  "modern_minimalist_interior_3.jpg",
  "traditional_home_exterior_0.jpg",
  "traditional_home_exterior_1.jpg",
  "traditional_home_exterior_3.jpg",
];

function Column({ seed, duration, reverse }: { seed: number; duration: number; reverse?: boolean }) {
  const cards = Array.from({ length: 6 }, (_, i) => IMAGES[(seed + i * 3) % IMAGES.length]);
  const doubled = [...cards, ...cards];

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        className={reverse ? "animate-carousel-up" : "animate-carousel-down"}
        style={{ animationDuration: `${duration}s` }}
      >
        {doubled.map((file, i) => (
          <div
            key={i}
            className="relative mb-4 aspect-[3/4] w-full overflow-hidden rounded-2xl border border-white/5 shadow-lg"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/carousel/${file}`}
              alt=""
              className="h-full w-full object-cover"
              style={{ filter: "brightness(0.72) saturate(0.85) contrast(1.05)" }}
            />
            {/* Dark + faint green tint, matching the theme's mild dark-green
                glow so the now-colorful photos still read as moody background
                texture, not a bright photo grid competing with the greeting
                in front of them. */}
            <div className="absolute inset-0 bg-gradient-to-br from-black/35 via-[#1f4d3a]/20 to-black/55" />
          </div>
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
