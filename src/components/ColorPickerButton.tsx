import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";

const PALETTE = [
  { name: "Белый", value: "#e4e4e7" },
  { name: "Тёплый", value: "#d6d3d1" },
  { name: "Снежный", value: "#f8fafc" },
  { name: "Голубой", value: "#67e8f9" },
  { name: "Небесный", value: "#7dd3fc" },
  { name: "Янтарный", value: "#fbbf24" },
  { name: "Оранжевый", value: "#fb923c" },
  { name: "Изумрудный", value: "#6ee7b7" },
  { name: "Лаймовый", value: "#a3e635" },
  { name: "Розовый", value: "#fda4af" },
  { name: "Розовый", value: "#f9a8d4" },
  { name: "Лавандовый", value: "#c4b5fd" },
  { name: "Индиго", value: "#a5b4fc" },
  { name: "Персиковый", value: "#fdba74" },
  { name: "Бирюзовый", value: "#5eead4" },
];

interface ColorPickerButtonProps {
  value: string;
  onChange: (color: string) => void;
  label?: string;
}

export function ColorPickerButton({ value, onChange, label }: ColorPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleOpen = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleOpen}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-white/5 transition-colors cursor-pointer"
        title={label || "Выбрать цвет"}
      >
        <div
          className="h-3.5 w-3.5 rounded border border-white/15"
          style={{ backgroundColor: value }}
        />
        <svg className="h-2 w-2 text-muted-foreground/35" viewBox="0 0 12 12" fill="none">
          <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={ref}
          className="fixed z-[9999] rounded-lg border border-white/10 p-2.5 shadow-2xl shadow-black/60"
          style={{
            backgroundColor: '#111122',
            left: `${Math.max(90, Math.min(pos.x - 90, window.innerWidth - 195))}px`,
            top: `${Math.max(8, pos.y - 185)}px`,
          }}
        >
          {/* Color grid — 5x3, no scale transforms */}
          <div className="grid grid-cols-5 gap-[7px]">
            {PALETTE.map((c) => (
              <button
                key={c.value}
                onClick={() => { onChange(c.value); setOpen(false); }}
                className={`h-[22px] w-[22px] rounded-[5px] transition-all duration-100 cursor-pointer ${
                  value === c.value
                    ? "ring-[1.5px] ring-white/60 ring-offset-[2px] ring-offset-[#111122]"
                    : "hover:brightness-110 hover:ring-1 hover:ring-white/25 hover:ring-offset-1 hover:ring-offset-[#111122]"
                }`}
                style={{ backgroundColor: c.value }}
                title={c.name}
              />
            ))}
          </div>

          {/* Hex input */}
          <div className="mt-2 flex items-center gap-1.5 border-t border-white/6 pt-2">
            <div
              className="h-3.5 w-3.5 rounded-[3px] border border-white/10 shrink-0"
              style={{ backgroundColor: value }}
            />
            <span className="text-[0.6rem] text-muted-foreground/30 font-mono">#</span>
            <input
              type="text"
              value={value.replace('#', '')}
              onChange={(e) => {
                const hex = e.target.value.replace('#', '');
                if (/^[0-9a-fA-F]{0,6}$/.test(hex)) {
                  if (hex.length === 6) onChange(`#${hex}`);
                }
              }}
              className="w-14 bg-transparent text-[0.6rem] text-foreground/60 outline-none font-mono tracking-wider"
              maxLength={6}
              placeholder="custom"
            />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
