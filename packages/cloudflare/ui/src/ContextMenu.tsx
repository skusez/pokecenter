import { useEffect, useRef } from "react";

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean } | "separator";

/** A right-click menu pinned to the cursor. Closes on any click, Escape, or scroll. */
export const ContextMenu = ({ at, items, onClose }: { at: { x: number; y: number }; items: MenuItem[]; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = () => onClose();
    const key = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    // Deferred a tick: React commits this menu while the contextmenu event
    // that opened it is still bubbling, so a listener added now would close
    // it before it was ever seen.
    const armed = setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("keydown", key);
    }, 0);
    return () => {
      clearTimeout(armed);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);

  // Keep the menu on screen near the edges.
  const width = 200;
  const height = items.length * 34 + 8;
  const x = Math.min(at.x, window.innerWidth - width - 8);
  const y = Math.min(at.y, window.innerHeight - height - 8);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: x, top: y, width }}
      className="fixed z-50 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-[#232326] shadow-xl py-1 text-sm"
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item, index) =>
        item === "separator" ? (
          <div key={index} className="my-1 border-t border-zinc-200 dark:border-zinc-700" />
        ) : (
          <button
            key={index}
            role="menuitem"
            className={`block w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 ${item.danger ? "text-red-600 dark:text-red-400" : ""}`}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
};
