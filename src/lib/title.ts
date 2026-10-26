/** Readable one-line session title from raw first-message text: drops markdown markers, tags, attached-file lists and agent boilerplate. */
const BOILERPLATE = /^(files mentioned by the user:?|<[^>]{1,40}>|\[image[^\]]*\]|caveat:.*?(?=\s{2,}|$))\s*/i;
const MARKS = /^[#>*\-\s`]+/;
const ATTACHED = /^[#\s]*\S+\.\w{2,5}:\s+[A-Za-z]:[\\/]\S+\s*/;

export function cleanTitle(raw: string | null | undefined, max = 90): string | null {
  if (!raw) return null;
  let t = raw.replace(/<(system-reminder|ide_[a-z_]+|command-[a-z]+)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 6; i++) { const n = t.replace(MARKS, '').replace(BOILERPLATE, '').replace(ATTACHED, ''); if (n === t) break; t = n; }
  t = t.replace(/[`*_]+/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
