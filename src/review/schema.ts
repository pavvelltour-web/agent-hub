// JSON schemas for the reviewers' structured output, plus a tiny validator (ADR-010: no dependencies).
// The schemas are closed objects with every property required, the shape both CLIs accept (Codex `--output-schema` is strict about it).
// The validator is deliberately lenient about extras: unknown fields are not carried over, and over-long strings are clipped.

export interface Schema {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; maxItems?: number; maxLength?: number; minimum?: number; enum?: string[];
}

const str = (maxLength: number): Schema => ({ type: 'string', maxLength });
const obj = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const CATEGORIES = ['bug', 'risk', 'style', 'cleanup', 'diagnostic'];

export const FINDING_SCHEMA: Schema = obj({
  category: { type: 'string', enum: CATEGORIES },
  file: str(300),
  line: { type: 'integer', minimum: 1 },
  title: str(200),
  evidence: str(2000),
  classOfBug: str(1000),   // empty string = none
});

export const HUNT_SCHEMA: Schema = obj({
  summary: str(500),
  findings: { type: 'array', items: FINDING_SCHEMA, maxItems: 30 },
});

export const VERIFY_SCHEMA: Schema = obj({
  real: { type: 'boolean' },
  why: str(1500),
});

export type Validated = { ok: true; value: unknown } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Returns a cleaned copy (unknown fields dropped, strings clipped to `maxLength`) or the first problem found. */
export function validate(schema: Schema, value: unknown, path = '$'): Validated {
  const bad = (m: string): Validated => ({ ok: false, error: `${path}: ${m}` });
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return bad('expected string');
      if (schema.enum && !schema.enum.includes(value)) return bad(`not one of ${schema.enum.join('|')}`);
      return { ok: true, value: schema.maxLength !== undefined ? value.slice(0, schema.maxLength) : value };
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return bad('expected integer');
      if (schema.minimum !== undefined && value < schema.minimum) return bad(`below ${schema.minimum}`);
      return { ok: true, value };
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : bad('expected boolean');
    case 'array': {
      if (!Array.isArray(value)) return bad('expected array');
      const out: unknown[] = [];
      for (const [i, x] of value.slice(0, schema.maxItems ?? value.length).entries()) {
        const r = schema.items ? validate(schema.items, x, `${path}[${i}]`) : { ok: true as const, value: x };
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    case 'object': {
      if (!isObj(value)) return bad('expected object');
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(schema.properties ?? {})) {
        if (!(k in value) || value[k] === undefined) { if (schema.required?.includes(k)) return { ok: false, error: `${path}.${k}: required` }; continue; }
        const r = validate(s, value[k], `${path}.${k}`);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      return { ok: true, value: out };
    }
  }
}
