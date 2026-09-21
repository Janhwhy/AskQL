// react-grid-layout ships Flow types (index.js.flow), not TypeScript
// declarations -- @types/react-grid-layout is a deprecated empty stub that
// defers back to the library itself, so it provides nothing useful. This is
// a minimal local shim covering only the surface this project actually uses.
declare module "react-grid-layout" {
  import { Component, type ComponentType, type ReactNode } from "react";

  export interface Layout {
    i: string;
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    minH?: number;
    maxW?: number;
    maxH?: number;
    static?: boolean;
  }

  export interface ReactGridLayoutProps {
    className?: string;
    layout?: Layout[];
    cols?: number;
    rowHeight?: number;
    width?: number;
    margin?: [number, number];
    containerPadding?: [number, number];
    compactType?: "vertical" | "horizontal" | null;
    isDraggable?: boolean;
    isResizable?: boolean;
    draggableCancel?: string;
    onLayoutChange?: (layout: Layout[]) => void;
    children?: ReactNode;
  }

  export default class ReactGridLayout extends Component<ReactGridLayoutProps> {}

  export function WidthProvider<P extends object>(
    ComposedComponent: ComponentType<P>
  ): ComponentType<Omit<P, "width"> & { width?: number }>;
}
