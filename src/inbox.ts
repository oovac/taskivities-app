// The inbox (the bell in the top bar): tasks given to me, comments on my tasks and handovers, read from the task
// history (worker/inbox.ts). Opening it marks everything shown as seen.
import type { InboxItem, InboxPage } from '../shared/types';
import { api } from './api';
import { openPop } from './actions';
import { S, set } from './store';

export function openInbox(anchor: HTMLElement) {
  set({ inbox: null });
  openPop({ type: 'inbox' }, anchor);
  void loadInbox();
}

/** Loads the newest entries (or, with `older`, the next page) and marks what's shown as seen. */
export async function loadInbox(older = false) {
  const cur = S().inbox;
  if (older && !cur?.next) return;
  set({ inbox: { items: cur?.items ?? [], next: cur?.next ?? null, readAt: cur?.readAt ?? null, loading: true } });
  try {
    const r = await api.get<InboxPage>(`/api/inbox${older ? `?before=${encodeURIComponent(cur!.next!)}` : ''}`);
    if (older) {
      set((s) => ({ inbox: { items: [...(s.inbox?.items ?? []), ...r.items], next: r.next, readAt: s.inbox?.readAt ?? r.readAt, loading: false } }));
      return;
    }
    // Refreshing while open keeps this visit's "unread" marks.
    const readAt = cur && !cur.loading && cur.items.length ? earlier(cur.readAt, r.readAt) : r.readAt;
    set({ inbox: { items: r.items, next: r.next, readAt, loading: false } });
    const newest = r.items[0]?.at;
    if (S().inboxUnread > 0 || (newest && (!r.readAt || newest > r.readAt))) await markRead(newest);
  } catch {
    set((s) => ({ inbox: s.inbox && { ...s.inbox, loading: false, error: true } }));
  }
}

const earlier = (a: string | null, b: string | null) => (!a || !b ? null : a < b ? a : b);

async function markRead(upTo: string | undefined) {
  try {
    const r = await api.post<{ unread: number }>('/api/inbox/read', { upTo });
    set({ inboxUnread: r.unread });
  } catch { /* the dot stays until next time */ }
}

/** Entries as the inbox shows them: a handover of several tasks at once is one row, and so are comments on one task. */
export interface InboxRow {
  key: string;
  kind: 'new' | 'assigned' | 'comment' | 'handover';
  items: InboxItem[];
  unread: boolean;
}

export function inboxRows(items: InboxItem[], readAt: string | null): InboxRow[] {
  const rows: InboxRow[] = [];
  const open = new Map<string, InboxRow>();
  for (const it of items) {
    const unread = !readAt || it.at > readAt;
    // Unread and seen entries never share a row, so something new can't hide in an old group.
    const key = it.kind === 'comment' ? `c|${it.taskId}|${unread}` : it.kind === 'assigned' ? `h|${it.actorId}|${it.at}` : `n|${it.id}`;
    const row = open.get(key);
    if (row) { row.items.push(it); continue; }
    const r: InboxRow = { key, kind: it.kind, items: [it], unread };
    open.set(key, r);
    rows.push(r);
  }
  // Several tasks handed over in one go (someone was disabled): one row. One task: an ordinary "gave you" row.
  for (const r of rows) if (r.kind === 'assigned' && r.items.length > 1) r.kind = 'handover';
  return rows;
}
