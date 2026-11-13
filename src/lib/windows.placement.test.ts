import { beforeEach, expect, it, vi } from "vitest";
const state=vi.hoisted(()=>({meeting:{id:""} as {id:string}|null,events:[] as string[],wait:null as Promise<void>|null}));
const place=vi.hoisted(()=>vi.fn(async()=>{state.events.push("prepare");await state.wait;}));
vi.mock("./sessionWindowPlacement",()=>({placeSessionWindow:place}));
vi.mock("./logger",()=>({logToFile:vi.fn()}));
vi.mock("../stores/meetingStore",()=>({useMeetingStore:{getState:()=>({activeMeeting:state.meeting})}}));
vi.mock("@tauri-apps/api/webviewWindow",()=>({WebviewWindow:{getByLabel:async(label:string)=>Object.fromEntries(
  ["show","hide","unminimize","setFocus","setAlwaysOnTop"].map(method=>[method,async()=>{state.events.push(`${label}.${method}`);}])
)}}));
import { showOverlayWindow } from "./windows";
beforeEach(()=>{state.events=[];state.wait=null;place.mockClear();});

it("positions before the first show of each session, and keeps manual placement on return",async()=>{
  state.meeting={id:"placement-one"};
  await showOverlayWindow("placement-one");
  expect(state.events.indexOf("prepare")).toBeLessThan(state.events.indexOf("overlay.show"));
  await showOverlayWindow("placement-one");
  expect(place).toHaveBeenCalledTimes(1);
  state.meeting={id:"placement-two"};
  await showOverlayWindow("placement-two");
  expect(place).toHaveBeenCalledTimes(2);
});

it("does not reopen the session if Ctrl+M ends it while geometry queries are pending",async()=>{
  let release!:()=>void;
  state.wait=new Promise<void>(resolve=>{release=resolve;});
  state.meeting={id:"placement-ended"};
  const pending=showOverlayWindow("placement-ended");
  await vi.waitFor(()=>expect(place).toHaveBeenCalledOnce());
  state.meeting=null;release();await pending;
  expect(state.events).not.toContain("overlay.show");
  expect(state.events).not.toContain("launcher.hide");
});

it("still shows the session if monitor placement fails",async()=>{
  state.meeting={id:"placement-failed"};
  place.mockRejectedValueOnce(new Error("monitor disconnected"));
  await showOverlayWindow("placement-failed");
  expect(state.events).toContain("overlay.show");
});
