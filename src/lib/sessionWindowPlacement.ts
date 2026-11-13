import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { monitorFromPoint, primaryMonitor } from "@tauri-apps/api/window";
import type { Monitor } from "@tauri-apps/api/window";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Camera assumed at the top center of the display containing the launcher. */
export function sessionWindowGeometry(monitor: Monitor, logicalHeight: number) {
  const logicalWidth = logicalHeight * 4 / 3;
  const width = Math.round(logicalWidth * monitor.scaleFactor);
  const height = Math.round(logicalHeight * monitor.scaleFactor);
  const area = monitor.workArea;
  const clamp = (value: number, origin: number, room: number) => Math.round(Math.max(origin, Math.min(value, origin + Math.max(0, room))));
  return {
    logicalWidth, logicalHeight,
    x: clamp(monitor.position.x + (monitor.size.width - width) / 2, area.position.x, area.size.width - width),
    y: clamp(monitor.position.y + 48 * monitor.scaleFactor, area.position.y, area.size.height - height),
  };
}

export async function placeSessionWindow(overlay: WebviewWindow, launcher: WebviewWindow | null) {
  const [size, scale] = await Promise.all([overlay.innerSize(), overlay.scaleFactor()]);
  if (!(size.height > 0 && scale > 0)) throw new Error("Не удалось определить высоту окна сессии");
  let monitor: Monitor | null = null;
  if (launcher) {
    try {
      const [position, bounds] = await Promise.all([launcher.outerPosition(), launcher.outerSize()]);
      monitor = await monitorFromPoint(position.x + bounds.width / 2, position.y + bounds.height / 2);
    } catch { /* The primary display is the fallback if the launcher is unavailable. */ }
  }
  monitor ??= await primaryMonitor();
  if (!monitor) throw new Error("Не удалось определить монитор для окна сессии");
  const geometry = sessionWindowGeometry(monitor, size.height / scale);
  // Preserve the current logical height, including a height chosen by the user.
  await overlay.setSize(new LogicalSize(geometry.logicalWidth, geometry.logicalHeight));
  await overlay.setPosition(new PhysicalPosition(geometry.x, geometry.y));
}
