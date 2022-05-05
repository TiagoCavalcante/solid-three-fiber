import { createThreeRoot, RenderProps } from "../core";
import { createPointerEvents } from "./events";
import { RootState, ThreeContext } from "../core/store";
import { Accessor, JSX, onCleanup, mergeProps } from "solid-js";
import { insert } from "../renderer";
import { Instance } from "../core/renderer";
import { StoreApi } from "zustand/vanilla";
import { EventManager } from "../core/events";
import { log } from "../solid";
import { threeReconciler } from "..";

export interface Props extends Omit<RenderProps<HTMLCanvasElement>, "size" | "events"> {
  // HTMLAttributes<HTMLDivElement>
  children: JSX.Element;
  fallback?: JSX.Element;
  // resize?: ResizeOptions
  events?: (store: StoreApi<RootState>) => EventManager<any>;
  id?: string;
  class?: string;
  height?: string;
  width?: string;
  tabIndex?: number;
  // style?: CSSProperties;
}

// type SetBlock = false | Promise<null> | null;

// const CANVAS_PROPS: Array<keyof Props> = [
//   "gl",
//   "events",
//   "shadows",
//   "linear",
//   "flat",
//   "orthographic",
//   "frameloop",
//   "dpr",
//   "performance",
//   "clock",
//   "raycaster",
//   "camera",
//   "onPointerMissed",
//   "onCreated",
// ];

export function Canvas(props: Props) {
  const allProps = mergeProps(
    {
      height: "100vh",
      width: "100vw"
    },
    props
  );

  let canvas: HTMLCanvasElement = (<canvas style={{ height: "100%", width: "100%" }} />) as any;
  let containerRef: HTMLDivElement = (
    <div
      id={allProps.id}
      class={allProps.class}
      style={{
        height: allProps.height,
        width: allProps.width,
        position: "relative",
        overflow: "hidden"
      }}
      tabIndex={allProps.tabIndex}
    >
      {canvas}
    </div>
  ) as any;

  const root = createThreeRoot(canvas, {
    events: createPointerEvents,
    size: containerRef.getBoundingClientRect(),
    camera: allProps.camera,
    shadows: allProps.shadows
  });

  new ResizeObserver(entries => {
    if (entries[0]?.target !== containerRef) return;
    root.getState().setSize(entries[0].contentRect.width, entries[0].contentRect.height);
  }).observe(containerRef);

  insert(
    root.getState().scene as unknown as Instance,
    (
      (
        <ThreeContext.Provider value={root}>{allProps.children}</ThreeContext.Provider>
      ) as unknown as Accessor<Instance[]>
    )()
  );

  onCleanup(() => {
    log("three", "cleanup");
    threeReconciler.removeRecursive(
      root.getState().scene.children as any,
      root.getState().scene as any,
      true
    );
    root.getState().scene.clear();
  });

  return containerRef;
}
