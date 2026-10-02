// Aviso a cada profesor del importe de su liquidación, ANTES de pagar, para que
// confirme que coincide con su conteo. Sale desde pagos@drcacademy.com.
//
// El importe es el de computeMonth (lib/externalPayouts), que llama a
// calculateTeacherFinance con las mismas entradas que app/finanzas: la cifra del
// correo es la que el admin ve en pantalla.
//
//   npx tsx scripts/aviso-conteo-pago.mts                     ← ensayo: lista, no envía
//   npx tsx scripts/aviso-conteo-pago.mts --test facu@x.com   ← UN correo de muestra a esa dirección
//   npx tsx scripts/aviso-conteo-pago.mts --enviar            ← envía a todos
//   MES=2026-09 (por defecto, el mes anterior al actual)
import { readFileSync } from 'node:fs';
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '');
}

const { loadPayoutDataset, computeMonth, currentMonthYear } = await import('@/lib/externalPayouts');

const FROM = 'DRC Academy Pagos <pagos@drcacademy.com>';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const args = process.argv.slice(2);
const enviar = args.includes('--enviar');
const ti = args.indexOf('--test');
const testTo = ti >= 0 ? args[ti + 1] : null;

function mesAnterior(m: string): string {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mm - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const MES = process.env.MES ?? mesAnterior(currentMonthYear());
const [y, m] = MES.split('-').map(Number);
const mesLabel = `${MESES[m - 1]} ${y}`;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const euros = (n: number) => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
// Los nombres de la plantilla son de usuario ("Daiana.M", "Sol.G", "DanielaN"):
// en el saludo va solo el nombre.
const nombrePila = (n: string) => n.trim().split(/[.\s]/)[0].replace(/(?<=[a-z])[A-Z]+$/, '');

function html(nombre: string, importe: number): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1c1a">
<p>Hola ${esc(nombre)},</p>
<p>Antes de proceder con el pago escribimos para confirmar contigo el conteo.</p>
<p>Hemos verificado su conteo en DRC Gestión y vemos que el conteo es de <strong>${euros(importe)}</strong>.</p>
<p>Queríamos saber si esa cifra es correcta y concuerda con tu conteo antes de proceder con el pago.</p>
<p>Un saludo.</p>
</div>`;
}
const subject = `Confirmación del conteo de ${mesLabel}`;

const ds = await loadPayoutDataset(true);
const res = computeMonth(ds, MES);
const byId = new Map(ds.teachers.map(t => [t.id, t]));

const filas = res.teachers
  .filter(p => p.total_amount > 0)
  .map(p => {
    const t = byId.get(p.teacher_id)!;
    const to = (t.notificationEmail?.trim() || t.email?.trim() || '');
    return { nombre: nombrePila(t.name), completo: t.name, to, importe: p.total_amount, clases: p.classes_payable, estado: p.status };
  });

console.log(`Mes: ${mesLabel} (${MES}) · ${filas.length} profesores con importe · total ${euros(filas.reduce((s, f) => s + f.importe, 0))}\n`);
for (const f of filas) {
  console.log(`  ${f.completo.padEnd(32)} ${euros(f.importe).padStart(12)}  ${String(f.clases).padStart(4)} clases  ${f.estado.padEnd(8)}  → ${f.to || '⚠ SIN EMAIL'}`);
}
const sinEmail = filas.filter(f => !f.to);
const sinImporte = res.teachers.filter(p => p.total_amount <= 0).map(p => p.teacher_name);
if (sinImporte.length) console.log(`\nSin importe (no reciben correo): ${sinImporte.join(', ')}`);

async function send(emails: Array<{ from: string; to: string[]; subject: string; html: string }>) {
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(emails),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body}`);
  return body;
}

if (testTo) {
  const f = filas[0];
  console.log(`\nMuestra (datos de ${f.completo}) → ${testTo}`);
  console.log(await send([{ from: FROM, to: [testTo], subject: `[PRUEBA] ${subject}`, html: html(f.nombre, f.importe) }]));
} else if (enviar) {
  if (sinEmail.length) { console.error(`\nAbortado: sin email → ${sinEmail.map(f => f.completo).join(', ')}`); process.exit(1); }
  const lote = filas.map(f => ({ from: FROM, to: [f.to], subject, html: html(f.nombre, f.importe) }));
  console.log(`\nEnviando ${lote.length} correos…`);
  console.log(await send(lote));
} else {
  console.log('\nEnsayo: no se envió nada. Usá --test <email> o --enviar.');
}
