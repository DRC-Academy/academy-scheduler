// Comprobación ANTES de aplicar la puesta al día de la oferta nueva (oct/2026).
//
// Para TODOS los alumnos compara el estado actual con el que quedaría tras
// aplicar los eventos de lib/planOrders: fecha de acceso, tipo de producto,
// producto de la oferta nueva y cupo mensual. Además recalcula las finanzas del
// mes de cada profesor con los dos juegos de alumnos y compara cupo, clases
// retenidas y total a pagar. NO escribe nada.
//
// Los datos de Woo entran como JSON (la API de Woo no está en .env.local):
//   node --import tsx scripts/comparar-oferta-nueva.mts \
//     --pedidos=p1.json,p2.json --suscripciones=s.json [--mes=2026-10]
// Cada JSON de pedidos es la respuesta de /wc/v3/orders (o { data: [...] }).
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const { loadPayoutDataset } = await import('@/lib/externalPayouts');
const { calculateTeacherFinance } = await import('@/lib/finance');
const { gridOccupancyOfTeacher } = await import('@/lib/teacherClasses');
const { buildPlanEvents, RESULT_LABEL } = await import('@/lib/planOrders');
const { toOrderLite, toSubscriptionLite } = await import('@/lib/planOrderStore');
const { quotaWeeklyHours, planTypeLabel, catalogProduct } = await import('@/lib/productCatalog');
const { accessOverrideOf, madridToday } = await import('@/lib/subscriptionAccess');
const { isCompanyProduct, baseProductName } = await import('@/lib/productUtils');
type Student = import('@/types').Student;

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? '';
const readArr = (p: string): Record<string, unknown>[] => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : (j.data ?? []);
};
const MES = arg('mes') || '2026-10';
const today = madridToday();

const orders = arg('pedidos').split(',').filter(Boolean).flatMap(readArr).map(toOrderLite);
const subs = arg('suscripciones').split(',').filter(Boolean).flatMap(readArr).map(toSubscriptionLite);

const ds = await loadPayoutDataset(true);
const before: Student[] = ds.students;

// Alumnos por email como los ve la activación (el primero creado gana).
const byEmail = new Map<string, import('@/lib/planOrders').StudentLite>();
for (const s of [...before].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
  const e = (s.email ?? '').trim().toLowerCase();
  if (!e || byEmail.has(e)) continue;
  byEmail.set(e, { id: s.id, name: s.name, email: e, manual_active_until: s.manualActiveUntil ?? null, product_name: s.productName ?? null, woo_product_id: s.wooProductId ?? null });
}

const events = buildPlanEvents({ orders, subscriptions: subs, studentsByEmail: byEmail, existing: new Map(), today });

// ── Tabla de la puesta al día ────────────────────────────────────────────────
const fmt = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
console.log(`\n══ PUESTA AL DÍA (simulación, hoy ${today}) — ${events.length} eventos ══`);
for (const e of events) {
  console.log([
    `${e.sourceType === 'order' ? 'Pedido' : 'Suscr.'} ${e.sourceId}`, e.studentName ?? `(${e.billingName || e.email})`,
    e.productName.slice(0, 48), `pago ${fmt(e.start)}`, `fin ${fmt(e.computedUntil)}`,
    `antes ${fmt(e.previousUntil)}`, `queda ${fmt(e.finalUntil)}`, RESULT_LABEL[e.result],
    e.needsAdmin ? `⚠️ ${e.note}` : '',
  ].join(' | '));
}

// ── Alumnos después ──────────────────────────────────────────────────────────
const after: Student[] = before.map(s => ({ ...s }));
const byId = new Map(after.map(s => [s.id, s]));
for (const e of events) {
  const s = e.studentId ? byId.get(e.studentId) : null;
  const w = e.studentWrite;
  if (!s || !w) continue;
  if (w.manual_active_until !== undefined) s.manualActiveUntil = w.manual_active_until as string;
  if (w.product_type !== undefined) s.productType = w.product_type as Student['productType'];
  if (w.woo_product_id !== undefined) s.wooProductId = w.woo_product_id as number;
  if (w.product_name !== undefined) s.productName = w.product_name as string;
  if (w.plan !== undefined) s.plan = w.plan as string;
  if (w.company_plan_start !== undefined) s.companyPlanStart = w.company_plan_start as string;
}

