import { beforeEach, expect, it, vi } from "vitest";
import type { Monitor } from "@tauri-apps/api/window";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
const native = vi.hoisted(() => ({ monitorFromPoint: vi.fn(), primaryMonitor: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => native);
import { sessionWindowGeometry, placeSessionWindow } from "./sessionWindowPlacement";

const monitor = (x=0,y=0,width=1920,height=1080,scaleFactor=1): Monitor => ({
  position:{x,y}, size:{width,height}, scaleFactor,
  workArea:{position:{x,y},size:{width,height:height-40}},
}) as Monitor;
beforeEach(() => {native.monitorFromPoint.mockReset();native.primaryMonitor.mockReset();});

it("places 4:3 under the camera and preserves the current height", () => {
  const result=sessionWindowGeometry(monitor(),700);
  expect(result.logicalHeight).toBe(700);
  expect(result.logicalWidth/result.logicalHeight).toBeCloseTo(4/3);
  expect(result.x).toBe(494); expect(result.y).toBe(48);
});

it("uses monitor scaling and negative desktop coordinates", () => {
  const screen=monitor(-2560,-1440,2560,1440,1.25);
  const result=sessionWindowGeometry(screen,700);
  expect(result.logicalHeight).toBe(700);
  expect(result.y).toBe(-1380);
  expect(Math.abs(result.x+result.logicalWidth*1.25/2-(-1280))).toBeLessThan(1);
});

it("keeps the title area visible on small work areas without shrinking height", () => {
  const result=sessionWindowGeometry(monitor(0,0,1024,768),700);
  expect(result.y).toBe(28);
  expect(result.logicalHeight).toBe(700);
  const oversized=sessionWindowGeometry(monitor(0,0,1024,768),900);
  expect(oversized.x).toBe(0); expect(oversized.y).toBe(0);
  expect(oversized.logicalHeight).toBe(900);
});

it("uses the launcher's monitor and changes width while preserving logical height", async () => {
  native.monitorFromPoint.mockResolvedValue(monitor());
  const overlay={innerSize:vi.fn().mockResolvedValue({width:625,height:875}),scaleFactor:vi.fn().mockResolvedValue(1.25),setSize:vi.fn(),setPosition:vi.fn()};
  const launcher={outerPosition:vi.fn().mockResolvedValue({x:120,y:100}),outerSize:vi.fn().mockResolvedValue({width:900,height:650})};
  await placeSessionWindow(overlay as unknown as WebviewWindow,launcher as unknown as WebviewWindow);
  expect(native.monitorFromPoint).toHaveBeenCalledWith(570,425);
  expect(overlay.setSize).toHaveBeenCalledWith(expect.objectContaining({width:700*4/3,height:700}));
  expect(overlay.setPosition).toHaveBeenCalledWith(expect.objectContaining({x:494,y:48}));
});
