import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-store", () => ({ load: async () => ({get:async()=>undefined,set:async()=>{},onKeyChange:async()=>()=>{}}) }));
import { useAnswerEvaluationStore as evaluation } from "./answerEvaluationStore";
import { useMeetingStore } from "./meetingStore";
import { useTranscriptStore } from "./transcriptStore";
import { useStreamStore } from "./streamStore";
import type { Meeting, TranscriptSegment } from "../lib/types";
import type { AnswerEvaluation, EvaluationEvent } from "../lib/answerEvaluation";

const segment: TranscriptSegment = {id:"a",text:"Мой ответ",speaker:"User",timestamp_ms:1000,is_final:true,confidence:0.9};
const result: AnswerEvaluation = {id:"grade",meeting_id:"m",request_id:"r",segment_ids:["a"],question:"Q",answer:"A",score:72,missing:"Пример",improved:"Лучше",model:"test",created_at:1};
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  evaluation.getState().reset();
  useMeetingStore.setState({activeMeeting:{id:"m"} as Meeting});
  useTranscriptStore.setState({segments:[segment],selectedSegmentIds:[]});
  useStreamStore.getState().resetForMeeting();
});

it("submits a private evaluation while the main chat is streaming, without cancelling or changing it", async () => {
  useStreamStore.getState().startStream("Assist","model","custom",{requestId:"main"});
  useStreamStore.getState().appendToken("Main response");
  const main = useStreamStore.getState();
  useTranscriptStore.setState({selectedSegmentIds:["a"]});
  await evaluation.getState().run();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("evaluate_answers",expect.objectContaining({meetingId:"m",targets:[["a"]]}));
  expect(useStreamStore.getState()).toBe(main);
  expect(useTranscriptStore.getState().selectedSegmentIds).toEqual([]);
});

it("passes late-arriving questions in audio order, matching the visible answer blocks", async () => {
  useTranscriptStore.setState({segments:[segment,{...segment,id:"q",speaker:"Them",text:"Вопрос",timestamp_ms:0}]});
  await evaluation.getState().run();
  const payload=invoke.mock.calls[0][1] as {segments:{id:string}[]};
  expect(payload.segments.map((s)=>s.id)).toEqual(["q","a"]);
});

it("replaces an evaluation without waiting and ignores a late failure from its predecessor", async () => {
  let fail!: (error: string) => void;
  invoke.mockImplementationOnce(() => new Promise<void>((_, reject) => {fail=reject;}));
  const first=evaluation.getState().run();
  const oldId=evaluation.getState().requestId;
  await evaluation.getState().run();
  const newId=evaluation.getState().requestId;
  evaluation.getState().apply({meeting_id:"m",request_id:oldId!,status:"running",completed:0,total:1});
  expect(evaluation.getState().requestId).toBe(newId);
  fail("Old failure"); await first;
  expect(invoke).toHaveBeenCalledTimes(2); expect(oldId).not.toBe(newId);
  expect(evaluation.getState().status).toBe("running"); expect(evaluation.getState().error).toBeNull();
});

it("isolates other meetings and old request events while keeping per-answer batch results", () => {
  const running: EvaluationEvent={meeting_id:"m",request_id:"r",status:"running",completed:0,total:2};
  evaluation.getState().apply({...running,meeting_id:"other"}); expect(evaluation.getState().status).toBe("idle");
  evaluation.getState().apply(running);
  evaluation.getState().apply({...running,status:"item",completed:1,result});
  evaluation.getState().apply({...running,status:"item",completed:1,result});
  expect(evaluation.getState().results).toHaveLength(1);
  evaluation.getState().apply({...running,request_id:"old",status:"error",error:"Ignore"});
  expect(evaluation.getState().error).toBeNull();
  useMeetingStore.setState({activeMeeting:{id:"new"} as Meeting});
  evaluation.getState().reset();
  evaluation.getState().apply({...running,status:"done",completed:2});
  expect(evaluation.getState().status).toBe("idle");
});
