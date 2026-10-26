const RULES: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['bearer', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['api-key', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['url-credentials', /(?<=:\/\/)[^\s/:@]+:[^\s/@]{3,}(?=@)/g],
  ['assignment', /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret)\b["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi],
];

/** Remove secret-looking material before text reaches the index, logs or the UI. */
export function redact(text: string): string {
  let out = text;
  for (const [kind, re] of RULES) {
    out = kind === 'assignment' ? out.replace(re, (_m, k: string) => `${k}[REDACTED:${kind}]`) : out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}
