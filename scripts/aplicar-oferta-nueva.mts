// Puesta al día de la OFERTA NUEVA desde local: la misma que el botón
// "Oferta nueva" del dashboard (/api/admin/planes-oferta), para cuando hay que
// hacerla sin pasar por el panel.
//
// Mismas reglas (lib/planOrders.buildPlanEvents, sin autoOnly) y misma escritura
// (lib/planOrderStore.applyPlanEvents: primero el alumno, después la fila del
// pedido en woo_plan_events, idempotente). Lo ya aplicado sale "Ya procesado".
//
// La API de Woo no está en .env.local, así que los pedidos y suscripciones
// entran como JSON (respuesta de /wc/v3/orders y /wc/v3/subscriptions, o { data: [...] }):
//
//   node --import tsx scripts/aplicar-oferta-nueva.mts \
//     --pedidos=p1.json,p2.json --suscripciones=s.json          → SIMULA (no escribe)
//   ... --aplicar                                                → escribe
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}
const { createClient } = await import('@supabase/supabase-js');
const { buildPlanEvents, RESULT_LABEL } = await import('@/lib/planOrders');
const { toOrderLite, toSubscriptionLite, loadStudentsByEmail, loadExistingEvents, applyPlanEvents } = await import('@/lib/planOrderStore');
const { madridToday } = await import('@/lib/subscriptionAccess');

const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? '';
const readArr = (p: string): Record<string, unknown>[] => {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : (j.data ?? []);
};
const apply = process.argv.includes('--aplicar');
const today = madridToday();

const orders = arg('pedidos').split(',').filter(Boolean).flatMap(readArr).map(toOrderLite);
const subscriptions = arg('suscripciones').split(',').filter(Boolean).flatMap(readArr).map(toSubscriptionLite);
if (!orders.length) throw new Error('Sin pedidos: pasá --pedidos=archivo.json');

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const [studentsByEmail, ev] = await Promise.all([loadStudentsByEmail(admin), loadExistingEvents(admin)]);
if (ev.tableMissing) throw new Error('Falta la tabla woo_plan_events (supabase/migraciones/2026-10-28-oferta-nueva.sql).');

const events = buildPlanEvents({ orders, subscriptions, studentsByEmail, existing: ev.existing, today });
const fmt = (d: string | null | undefined) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
console.log(`\n══ ${apply ? 'APLICANDO' : 'SIMULACIÓN'} (hoy ${today}) — ${orders.length} pedidos, ${subscriptions.length} suscripciones, ${events.length} eventos ══`);
for (const e of events) {
  console.log([
    `${e.sourceType === 'order' ? 'Pedido' : 'Suscr.'} ${e.sourceId}`, e.studentName ?? `(${e.billingName || e.email})`,
    e.productName.slice(0, 40), `antes ${fmt(e.previousUntil)}`, `queda ${fmt(e.finalUntil)}`, RESULT_LABEL[e.result],
    e.needsAdmin ? `⚠️ ${e.note}` : '',
  ].join(' | '));
}
// Sin process.exit: en Windows, salir con handles de red abiertos rompe libuv.
if (!apply) {
  console.log('\n(simulación: no se escribió nada; añadí --aplicar para escribir)');
} else {
  const done = await applyPlanEvents(admin, events);
  const errors = done.filter(d => d.error);
  console.log(`\nEscritos: ${done.filter(d => d.written).length} · sin cambios: ${done.filter(d => !d.written && !d.error).length} · errores: ${errors.length}`);
  for (const d of errors) console.log(`  ✖ ${d.event.sourceType} ${d.event.sourceId}: ${d.error}`);
}