// ── Comparación alumno por alumno ────────────────────────────────────────────
const access = (s: Student) => {
  const o = accessOverrideOf({ manual_active_until: s.manualActiveUntil, is_oritalk: s.isOritalk, oritalk_until: s.oritalkUntil }, today);
  return o ? `${o.kind} hasta ${o.until}` : `según Woo (${s.productType ?? 'sin tipo'})`;
};
const asgOf = (id: string) => ds.assignments.filter(a => a.studentId === id);
const cupo = (s: Student) => asgOf(s.id).map(a => {
  const lim = (h: number) => ({ 1: 5, 2: 9, 3: 14, 4: 18, 5: 25 } as Record<number, number>)[h] ?? Math.max(5, h * 5);
  return lim(quotaWeeklyHours(a.weeklyHours ?? 0, s.wooProductId));
}).join('+') || '—';
const isCompany = (n: string) => isCompanyProduct(baseProductName(n));

const changed: string[] = [];
const oldPlanChanged: string[] = [];
for (const b of before) {
  const a = byId.get(b.id)!;
  const diffs: string[] = [];
  if (access(b) !== access(a)) diffs.push(`acceso: ${access(b)} → ${access(a)}`);
  if ((b.productType ?? null) !== (a.productType ?? null)) diffs.push(`tipo: ${b.productType ?? '—'} → ${a.productType}`);
  if (cupo(b) !== cupo(a)) diffs.push(`cupo: ${cupo(b)} → ${cupo(a)}`);
  if ((b.wooProductId ?? null) !== (a.wooProductId ?? null)) diffs.push(`plan: ${catalogProduct(a.wooProductId)?.name}`);
  if (!diffs.length) continue;
  const line = `${b.name} (${b.email}) · ${diffs.join(' · ')}`;
  changed.push(line);
  if (!catalogProduct(a.wooProductId)) oldPlanChanged.push(line);
}
console.log(`\n══ ALUMNOS QUE CAMBIAN: ${changed.length} de ${before.length} ══`);
changed.forEach(l => console.log(' · ' + l));
console.log(`\n══ ALUMNOS DE PLAN ANTIGUO QUE CAMBIAN: ${oldPlanChanged.length} ══`);
oldPlanChanged.forEach(l => console.log(' ⛔ ' + l));

// ── Finanzas del mes, profesor por profesor ──────────────────────────────────
const fin = (teacher: typeof ds.teachers[number], students: Student[]) => calculateTeacherFinance({
  teacherId: teacher.id, teacherName: teacher.name, monthYear: MES,
  assignments: ds.assignments, joinLogs: ds.joinLogs, classRecords: ds.classRecords,
  classAnalyses: ds.classAnalyses, rates: ds.rates, scoringEvents: ds.scoringEvents,
  students, manualApprovals: ds.manualApprovals, teacherBonuses: ds.teacherBonuses,
  payment: ds.payments.find(p => p.teacherId === teacher.id && p.monthYear === MES) ?? null,
  gridOccupancy: gridOccupancyOfTeacher(teacher),
});
console.log(`\n══ FINANZAS ${MES}: diferencias por profesor ══`);
let teachersChanged = 0;
for (const t of ds.teachers) {
  const x = fin(t, before), y = fin(t, after);
  const qd = y.studentQuota.filter(q => {
    const p = x.studentQuota.find(z => z.studentKey === q.studentKey);
    return !p || p.limit !== q.limit || p.used !== q.used;
  });
  if (x.totalAPagar === y.totalAPagar && x.totalExcedeLimite === y.totalExcedeLimite && qd.length === 0) continue;
  teachersChanged++;
  console.log(`${t.name}: total ${x.totalAPagar} → ${y.totalAPagar} € · retenidas ${x.totalExcedeLimite} → ${y.totalExcedeLimite}`);
  for (const q of qd) {
    const p = x.studentQuota.find(z => z.studentKey === q.studentKey);
    console.log(`   ${q.studentName}: cupo ${p?.limit ?? '—'} → ${q.limit} · usadas ${p?.used ?? '—'} → ${q.used}`);
  }
}
if (!teachersChanged) console.log('ningún profesor cambia de importe ni de cupo publicado');

// ── Etiquetas (informativo) ──────────────────────────────────────────────────
const tally = new Map<string, number>();
for (const s of after) {
  const l = planTypeLabel({ wooProductId: s.wooProductId, productName: s.productName, plan: s.plan, isOritalk: s.isOritalk, manualActiveUntil: s.manualActiveUntil, isCompany }) ?? '(sin etiqueta)';
  tally.set(l, (tally.get(l) ?? 0) + 1);
}
console.log('\n══ ETIQUETAS DE TIPO DE PLAN (después) ══');
for (const [l, n] of tally) console.log(` ${l}: ${n}`);
