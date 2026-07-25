import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-foreground hover:bg-accent-hover font-medium shadow-[0_1px_0_rgba(255,255,255,0.15)_inset]",
  secondary: "bg-surface-3 text-foreground hover:bg-border border border-border",
  ghost: "text-muted hover:text-foreground hover:bg-surface-2",
  outline: "border border-border-strong text-foreground hover:bg-surface-2 hover:border-accent/50",
  danger: "bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-lg",
  lg: "h-12 px-6 text-[15px] gap-2 rounded-xl",
  icon: "h-9 w-9 rounded-lg justify-center",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: string;
  iconRight?: string;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", icon, iconRight, loading, children, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap transition-colors duration-150 select-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...props}
      >
        {loading ? (
          <Icon name="Loader2" className="size-4 animate-spin" />
        ) : (
          icon && <Icon name={icon} className={cn(size === "sm" ? "size-3.5" : "size-4")} />
        )}
        {children}
        {iconRight && !loading && (
          <Icon name={iconRight} className={cn(size === "sm" ? "size-3.5" : "size-4")} />
        )}
      </button>
    );
  },
);
Button.displayName = "Button";
