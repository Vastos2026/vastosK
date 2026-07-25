import { useId } from "react";
import type { DesignStyle, RenderJob } from "@/lib/types";
import { shade, cn } from "@/lib/utils";

/**
 * Procedural, stylized "photoreal" interior used as a stand-in for the
 * AI render. Composition shifts per camera view; palette comes from the style.
 */
export function RenderPreview({
  style,
  view = "corner",
  className,
}: {
  style: DesignStyle;
  view?: RenderJob["view"];
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");

  const wall = style.wallColor;
  const wallDark = shade(wall, -0.18);
  const wallShadow = shade(wall, -0.34);
  const ceiling = shade(wall, -0.08);
  const floor = style.floorColor;
  const floorDark = shade(floor, -0.28);
  const accent = style.accentColor;
  const sofa = shade(wall, -0.52);
  const sofaLight = shade(wall, -0.4);
  const wood = shade(floor, -0.3);

  if (view === "top") {
    return <TopView uid={uid} style={style} className={className} />;
  }

  // Camera shift for front / side / corner
  const dx = view === "front" ? 0 : view === "side" ? 26 : 14;

  return (
    <svg viewBox="0 0 320 200" className={cn("h-full w-full", className)} preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id={`floor-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={floorDark} />
          <stop offset="100%" stopColor={floor} />
        </linearGradient>
        <linearGradient id={`wall-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={shade(wall, 0.04)} />
          <stop offset="100%" stopColor={wallDark} />
        </linearGradient>
        <linearGradient id={`sky-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfe3f5" />
          <stop offset="100%" stopColor="#f3ead6" />
        </linearGradient>
        <radialGradient id={`glow-${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.5" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`vig-${uid}`} cx="50%" cy="48%" r="62%">
          <stop offset="60%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.5" />
        </radialGradient>
      </defs>

      {/* room shell — one-point perspective */}
      <rect x="0" y="0" width="320" height="200" fill={wallDark} />
      <polygon points="0,0 320,0 240,40 80,40" fill={ceiling} />
      <polygon points="0,0 80,40 80,140 0,200" fill={wallShadow} />
      <polygon points="320,0 240,40 240,140 320,200" fill={shade(wall, -0.24)} />
      <polygon points={`0,200 320,200 240,140 80,140`} fill={`url(#floor-${uid})`} />
      <rect x="80" y="40" width="160" height="100" fill={`url(#wall-${uid})`} />

      {/* window on back wall */}
      <g transform={`translate(${dx},0)`}>
        <rect x="98" y="58" width="52" height="50" rx="2" fill={`url(#sky-${uid})`} stroke={shade(wall, -0.4)} strokeWidth="2" />
        <line x1="124" y1="58" x2="124" y2="108" stroke={shade(wall, -0.4)} strokeWidth="1.5" />
        <line x1="98" y1="83" x2="150" y2="83" stroke={shade(wall, -0.4)} strokeWidth="1.5" />
        {/* framed art */}
        <rect x="176" y="64" width="30" height="38" rx="1" fill={shade(accent, -0.2)} stroke={shade(wall, -0.45)} strokeWidth="2" />
        <rect x="181" y="70" width="20" height="26" fill={shade(accent, 0.25)} opacity="0.7" />
      </g>

      {/* warm light wash from window */}
      <ellipse cx={130 + dx} cy="120" rx="90" ry="60" fill={`url(#glow-${uid})`} />

      {/* rug */}
      <ellipse cx={160 + dx * 0.4} cy="176" rx="96" ry="17" fill={accent} opacity="0.18" />

      {/* sofa */}
      <g transform={`translate(${dx * 0.4},0)`}>
        <rect x="108" y="150" width="104" height="26" rx="5" fill={sofa} />
        <rect x="108" y="142" width="104" height="14" rx="5" fill={sofaLight} />
        <rect x="104" y="148" width="12" height="30" rx="4" fill={shade(sofa, -0.1)} />
        <rect x="204" y="148" width="12" height="30" rx="4" fill={shade(sofa, -0.1)} />
        <rect x="120" y="146" width="38" height="12" rx="3" fill={shade(sofaLight, 0.06)} />
        <rect x="162" y="146" width="38" height="12" rx="3" fill={shade(sofaLight, 0.06)} />
        {/* coffee table */}
        <ellipse cx="160" cy="186" rx="30" ry="7" fill={shade(wood, -0.2)} opacity="0.5" />
        <rect x="142" y="178" width="36" height="8" rx="2" fill={wood} />
      </g>

      {/* floor lamp */}
      <g transform={`translate(${dx},0)`}>
        <rect x="232" y="120" width="3" height="58" fill={shade(wall, -0.5)} />
        <ellipse cx="233" cy="118" rx="9" ry="6" fill={shade(accent, 0.2)} />
        <circle cx="233" cy="118" r="14" fill={`url(#glow-${uid})`} />
      </g>

      {/* plant (corner views only) */}
      {view !== "front" && (
        <g transform="translate(-2,0)">
          <path d="M70 178 L62 178 L64 162 L68 162 Z" fill={shade(wood, 0.05)} />
          <path d="M66 162 C56 150 60 138 66 134 C70 142 70 154 66 162 Z" fill="#4f7a4f" />
          <path d="M66 162 C76 150 74 140 70 134 C64 144 64 154 66 162 Z" fill="#5e8c5e" />
        </g>
      )}

      {/* pendant light */}
      <line x1={160 + dx} y1="40" x2={160 + dx} y2="64" stroke={shade(wall, -0.5)} strokeWidth="1.5" />
      <circle cx={160 + dx} cy="66" r="4" fill={shade(accent, 0.3)} />
      <circle cx={160 + dx} cy="66" r="12" fill={`url(#glow-${uid})`} />

      {/* vignette + grain */}
      <rect x="0" y="0" width="320" height="200" fill={`url(#vig-${uid})`} />
    </svg>
  );
}

function TopView({ uid, style, className }: { uid: string; style: DesignStyle; className?: string }) {
  const floor = style.floorColor;
  const accent = style.accentColor;
  const wood = shade(floor, -0.3);
  const sofa = shade(style.wallColor, -0.5);

  return (
    <svg viewBox="0 0 320 200" className={cn("h-full w-full", className)} preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id={`tlight-${uid}`} cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor={shade(floor, 0.12)} />
          <stop offset="100%" stopColor={shade(floor, -0.2)} />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="320" height="200" fill={`url(#tlight-${uid})`} />
      {/* walls */}
      <rect x="24" y="20" width="272" height="160" fill="none" stroke={shade(floor, -0.5)} strokeWidth="6" />
      {/* rug */}
      <rect x="96" y="74" width="128" height="78" rx="4" fill={accent} opacity="0.18" />
      {/* sofa (top-down) */}
      <rect x="104" y="58" width="112" height="22" rx="4" fill={sofa} />
      {/* coffee table */}
      <rect x="140" y="98" width="40" height="26" rx="3" fill={wood} />
      {/* dining */}
      <rect x="232" y="40" width="48" height="70" rx="4" fill={wood} />
      {[50, 72, 94].map((cy) => (
        <circle key={cy} cx="224" cy={cy} r="6" fill={shade(sofa, 0.05)} />
      ))}
      {/* bed */}
      <rect x="40" y="120" width="64" height="48" rx="3" fill={sofa} />
      <rect x="40" y="120" width="64" height="14" rx="3" fill={shade(sofa, 0.12)} />
      {/* shadows */}
      <rect x="104" y="80" width="112" height="6" fill="#000" opacity="0.18" />
    </svg>
  );
}
