import {
  LayoutDashboard, Plus, Search, Bell, Settings, ChevronRight, ChevronLeft,
  ChevronDown, MoreVertical, X, Check, Trash2, ArrowLeft, ArrowRight, Sparkles,
  Wand2, Download, Undo2, Redo2, Eye, Layers, Image as ImageIcon, Upload, FileUp,
  RotateCw, Move, Maximize2, Grid3x3, Box, Sun, Lasso, Palette, Camera,
  SlidersHorizontal, Pencil, Copy, GitCompare, History, Star, Clock, Loader2,
  CircleCheck, CircleDashed, CircleAlert, Building2, Home, Briefcase, Store,
  Armchair, Table, BedDouble, DoorClosed, Tv, BookOpen, Lamp, Lightbulb, Frame,
  Sprout, Flame, Sofa, Maximize, ZoomIn, ZoomOut, RefreshCw, Crop, Paintbrush,
  PanelsTopLeft, Ruler, Trash, ImagePlus, Clapperboard, ListChecks, EyeOff,
  LogOut,
  type LucideIcon,
} from "lucide-react";

const REGISTRY: Record<string, LucideIcon> = {
  LayoutDashboard, Plus, Search, Bell, Settings, ChevronRight, ChevronLeft,
  ChevronDown, MoreVertical, X, Check, Trash2, ArrowLeft, ArrowRight, Sparkles,
  Wand2, Download, Undo2, Redo2, Eye, Layers, Image: ImageIcon, Upload, FileUp,
  RotateCw, Move, Maximize2, Grid3x3, Box, Sun, Lasso, Palette, Camera,
  SlidersHorizontal, Pencil, Copy, GitCompare, History, Star, Clock, Loader2,
  CircleCheck, CircleDashed, CircleAlert, Building2, Home, Briefcase, Store,
  Armchair, Table, BedDouble, DoorClosed, Tv, BookOpen, Lamp, Lightbulb, Frame,
  Sprout, Flame, Sofa, Maximize, ZoomIn, ZoomOut, RefreshCw, Crop, Paintbrush,
  PanelsTopLeft, Ruler, Trash, ImagePlus, Clapperboard, ListChecks, EyeOff,
  LogOut,
};

export type IconName = keyof typeof REGISTRY;

export function Icon({
  name,
  className,
  strokeWidth = 1.8,
}: {
  name: string;
  className?: string;
  strokeWidth?: number;
}) {
  const Cmp = REGISTRY[name] ?? Box;
  return <Cmp className={className} strokeWidth={strokeWidth} />;
}
