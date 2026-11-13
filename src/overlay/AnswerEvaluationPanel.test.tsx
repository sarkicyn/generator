import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core",()=>({invoke:async()=>{}}));
vi.mock("@tauri-apps/plugin-store",()=>({load:async()=>({get:async()=>undefined,set:async()=>{}})}));
import { AnswerEvaluationPanel } from "./AnswerEvaluationPanel";
import { useAnswerEvaluationStore } from "../stores/answerEvaluationStore";
const first={id:"1",meeting_id:"m",request_id:"r",segment_ids:["a"],question:"Q",answer:"A",score:72,missing:"Пример",improved:"Добавлю пример.",model:"test",created_at:1};
afterEach(cleanup);
it("shows just score, missing points and improved answer, with independent navigation",()=>{
  useAnswerEvaluationStore.setState({requestId:"r",status:"done",completed:2,total:2,error:null,results:[first,{...first,id:"2",score:90,missing:"Ничего существенного",improved:"Другой ответ."}]});
  render(<AnswerEvaluationPanel/>);
  expect(screen.getByText("Оценка: 72%")).toBeInTheDocument();
  expect(screen.getByText("Добавлю пример.")).toBeInTheDocument();
  expect(screen.queryByText("Что получилось:")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Следующая оценка"}));
  expect(screen.getByText("Оценка: 90%")).toBeInTheDocument();
  expect(screen.getByText("Другой ответ.")).toBeInTheDocument();
});
