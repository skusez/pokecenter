
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "14:32" today, "Tue 14:32" this week, "3 Sep" otherwise. */
export const when = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const date = new Date(iso);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay(date, now)) return time;
  if (now.getTime() - date.getTime() < 6 * 86_400_000) {
    return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
};

export const sender = (addr: string): string => addr.replace(/^.*<([^>]+)>.*$/, "$1").trim();

export const STATUS: Record<string, { label: string; icon: string; tone: string }> = {
  new: { label: "Received", icon: "📥", tone: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200" },
  ignored: { label: "Ignored", icon: "🗑", tone: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  queued: { label: "Queued", icon: "🔧", tone: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200" },
  needs_owner: { label: "Needs you", icon: "🙋", tone: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200" },
  investigating: { label: "Investigating", icon: "🔎", tone: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200" },
  done: { label: "Done", icon: "✅", tone: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200" },
  error: { label: "Failed", icon: "💥", tone: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200" },
};

export const OUTCOME: Record<string, { label: string; icon: string }> = {
  pr_opened: { label: "Draft PR opened", icon: "✅" },
  answered: { label: "Answered", icon: "💬" },
  diagnosed_only: { label: "Diagnosed", icon: "🔍" },
  already_fixed: { label: "Already fixed", icon: "♻️" },
  not_reproducible: { label: "Not reproducible", icon: "🤷" },
};

export const statusOf = (status: string) => STATUS[status] ?? { label: status, icon: "•", tone: STATUS.new!.tone };
