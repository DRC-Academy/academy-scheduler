// Cliente de Supabase FALSO, en memoria, para probar el núcleo de transferencia
// sin base. Cubre solo lo que usan el núcleo y sus stores: select/insert/update/
// upsert con eq, in, is, gte, or (eq/is), order, limit, maybeSingle, single,
// count head, y la RPC apply_calendar_patch con la misma regla que la real.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Grid } from '@/types';
import { applyChanges, type GridChanges } from '@/lib/gridPatch';

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export interface FakeDbHooks {
  /** Se llama antes de cada RPC apply_calendar_patch (n = número de llamada, desde 1). */
  beforePatch?: (n: number, teacherId: string, db: FakeDb) => void;
  /** Devuelve un error para forzar el fallo de una operación. */
  failWrite?: (table: string, op: 'insert' | 'update' | 'upsert' | 'delete', values: Row | Row[]) => { message: string; code?: string } | null;
  /** Devuelve un error para forzar el fallo de una lectura. */
  failRead?: (table: string) => { message: string; code?: string } | null;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  patchCalls = 0;
  hooks: FakeDbHooks = {};

  constructor(init: Record<string, Row[]>) {
    for (const [t, rows] of Object.entries(init)) this.tables[t] = rows.map(r => structuredClone(r));
  }

  rows(table: string): Row[] { return (this.tables[table] ??= []); }
  grid(teacherId: string): Grid {
    return (this.rows('teacher_calendars').find(r => r.teacher_id === teacherId)?.grid as Grid) ?? {};
  }

  client(): SupabaseClient {
    return { from: (t: string) => new Query(this, t), rpc: (fn: string, args: Row) => this.rpc(fn, args) } as unknown as SupabaseClient;
  }

  private async rpc(fn: string, args: Row) {
    if (fn !== 'apply_calendar_patch') return { data: null, error: { message: 'no existe', code: 'PGRST202' } };
    const teacherId = args.p_teacher_id as string;
    this.patchCalls++;
    this.hooks.beforePatch?.(this.patchCalls, teacherId, this);
    const cal = this.rows('teacher_calendars');
    let row = cal.find(r => r.teacher_id === teacherId);
    if (!row) { row = { teacher_id: teacherId, grid: {} }; cal.push(row); }
    const before = structuredClone(row.grid as Grid);
    const r = applyChanges(before, args.p_changes as GridChanges);
    if (r.applied.length) row.grid = structuredClone(r.grid);
    return { data: { before, grid: structuredClone(r.grid), applied: r.applied, conflicts: r.conflicts }, error: null };
  }
}

function parseOr(expr: string): Filter {
  const parts = expr.split(',').map(p => {
    const [col, op, ...rest] = p.split('.');
    // PostgREST admite el valor entre comillas dobles ("t1").
    const val = rest.join('.').replace(/^"(.*)"$/, '$1');
    if (op === 'eq') return (r: Row) => String(r[col]) === val;
    if (op === 'neq') return (r: Row) => r[col] != null && String(r[col]) !== val;
    if (op === 'is' && val === 'null') return (r: Row) => r[col] == null;
    if (op === 'ilike') {
      const re = new RegExp(`^${val.split('%').map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return (r: Row) => re.test(String(r[col] ?? ''));
    }
    throw new Error(`or() no soportado: ${p}`);
  });
  return r => parts.some(f => f(r));
}

class Query implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private values: Row | Row[] | null = null;
  private returning = false;
  private singleMode: 'maybe' | 'one' | null = null;
  private head = false;
  private lim: number | null = null;
  private desde = 0;

  constructor(private db: FakeDb, private table: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op !== 'select') this.returning = true;
    if (opts?.head) this.head = true;
    return this;
  }
  insert(v: Row | Row[]) { this.op = 'insert'; this.values = v; return this; }
  update(v: Row) { this.op = 'update'; this.values = v; return this; }
  upsert(v: Row | Row[]) { this.op = 'upsert'; this.values = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c: string, v: unknown) { this.filters.push(r => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push(r => r[c] !== v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push(r => vs.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push(r => r[c] == v); return this; }
  gte(c: string, v: string) { this.filters.push(r => String(r[c] ?? '') >= v); return this; }
  /** Sin distinguir mayúsculas; % es comodín. */
  ilike(c: string, patron: string) {
    const escapado = patron.split('%').map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    const re = new RegExp(`^${escapado}$`, 'i');
    this.filters.push(r => re.test(String(r[c] ?? '')));
    return this;
  }
  or(expr: string) { this.filters.push(parseOr(expr)); return this; }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  range(from: number, to: number) { this.desde = from; this.lim = to - from + 1; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  single() { this.singleMode = 'one'; return this; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(ok, ko);
  }

  private run(): { data: unknown; error: unknown; count?: number } {
    const rows = this.db.rows(this.table);
    const match = () => rows.filter(r => this.filters.every(f => f(r)));
    if (this.op !== 'select') {
      const err = this.db.hooks.failWrite?.(this.table, this.op, (this.values ?? {}) as Row);
      if (err) return { data: null, error: err };
    }
    if (this.op === 'insert') {
      const list = (Array.isArray(this.values) ? this.values : [this.values as Row])
        .map((v, i) => (v.id === undefined ? { id: `${this.table}_${rows.length + i + 1}`, ...v } : v));
      for (const v of list) {
        const k = v.idempotency_key;
        if (k != null && rows.some(r => r.idempotency_key === k)) return { data: null, error: { message: 'duplicate key', code: '23505' } };
      }
      for (const v of list) rows.push(structuredClone(v));
      if (!this.returning) return { data: null, error: null };
      return { data: this.singleMode ? { ...list[0] } : list.map(v => ({ ...v })), error: null };
    }
    if (this.op === 'upsert') {
      for (const v of (Array.isArray(this.values) ? this.values : [this.values as Row])) {
        const i = rows.findIndex(r => r.teacher_id === v.teacher_id && r.id === v.id);
        if (i >= 0) rows[i] = { ...rows[i], ...structuredClone(v) }; else rows.push(structuredClone(v));
      }
      return { data: null, error: null };
    }
    if (this.op === 'delete') {
      const quitar = new Set(match());
      this.db.tables[this.table] = rows.filter(r => !quitar.has(r));
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      const hit = match();
      for (const r of hit) Object.assign(r, structuredClone(this.values as Row));
      return { data: this.returning ? hit.map(r => ({ ...r })) : null, error: null };
    }
    const readErr = this.db.hooks.failRead?.(this.table);
    if (readErr) return { data: null, error: readErr };
    let out = match().map(r => structuredClone(r));
    if (this.head) return { data: null, error: null, count: out.length };
    if (this.lim != null) out = out.slice(this.desde, this.desde + this.lim);
    if (this.singleMode) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
}
