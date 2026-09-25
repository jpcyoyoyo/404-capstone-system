// Small display helpers shared by the pages.
export function fmtTime(isoTs: string | null | undefined, withSeconds = false): string {
  if (!isoTs) return '—';
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
}

export function fmtDateTime(isoTs: string | null | undefined): string {
  if (!isoTs) return '—';
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(isoTs: string | null | undefined, now = Date.now()): string {
  if (!isoTs) return 'never';
  const s = Math.max(0, Math.round((now - new Date(isoTs).getTime()) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function untilText(isoTs: string | null | undefined, now = Date.now()): string {
  if (!isoTs) return '';
  const s = Math.max(0, Math.round((new Date(isoTs).getTime() - now) / 1000));
  if (s < 60) return `${s}s left`;
  return `${Math.ceil(s / 60)} min left`;
}

export function initials(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export function downloadFile(name: string, content: string, type = 'text/csv') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}
