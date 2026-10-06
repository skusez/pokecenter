import { useAtomSet } from "@effect/atom-react";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { Upload } from "./api";
import { sendNoteAtom } from "./atoms";

type Pending = Upload & { preview: string | null; size: number };

const read = (file: File): Promise<Pending> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result);
      resolve({
        filename: file.name || `pasted-${Date.now()}.png`,
        mimeType: file.type || "application/octet-stream",
        data: url.slice(url.indexOf(",") + 1),
        preview: file.type.startsWith("image/") ? url : null,
        size: file.size,
      });
    };
    reader.readAsDataURL(file);
  });

export const Composer = ({ shortId, disabled }: { shortId: string; disabled: boolean }) => {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const send = useAtomSet(sendNoteAtom, { mode: "promise" });

  const add = async (list: Iterable<File>) => {
    const pending = await Promise.all(Array.from(list).map(read));
    setFiles((current) => [...current, ...pending]);
  };

  const submit = async () => {
    if (sending || (!text.trim() && files.length === 0)) return;
    setSending(true);
    setError(null);
    try {
      await send({ shortId, text: text.trim(), attachments: files.map(({ preview: _p, size: _s, ...upload }) => upload) });
      setText("");
      setFiles([]);
    } catch (cause) {
      setError((cause as { message?: string }).message ?? String(cause));
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length > 0) {
      event.preventDefault();
      void add(pasted);
    }
  };

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] p-3">
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((file, index) => (
            <div key={index} className="relative">
              {file.preview ? (
                <img src={file.preview} alt={file.filename} className="h-16 rounded-md border border-zinc-200 dark:border-zinc-700" />
              ) : (
                <div className="h-16 grid place-items-center rounded-md border border-zinc-200 dark:border-zinc-700 px-2 text-xs">📎 {file.filename}</div>
              )}
              <button
                className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-zinc-800 text-white text-xs leading-none"
                onClick={() => setFiles(files.filter((_, i) => i !== index))}
                aria-label="Remove attachment"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="mb-2 text-xs text-red-500">{error}</div>}
      {disabled && <div className="mb-2 text-xs text-zinc-500">Investigating now — a note sent here would be lost. Wait for the result, then reply.</div>}
      <div className="flex items-end gap-2">
        <button
          className="size-9 shrink-0 grid place-items-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          onClick={() => input.current?.click()}
          aria-label="Attach a file"
          title="Attach"
        >
          📎
        </button>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) void add(event.target.files);
            event.target.value = "";
          }}
        />
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          placeholder={disabled ? "Wait for the result…" : "Tell the agent what to do — Enter to send, Shift+Enter for a new line"}
          className="flex-1 resize-none rounded-2xl border border-zinc-300 dark:border-zinc-700 bg-transparent px-3.5 py-2 text-[15px] outline-none focus:border-sky-500"
        />
        <button
          onClick={() => void submit()}
          disabled={sending || (!text.trim() && files.length === 0)}
          className="size-9 shrink-0 grid place-items-center rounded-full bg-sky-600 text-white disabled:opacity-40"
          aria-label="Send"
        >
          ↑
        </button>
      </div>
    </div>
  );
};
