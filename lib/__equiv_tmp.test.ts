// TEMPORAL — no se commitea. Compara la vía vieja (getTeacherAssignments por
// profesor) con la nueva (dbGetAllTeacherAssignments con el contexto) sobre la
// MISMA foto de datos, con un Supabase falso en memoria. Cero peticiones reales.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const SNAP = JSON.parse(readFileSync(process.env.SNAPSHOT_PATH!, 'utf8'));
const calls: string[] = [];

type Row = Record<string, unknown>;
function builder(table: string) {
  let rows: Row[] | null = table in SNAP ? (SNAP[table] as Row[]).map(r => ({ ...r })) : null;
  const sorts: Array<[string, boolean]> = [];
  let rng: [number, number] | null = null;
  let single: 'maybe' | 'one' | null = null;
  let write = false;
  const b: Record<string, unknown> = {};
  const filt = (fn: (r: Row) => boolean) => { if (rows) rows = rows.filter(fn); return b; };
  Object.assign(b, {
    select: () => b,
    eq: (c: string, v: unknown) => filt(r => r[c] === v),
    neq: (c: string, v: unknown) => filt(r => r[c] !== v),
    in: (c: string, vs: unknown[]) => filt(r => vs.includes(r[c])),
    gte: (c: string, v: string) => filt(r => String(r[c] ?? '') >= v),
    lte: (c: string, v: string) => filt(r => String(r[c] ?? '') <= v),
    is: (c: string, v: unknown) => filt(r => (r[c] ?? null) === v),
    not: () => b, or: () => b, ilike: () => b, limit: () => b, abortSignal: () => b,
    order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return b; },
    range: (a: number, z: number) => { rng = [a, z]; return b; },
    maybeSingle: () => { single = 'maybe'; return b; },
    single: () => { single = 'one'; return b; },
    update: () => { write = true; return b; }, insert: () => { write = true; return b; },
    upsert: () => { write = true; return b; }, delete: () => { write = true; return b; },
    then: (res: (v: unknown) => void) => {
      calls.push(`${write ? 'WRITE ' : ''}${table}`);
      if (write) return res({ data: null, error: null });
      if (!rows) return res({ data: null, error: { message: `relation "${table}" does not exist`, code: '42P01' } });
      let out = rows;
      if (sorts.length) out = [...out].sort((x, y) => {
        for (const [c, asc] of sorts) {
          const a = x[c] ?? '', z = y[c] ?? '';
          if (a < z) return asc ? -1 : 1;
          if (a > z) return asc ? 1 : -1;
        }
        return 0;
      });
      if (rng) out = out.slice(rng[0], rng[1] + 1);
      if (single) return res({ data: out[0] ?? null, error: null });
      return res({ data: out, error: null });
    },
  });
  return b;
}
const fake = {
  from: (t: string) => builder(t),
  rpc: (n: string) => ({ then: (res: (v: unknown) => void) => { calls.push(`rpc ${n}`); res({ data: n === 'get_students_with_assignments' ? SNAP.rpc : null, error: null }); } }),
  channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
};
vi.mock('@/lib/supabase', () => ({ supabase: fake }));

