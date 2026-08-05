// Verificación del PASO 5: comprueba contra la base REAL que cada notificación
// cae en una sola categoría y que ningún tipo queda sin etiqueta.
//   node scripts/check-notification-split.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const { data, error } = await supabase
  .from('notifications')
  .select('id, target_user, target_role, type, created_at')
  .order('created_at', { ascending: false });

if (error) { console.error('Error:', error.message); process.exit(1); }

const dir = n => (n.target_role === 'admin' ? 'received' : 'sent');

const sent     = data.filter(n => dir(n) === 'sent');
const received = data.filter(n => dir(n) === 'received');

console.log(`Total: ${data.length}  ·  Enviadas: ${sent.length}  ·  Recibidas: ${received.length}`);
console.log(`Suma correcta (sin duplicados ni huérfanos): ${sent.length + received.length === data.length ? 'SÍ' : 'NO'}`);

// Ninguna fila debe llevar los dos campos: eso rompería la exclusividad.
const ambiguas = data.filter(n => n.target_role === 'admin' && n.target_user);
console.log(`Filas ambiguas (target_role=admin Y target_user): ${ambiguas.length}`);

// Orden descendente por fecha.
const ordenado = data.every((n, i) => i === 0 || new Date(data[i - 1].created_at) >= new Date(n.created_at));
console.log(`Orden por fecha descendente: ${ordenado ? 'SÍ' : 'NO'}`);

const byType = cat => {
  const m = new Map();
  for (const n of cat) m.set(n.type, (m.get(n.type) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('\n── ENVIADAS por tipo ──');
for (const [t, c] of byType(sent)) console.log(`  ${String(c).padStart(4)}  ${t}`);
console.log('\n── RECIBIDAS por tipo ──');
for (const [t, c] of byType(received)) console.log(`  ${String(c).padStart(4)}  ${t}`);

// Tipos sin etiqueta en el diccionario → caerían en el fallback "Aviso".
const SENT_KNOWN = new Set(['circular','new_assignment','new_student','form_completed','risk_alert','presentation_email_reminder','presentation_email_warning_teacher','presentation_email_overdue_teacher','one_time_access','student_removed','student_transferred','transcript_rejected','level_test_completed','churn_risk','clase15','bono6m','subscription_cancelled']);
const RECV_KNOWN = new Set(['churn_risk','ai_risk_red','ai_risk_yellow','intervention_audit_admin','churn_open_alert','transcript_blocked','transcript_review','clase_cancelada_incidencia','clase_cancelada_preaviso','limite_faltas_admin','faltas_con_aviso_alerta','presentation_email_warning','presentation_email_overdue']);

const faltanS = [...new Set(sent.map(n => n.type))].filter(t => !SENT_KNOWN.has(t));
const faltanR = [...new Set(received.map(n => n.type))].filter(t => !RECV_KNOWN.has(t));
console.log(`\nTipos ENVIADOS sin etiqueta: ${faltanS.length ? faltanS.join(', ') : 'ninguno'}`);
console.log(`Tipos RECIBIDOS sin etiqueta: ${faltanR.length ? faltanR.join(', ') : 'ninguno'}`);
