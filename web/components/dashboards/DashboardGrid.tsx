"use client";

import ReactGridLayout, { type Layout, WidthProvider } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { DashboardItem } from "@/lib/types";
import { DashboardTile } from "./DashboardTile";

const GridLayout = WidthProvider(ReactGridLayout);

export function DashboardGrid({
  items,
  onLayoutChange,
  onRemove,
}: {
  items: DashboardItem[];
  onLayoutChange: (layout: Layout[]) => void;
  onRemove: (itemId: string) => void;
}) {
  const layout: Layout[] = items.map((item) => ({
    i: item.id,
    x: item.layout.x,
    y: item.layout.y,
    w: item.layout.w,
    h: item.layout.h,
    minW: 3,
    minH: 4,
  }));

  return (
    <GridLayout
      layout={layout}
      cols={12}
      rowHeight={30}
      margin={[16, 16]}
      compactType="vertical"
      draggableCancel=".no-drag"
      onLayoutChange={onLayoutChange}
    >
      {items.map((item) => (
        <div key={item.id}>
          <DashboardTile item={item} onRemove={() => onRemove(item.id)} />
        </div>
      ))}
    </GridLayout>
  );
}