describe('ReviewRequestsTab: vía vieja vs nueva', () => {
  it('mismos horarios, mismas clases sin ingreso, mismas fechas incoherentes', async () => {
    const db = await import('@/lib/db');
    const { buildMissingJoinClasses } = await import('@/lib/reviewRequests');
    const { gridOccupancyOfTeacher } = await import('@/lib/teacherClasses');
    const { findStartDateMismatches } = await import('@/lib/studentPeriod');

    // El contexto, como lo arma TeachersContext.
    const teachers = await db.dbGetTeachers();
    const { students, assignments } = await db.dbGetAllStudentsWithAssignments();
    const [classJoinLogs, classRecords, classAnalyses] = await Promise.all([
      db.dbGetClassJoinLogs(), db.dbGetClassRecords(), db.dbGetClassTranscripts(),
    ]);

    calls.length = 0;
    const viejo = Object.fromEntries(await Promise.all(teachers.map(async t => [t.id, await db.getTeacherAssignments(t)] as const)));
    const pedidasViejo = calls.length;
    calls.length = 0;
    const nuevo = Object.fromEntries(await db.dbGetAllTeacherAssignments({ teachers, students, assignments }));
    const pedidasNuevo = calls.length;

    const porProfesor = (asgsByTeacher: Record<string, unknown[]>, monthYear: string, onlyWithSignal: boolean) => {
      const [y, m] = monthYear.split('-').map(Number);
      const from = `${monthYear}-01`, to = `${monthYear}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
      const out: Array<{ id: string; clases: unknown[] }> = [];
      for (const t of teachers) {
        const asgs = asgsByTeacher[t.id] as never;
        if (!asgs) continue;
        const clases = buildMissingJoinClasses({
          assignments: asgs, joinLogs: classJoinLogs, classRecords, requests: [],
          analyses: classAnalyses, pauses: [], teacherId: t.id, fromDate: from, toDate: to,
          todayIso: '2026-10-08', nowMinutes: 20 * 60,
          gridOccupancy: gridOccupancyOfTeacher(t), onlyWithSignal,
        });
        if (clases.length) out.push({ id: t.id, clases });
      }
      return out.sort((a, b) => b.clases.length - a.clases.length);
    };

    const resumen: string[] = [`peticiones vieja=${pedidasViejo} nueva=${pedidasNuevo}`];
    const norm = (l: unknown[]) => JSON.stringify([...(l as Array<{ studentName: string }>)].sort((a, b) => a.studentName.localeCompare(b.studentName)));
    const difHorarios = teachers.filter(t => norm(viejo[t.id] ?? []) !== norm(nuevo[t.id] ?? []));
    for (const t of difHorarios.slice(0, 5)) {
      const v = (viejo[t.id] ?? []) as Array<Record<string, unknown>>, n = (nuevo[t.id] ?? []) as Array<Record<string, unknown>>;
      const byName = (l: Array<Record<string, unknown>>) => new Map(l.map(a => [a.studentName as string, a]));
      const vm = byName(v), nm = byName(n);
      for (const k of new Set([...vm.keys(), ...nm.keys()])) {
        const a = vm.get(k), b = nm.get(k);
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        const campos = a && b ? Object.keys({ ...a, ...b }).filter(c => JSON.stringify(a[c]) !== JSON.stringify(b[c])) : [a ? 'solo en vieja' : 'solo en nueva'];
        resumen.push(`  ${t.id} · ${k}: ${campos.map(c => a && b ? `${c}: ${JSON.stringify(a[c])} → ${JSON.stringify(b[c])}` : c).join(' | ')}`);
      }
    }
    resumen.push(`profesores con horarios distintos: ${difHorarios.length} de ${teachers.length}`);

    for (const mes of ['2026-10', '2026-09']) for (const señal of [true, false]) {
      const a = JSON.stringify(porProfesor(viejo, mes, señal)), b = JSON.stringify(porProfesor(nuevo, mes, señal));
      const total = (porProfesor(viejo, mes, señal) as Array<{ clases: unknown[] }>).reduce((s, p) => s + p.clases.length, 0);
      resumen.push(`clases sin ingreso ${mes} conSeñal=${señal}: ${a === b ? 'IGUAL' : 'DISTINTO'} (${total} clases)`);
    }
    const mv = JSON.stringify(findStartDateMismatches({ assignments: Object.values(viejo).flat() as never, joinLogs: classJoinLogs, classRecords, analyses: classAnalyses }));
    const mn = JSON.stringify(findStartDateMismatches({ assignments: Object.values(nuevo).flat() as never, joinLogs: classJoinLogs, classRecords, analyses: classAnalyses }));
    resumen.push(`fechas de inicio incoherentes: ${mv === mn ? 'IGUAL' : 'DISTINTO'} (${JSON.parse(mv).length})`);
    console.log('\n' + resumen.join('\n'));
    expect(true).toBe(true);
  }, 120_000);
});
