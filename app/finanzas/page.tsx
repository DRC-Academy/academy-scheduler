'use client';
// /finanzas — liquidación mensual a los profesores.
//
// Rediseño de septiembre de 2026 (lienzo aprobado por Facundo). La pantalla
// responde, en este orden, lo que el director mira una vez al mes:
//   · Clases del mes: pagables frente a dadas, en UNA barra (verde lo pagable,
//     amarillo lo que espera transcript). La diferencia es el mismo número que
//     aparece en "Retenido hasta el transcript".
//   · Retenido hasta el transcript: el dinero de clases dadas que todavía no se
//     paga, con la definición escrita en la tarjeta, sin tooltip.
//   · Total a pagar como suma: clases · bonos de retención · upsells (y las
//     penalizaciones si las hay), barra apilada y total bajo una raya.
//   · Estado del pago: "Por pagar" y "Pagado" lado a lado. Al marcar a alguien,
//     el importe salta de una cifra a la otra; durante 8 s cada una muestra el
//     movimiento y el toast ofrece Deshacer.
//   · La lista: una fila por profesor (clases pagables, retenido, extras, a
//     pagar, estado). En el teléfono cada fila lleva un círculo de 44 px que es
//     el botón de pagado. El nombre abre el DESGLOSE del profesor: cómo se
//     llega al importe, qué no entra (todavía), el embudo del mes y los alumnos
//     con su lista de clases.
//
// Un solo DOM para los dos tamaños (clases `fz-*`): la fila se vuelve tarjeta
// por debajo de 768 px solo con CSS.
import { useState, useEffect, useMemo, useRef } from 'react';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import { PullToRefresh } from '@/components/PullToRefresh';
import { LastUpdated } from '@/components/LastUpdated';
import { getSpainParts } from '@/components/VisualCalendar';
import { useAuth } from '@/lib/AuthContext';
import { useTeachers } from '@/lib/TeachersContext';
import { calculateTeacherFinance, estimateClassAmount, TeacherFinanceResult, ClassFinanceRow, classTypeBadge, durationSourceBadge, subscriptionBadge, rowHoursLabel, financeStatusBadge, transcriptStateBadge, lostClassBreakdownLabel, isStudentAbsence, recoveryCreditLabel, studentQuotaOf } from '@/lib/finance';
import { isActiveWooStatus } from '@/lib/subscriptionAccess';
import { gridOccupancyOfTeacher } from '@/lib/teacherClasses';
import { dbRevertPenalty, dbGetAllTeacherAssignments } from '@/lib/db';
import { buildClassFunnel, type ClassFunnel, type FunnelBranch } from '@/lib/classFunnel';
import { dbGetReviewRequests } from '@/lib/reviewRequests';
import { dbGetStudentDropouts, type StudentDropout } from '@/lib/studentPeriod';
import ReviewRequestsTab from '@/components/admin/ReviewRequestsTab';
import OutOfScheduleTab from '@/components/admin/OutOfScheduleTab';
import { Assignment, ScoringEvent, FinanceManualApproval, Teacher, ClassReviewRequest } from '@/types';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Download, Lock, Undo2 } from 'lucide-react';

// ─── Finance helpers ──────────────────────────────────────────────────────────
const FIN_MONTHS_ADMIN = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function finMonthLabel(monthYear: string): string {
  const [y, m] = monthYear.split('-').map(Number);
  return `${FIN_MONTHS_ADMIN[(m ?? 1) - 1]} ${y}`;
}
function finDateShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2, '0')} ${FIN_MONTHS_ADMIN[d.getMonth()].slice(0, 3)}`;
}
/** Mes anterior o siguiente en formato YYYY-MM. */
function shiftMonth(monthYear: string, delta: number): string {
  const [y, m] = monthYear.split('-').map(Number);
  const d = new Date(y, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** "1.812,50 €": punto de miles siempre (es-ES no lo pone por debajo de 10.000). */
function eur(n: number): string {
  const neg = n < 0;
  const [e, d] = Math.abs(n).toFixed(2).split('.');
  return `${neg ? '− ' : ''}${e.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d} €`;
}
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * Quién aprobó a mano esa clase y cuándo. Pagar una clase sin transcript es la
 * única forma de saltarse el nivel 2, así que la fila tiene que poder responder
 * quién lo decidió sin ir a buscarlo a la base.
 */
const nkStudent = (s: string) => (s ?? '').trim().toLowerCase();
function findApproval(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string) {
  return approvals.find(a =>
    a.teacherId === teacherId && nkStudent(a.studentName) === nkStudent(studentName) && a.classDate === date);
}
function approvalBy(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string): string {
  const a = findApproval(approvals, teacherId, studentName, date);
  return a?.approvedBy ? ` · ${a.approvedBy}` : '';
}
function approvalTrace(approvals: FinanceManualApproval[], teacherId: string, studentName: string, date: string): string {
  const a = findApproval(approvals, teacherId, studentName, date);
  if (!a) return 'Aprobada manualmente por el equipo';
  const cuando = (a.approvedAt ?? '').replace('T', ' ').slice(0, 16);
  const motivo = a.reason === 'excede_limite_aprobado' ? 'incluida pese a exceder el límite' : 'pagada sin transcript';
  return `${motivo} — ${a.approvedBy || 'sin registrar'}${cuando ? ` el ${cuando}` : ''}`;
}

/**
 * Las etiquetas de lib/finance vienen con emoji (fuente compartida con otras
 * pantallas). Acá se muestran sin él, igual que en la vista del profesor: se
 * recorta el prefijo no alfanumérico, sin tocar la fuente.
 */
function plainPill(label: string): string {
  return label.replace(/^[^\p{L}\p{N}€]+/u, '').trim();
}

/**
 * El plan contratado de una fila, partido en producto y variante.
 *
 * `row.plan` es la cadena de WooCommerce entera: el nombre del producto, ` — `, y
 * los atributos de la variación. Devuelve null cuando el plan no dice más que la
 * categoría de tarifa que ya está en la línea de arriba.
 */
function planContratado(row: ClassFinanceRow | undefined): { producto: string; variante: string } | null {
  const plan = (row?.plan ?? '').trim();
  if (!plan || plan === (row?.planLabel ?? '').trim()) return null;
  const i = plan.indexOf(' — ');
  return i < 0
    ? { producto: plan, variante: '' }
    : { producto: plan.slice(0, i).trim(), variante: plan.slice(i + 3).trim() };
}

/**
 * Lo que necesita el embudo de CUALQUIER profesor, cargado una sola vez y en
 * paralelo, la primera vez que se abre un desglose. Quien entra a Finanzas y no
 * abre a nadie no paga nada de esto.
 */
function useFunnelData(enabled: boolean) {
  const { teachers, students, assignments } = useTeachers();
  const [data, setData] = useState<{
    grids: Map<string, Assignment[]>;
    dropouts: StudentDropout[];
    requests: ClassReviewRequest[];
  } | null>(null);
  const pedido = useRef(false);

  useEffect(() => {
    if (!enabled || pedido.current) return;
    pedido.current = true;
    let cancelled = false;
    Promise.all([
      dbGetAllTeacherAssignments({ teachers, students, assignments }),
      dbGetStudentDropouts(),
      dbGetReviewRequests(),
    ])
      .then(([grids, dropouts, requests]) => { if (!cancelled) setData({ grids, dropouts, requests }); })
      .catch(err => {
        console.error('[finanzas] No se pudieron cargar los datos del embudo:', err);
        pedido.current = false;   // que un fallo de red no lo deje muerto
      });
    return () => { cancelled = true; };
  // Se pide UNA vez: `pedido` corta las repeticiones y los datos del contexto no
  // cambian mientras el admin tiene un profesor abierto.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return data;
}

/** Acceso a la ACADEMIA con el que se dio esa clase, para pintarla o no. */
type AccesoClase =
  | { kind: 'ok' }
  | { kind: 'sin'; label: string; title: string }
  | { kind: 'dudoso'; label: string };

/** Estados que dan acceso sin ser una suscripción viva de WooCommerce. */
const ACCESO_PROPIO = new Set(['oritalk', 'manual_override', 'manual_active']);

/**
 * ¿Con qué acceso se dio esta clase? Tres respuestas (el mapa completo está en
 * lib/subscriptionAccess): `ok` (podía tomar clase), `sin` (WooCommerce respondió
 * que NO había acceso: esto va en rojo) y `dudoso` (nunca hubo respuesta: no se
 * afirma nada).
 */
function accesoDeLaClase(r: ClassFinanceRow): AccesoClase {
  const s = r.subscriptionStatus;
  if (!s || s === 'error') return s === 'error' ? { kind: 'dudoso', label: 'sin verificar' } : { kind: 'ok' };
  if (isActiveWooStatus(s) || ACCESO_PROPIO.has(s)) return { kind: 'ok' };
  if (s === 'scheduled') return { kind: 'ok' };   // pagada, empieza más adelante
  const nombre = plainPill(subscriptionBadge(s).label);
  return {
    kind: 'sin',
    label: s === 'one_time_no_access' ? 'pago único sin activar' : `suscripción ${nombre.toLowerCase()}`,
    title: `Se dio esta clase sin acceso: WooCommerce daba «${nombre}» ese día.`,
  };
}

// ─── Extras del mes (bonos y upsells) ─────────────────────────────────────────
/** Los euros positivos del scoring del mes, partidos por concepto. */
interface Extras { bonos: number; nBonos: number; upsells: number; nUpsells: number; otros: number; detBonos: string[] }

function extrasDe(scoringEvents: ScoringEvent[], teacherId: string, monthYear: string): Extras {
  const del = scoringEvents.filter(e =>
    e.teacherId === teacherId && (e.createdAt ?? '').slice(0, 7) === monthYear && !e.reverted &&
    e.eventType !== 'penalizacion_revertida' && (e.euros ?? 0) > 0);
  const bonos = del.filter(e => e.eventType === 'bonus_retencion');
  const ups = del.filter(e => e.eventType === 'upsell');
  const otros = del.filter(e => e.eventType !== 'bonus_retencion' && e.eventType !== 'upsell');
  return {
    bonos: bonos.reduce((s, e) => s + (e.euros ?? 0), 0), nBonos: bonos.length,
    upsells: ups.reduce((s, e) => s + (e.euros ?? 0), 0), nUpsells: ups.length,
    otros: otros.reduce((s, e) => s + (e.euros ?? 0), 0),
    detBonos: bonos.map(e => e.studentRef).filter((x): x is string => !!x),
  };
}

/** "Hace un momento": la fila y las cifras muestran el movimiento durante estos ms. */
const VENTANA_DESHACER_MS = 8000;

interface Reciente { teacherId: string; nombre: string; importe: number; deshecho?: boolean }

// ─── Cifras del mes ───────────────────────────────────────────────────────────
interface Cifras {
  pag: number; pendTx: number; fueraCupo: number; dadas: number;
  retEur: number; clases: number; bonos: number; upsells: number; otros: number; pen: number; total: number;
  porPagar: number; pagado: number; nPag: number; nTot: number;
}

function cifrasDe(rs: TeacherFinanceResult[], extras: (id: string) => Extras): Cifras {
  const c: Cifras = { pag: 0, pendTx: 0, fueraCupo: 0, dadas: 0, retEur: 0, clases: 0, bonos: 0, upsells: 0, otros: 0, pen: 0, total: 0, porPagar: 0, pagado: 0, nPag: 0, nTot: rs.length };
  for (const r of rs) {
    const x = extras(r.teacherId);
    c.pag += r.totalPagable; c.pendTx += r.totalARevisar; c.fueraCupo += r.totalExcedeLimite + r.totalExcedeLimiteTipo;
    c.retEur += r.montoARevisar; c.clases += r.montoPagable;
    c.bonos += x.bonos; c.upsells += x.upsells; c.otros += x.otros; c.pen += r.penaltiesFromScoring;
    c.total += r.totalAPagar;
    if (r.paymentStatus === 'paid') { c.pagado += r.totalAPagar; c.nPag++; } else c.porPagar += r.totalAPagar;
  }
  c.dadas = c.pag + c.pendTx + c.fueraCupo;
  return c;
}

function CabeceraMes({ c, reciente, cerrado, mesLabel }: { c: Cifras; reciente: Reciente | null; cerrado: boolean; mesLabel: string }) {
  const inicio = c.nPag === 0 && c.pag < c.dadas * 0.5;
  const sumaConceptos = c.clases + c.bonos + c.upsells + c.otros;
  const fila = (label: string, v: number, color: string, extra?: string) => (
    <div className="fz-dr">
      <span className="n"><i className="fz-dot" style={{ background: color }} />{label}</span>
      <span className="v" style={{ color: v === 0 ? '#a4a7a1' : undefined }}>{eur(v)}</span>
      <span className="pct">{extra ?? `${pct(v, sumaConceptos)} %`}</span>
    </div>
  );
  return (
    <div className="fz-kpis">
      {/* 1 · Clases del mes */}
      <div className="adm-card fz-kpi fz-k-clases">
        <div className="fz-kpi-l">Clases del mes</div>
        <div className="fz-kpi-v">{c.pag} <small>pagables de {c.dadas} dadas</small></div>
        <div className="fz-bar">
          <span style={{ width: `${pct(c.pag, c.dadas)}%`, background: '#1E9E3A' }} />
          <span style={{ width: `${pct(c.pendTx, c.dadas)}%`, background: '#FFC400' }} />
          {c.fueraCupo > 0 && <span style={{ width: `${pct(c.fueraCupo, c.dadas)}%`, background: '#C8C8C0' }} />}
        </div>
        <div className="fz-leg">
          <span><i className="fz-dot" style={{ background: '#1E9E3A' }} />{c.pag} con ingreso y transcript</span>
          <span><i className="fz-dot" style={{ background: '#FFC400' }} />{c.pendTx} a la espera del transcript</span>
          {c.fueraCupo > 0 && <span><i className="fz-dot" style={{ background: '#C8C8C0' }} />{c.fueraCupo} fuera del cupo</span>}
        </div>
      </div>

      {/* 4 · Retenido hasta el transcript */}
      <div className="adm-card fz-kpi fz-k-ret">
        <div className="fz-kpi-l">Retenido hasta el transcript</div>
        <div className="fz-kpi-v" style={{ color: cerrado ? '#6E6E66' : '#B45309' }}>{eur(c.retEur)} <small>{c.pendTx} clase{c.pendTx === 1 ? '' : 's'}</small></div>
        <div className="fz-kpi-def">
          {cerrado
            ? 'Clases dadas que se cerraron sin transcript: no entraron en esta liquidación. Se pagan en el mes en que el profesor lo suba.'
            : 'Clases ya dadas que aún no se pagan porque el profesor no ha subido el transcript. En cuanto lo sube, pasan solas a pagables.'}
        </div>
      </div>

      {/* 2 · Total a pagar, como suma */}
      <div className="adm-card fz-kpi fz-k-total">
        <div className="fz-kpi-l">Total a pagar</div>
        <div className="fz-bar" style={{ height: 10 }}>
          {sumaConceptos > 0 && (
            <>
              <span style={{ width: `${pct(c.clases, sumaConceptos)}%`, background: '#1E9E3A' }} />
              <span style={{ width: `${pct(c.bonos, sumaConceptos)}%`, background: '#2563eb' }} />
              <span style={{ width: `${pct(c.upsells, sumaConceptos)}%`, background: '#FFC400' }} />
              {c.otros > 0 && <span style={{ width: `${pct(c.otros, sumaConceptos)}%`, background: '#8b8e88' }} />}
            </>
          )}
        </div>
        <div className="fz-desg">
          {fila('Clases', c.clases, '#1E9E3A')}
          {fila('Bonos de retención (6 meses)', c.bonos, '#2563eb')}
          {fila('Upsells', c.upsells, '#FFC400')}
          {c.otros > 0 && fila('Otros bonos', c.otros, '#8b8e88')}
          {c.pen < 0 && (
            <div className="fz-dr"><span className="n"><i className="fz-dot" style={{ background: '#B45309' }} />Penalizaciones</span><span className="v" style={{ color: '#B45309' }}>{eur(c.pen)}</span><span className="pct" /></div>
          )}
          <div className="fz-dr total"><span className="n">Total</span><span className="v">{eur(c.total)}</span><span className="pct" /></div>
        </div>
      </div>

      {/* 3 · Estado del pago */}
      <div className="adm-card fz-kpi fz-k-estado">
        <div className="fz-kpi-l" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          Estado del pago
          {cerrado && <span className="fz-cerrado"><Lock size={13} aria-hidden /> Mes liquidado</span>}
        </div>
        <div className="fz-dos">
          <div>
            <div className="fz-kpi-s">Por pagar</div>
            <div className="fz-kpi-v" style={{ color: cerrado ? '#6E6E66' : undefined }}>{eur(c.porPagar)}</div>
            {reciente && !reciente.deshecho && <span className="fz-delta menos">− {eur(reciente.importe)}</span>}
            {reciente && reciente.deshecho && <span className="fz-delta mas">+ {eur(reciente.importe)}</span>}
          </div>
          <div>
            <div className="fz-kpi-s">Pagado</div>
            <div className="fz-kpi-v" style={{ color: '#167A2D' }}>{eur(c.pagado)}</div>
            {reciente && !reciente.deshecho && <span className="fz-delta mas">+ {eur(reciente.importe)}</span>}
            {reciente && reciente.deshecho && <span className="fz-delta menos">− {eur(reciente.importe)}</span>}
          </div>
        </div>
        <div className="fz-bar"><span style={{ width: `${pct(c.pagado, c.total)}%`, background: '#1E9E3A' }} /></div>
        <div className="fz-kpi-s">
          {cerrado
            ? `${c.nTot} de ${c.nTot} profesores pagados`
            : inicio
              ? `Nadie cobrado todavía. ${mesLabel} sigue abierto: las cifras crecen a medida que suben transcripts.`
              : `${c.nPag} de ${c.nTot} profesores pagados`}
        </div>
      </div>
    </div>
  );
}

// ─── Una fila (escritorio) / una tarjeta (teléfono) ───────────────────────────
function FilaProfesor({ r, extras, reciente, ocupado, onAbrir, onPagar, onDeshacer }: {
  r: TeacherFinanceResult; extras: Extras; reciente: boolean; ocupado: boolean;
  onAbrir: () => void; onPagar: () => void; onDeshacer: () => void;
}) {
  const pagado = r.paymentStatus === 'paid';
  const ret = r.montoARevisar;
  const partes: string[] = [];
  if (extras.bonos > 0) partes.push(`+${Math.round(extras.bonos)} € bono`);
  if (extras.upsells > 0) partes.push(`+${Math.round(extras.upsells)} € upsell`);
  if (extras.otros > 0) partes.push(`+${Math.round(extras.otros)} € otros`);
  if (r.penaltiesFromScoring < 0) partes.push(`−${Math.abs(r.penaltiesFromScoring).toFixed(0)} € penaliz.`);
  const extrasMovil = extras.bonos + extras.upsells + extras.otros;
  return (
    <div className={`fz-row${pagado ? (reciente ? ' reciente' : ' pagado') : ''}`}>
      <button type="button" className="fz-nom" onClick={onAbrir} title="Ver el desglose">
        {r.teacherName}
        {r.hasInactiveSubPayable && (
          <span className="fz-warn" title={`Clases pagables sin suscripción con acceso: ${r.payableSubStatuses.filter(s => !s.countsAsActive).map(s => `${s.count} en «${s.label}»`).join(', ')}`}>!</span>
        )}
      </button>
      <span className="fz-cl"><b>{r.totalPagable}</b> de {r.totalPagable + r.totalARevisar + r.totalExcedeLimite + r.totalExcedeLimiteTipo}</span>
      <span className={`fz-ret${ret > 0 ? '' : ' cero'}`}>{ret > 0 ? eur(ret) : '—'}</span>
      <span className={`fz-ex${partes.length ? '' : ' cero'}`}>{partes.length ? partes.join(' · ') : '—'}</span>
      {/* En el teléfono, la línea de abajo de la tarjeta. */}
      <span className="fz-meta">{r.totalPagable} de {r.totalPagable + r.totalARevisar + r.totalExcedeLimite + r.totalExcedeLimiteTipo} clase{r.totalPagable + r.totalARevisar + r.totalExcedeLimite + r.totalExcedeLimiteTipo === 1 ? '' : 's'}{ret > 0 && <> · <b>{eur(ret)} retenido</b></>}{extrasMovil > 0 && <> · +{Math.round(extrasMovil)} € extras</>}</span>
      <span className="fz-imp">{eur(r.totalAPagar)}{pagado && <span className="fz-imp-est">{reciente ? 'Pagado ahora' : `Pagado ${r.paidAt ? finDateShort(r.paidAt.slice(0, 10)) : ''}`}</span>}</span>
      <span className="fz-est">
        {!pagado ? (
          <>
            <button type="button" className="fz-link gris" onClick={onAbrir}>Detalle</button>
            <button type="button" className="adm-btn fz-btn-ok" disabled={ocupado} onClick={onPagar}><Check size={14} strokeWidth={3} aria-hidden /> Marcar pagado</button>
          </>
        ) : (
          <>
            <span className="fz-pill ok"><Check size={12} strokeWidth={3} aria-hidden /> {reciente ? 'Pagado hace un momento' : `Pagado ${r.paidAt ? finDateShort(r.paidAt.slice(0, 10)) : ''}`}</span>
            <button type="button" className={`fz-link${reciente ? '' : ' gris'}`} disabled={ocupado} onClick={onDeshacer}>{reciente && <Undo2 size={13} aria-hidden />} Deshacer</button>
          </>
        )}
      </span>
      {/* Teléfono: el círculo de 44 px bajo el pulgar. */}
      <button type="button" className={`fz-chk${pagado ? ' on' : ''}`} disabled={ocupado} onClick={pagado ? onDeshacer : onPagar}
        aria-label={pagado ? `Deshacer el pago de ${r.teacherName}` : `Marcar a ${r.teacherName} como pagado`}>
        {pagado && <Check size={20} strokeWidth={3} aria-hidden />}
      </button>
    </div>
  );
}

// ─── Desglose del profesor ────────────────────────────────────────────────────
function EmbudoCompacto({ funnel, claimAmount }: { funnel: ClassFunnel; claimAmount: number }) {
  const COLOR: Record<string, string> = { con_ingreso: '#1E9E3A', sin_ingreso: '#FFC400', fuera_calendario: '#2563eb' };
  const suma = funnel.branches.map(b => b.count).join(' + ');
  const hijo = (b: FunnelBranch, h: FunnelBranch) => (
    <div className="fz-emb-r" key={h.key} title={h.hint}>
      <span>{h.label.replace(' tu ', ' su ')}{h.key === 'reclamables' && claimAmount > 0 && <span style={{ color: '#6E6E66' }}> · ≈ {eur(claimAmount)}</span>}</span>
      <span>{h.amount != null && h.count > 0 && <span className="fz-emb-eur">{eur(h.amount)}</span>}<span className={`c${h.count === 0 ? ' cero' : ''}`}>{h.count}</span></span>
    </div>
  );
  return (
    <div className="adm-card fz-kpi">
      <p className="fz-sec-t" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>Clases del mes <span style={{ fontSize: 20, fontWeight: 600, color: '#1A1A1A' }}>{funnel.total}</span></p>
      <div className="fz-bar">
        {funnel.branches.filter(b => b.count > 0).map(b => <span key={b.key} style={{ flexGrow: b.count, background: COLOR[b.key] ?? '#8b8e88' }} />)}
      </div>
      <div className="fz-emb">
        {funnel.branches.map(b => (
          <div className="fz-emb-g" key={b.key}>
            <div className="fz-emb-h" title={b.hint}><span className="n"><i className="fz-dot" style={{ background: COLOR[b.key] ?? '#8b8e88' }} />{b.label.replace(' tu ', ' su ')}</span><span>{b.count}</span></div>
            {(b.children ?? []).map(h => hijo(b, h))}
          </div>
        ))}
      </div>
      <div className="fz-emb-ok">✓ {suma} = {funnel.total} · cada clase está en un solo lugar</div>
    </div>
  );
}

function FilaClase({ r, result, approvals, onApproveReview, onApproveExceed, onRevertAbsence }: {
  r: ClassFinanceRow; result: TeacherFinanceResult; approvals: FinanceManualApproval[];
  onApproveReview: (date: string) => void; onApproveExceed: (date: string) => void; onRevertAbsence: (row: ClassFinanceRow) => void;
}) {
  const st = financeStatusBadge(r.status);
  const ct = classTypeBadge(r.classType);
  const dur = durationSourceBadge(r);
  const isFalta = r.classType === 'falta_sin_aviso' || r.classType === 'cancelacion_hora';
  const editable = result.paymentStatus !== 'paid' && !r.manuallyApproved;
  // Detalle del transcript SOLO cuando cambia lo que hay que hacer.
  const txNote = !isFalta && (r.transcriptState === 'review' || r.transcriptState === 'rejected') ? transcriptStateBadge(r.transcriptState).label : null;
  const acc = accesoDeLaClase(r);
  const tipo = [ct && plainPill(ct.label), txNote, dur?.label].filter(Boolean).join(' · ');
  const notas = [
    r.manuallyApproved ? `Aprobada por el equipo${approvalBy(approvals, result.teacherId, r.studentName, r.date)}` : null,
    lostClassBreakdownLabel(r), recoveryCreditLabel(r),
  ].filter((x): x is string => !!x);
  return (
    <div className={`fz-cls${acc.kind === 'sin' ? ' rojo' : ''}`} title={acc.kind === 'sin' ? acc.title : undefined}>
      <span className="f">{finDateShort(r.date)}</span>
      <span className="h">{r.hour ? rowHoursLabel(r) : ''}</span>
      <span className="st" style={{ color: st.color === '#1E9E3A' ? '#167A2D' : st.color }}><i className="fz-dot" style={{ background: st.dot }} />{st.label}</span>
      <span className="tipo" title={dur?.title}>
        {tipo || (acc.kind === 'ok' ? <span style={{ color: '#a4a7a1' }}>—</span> : null)}
        {acc.kind !== 'ok' && <span className={acc.kind === 'sin' ? 'sin' : 'dudoso'}>{tipo ? ' · ' : ''}{acc.label}</span>}
      </span>
      <span className="e">{eur(r.rate * r.billingUnits)}</span>
      <span className="act">
        {isStudentAbsence(r.classType) && r.recordId && result.paymentStatus !== 'paid' && (
          <button type="button" className="adm-btn adm-btn-ghost fz-btn-sm" onClick={() => onRevertAbsence(r)}>Revertir falta</button>
        )}
        {editable && r.status === 'a_revisar' && (
          <button type="button" className="adm-btn adm-btn-ghost fz-btn-sm" onClick={() => onApproveReview(r.date)}>Pagar sin transcript</button>
        )}
        {editable && (r.status === 'excede_limite' || r.status === 'excede_limite_tipo') && (
          <button type="button" className="adm-btn adm-btn-ghost fz-btn-sm" onClick={() => onApproveExceed(r.date)}>Incluir igual</button>
        )}
      </span>
      {notas.length > 0 && (
        <span className="nota" title={r.manuallyApproved ? approvalTrace(approvals, result.teacherId, r.studentName, r.date) : undefined}>{notas.join(' · ')}</span>
      )}
    </div>
  );
}

function AlumnoFila({ result, name, rows, assignments, approvals, abierto, onToggle, onApproveReview, onApproveExceed, onRevertAbsence }: {
  result: TeacherFinanceResult; name: string; rows: ClassFinanceRow[]; assignments: Assignment[]; approvals: FinanceManualApproval[];
  abierto: boolean; onToggle: () => void;
  onApproveReview: (studentName: string, date: string) => void; onApproveExceed: (studentName: string, date: string) => void; onRevertAbsence: (row: ClassFinanceRow) => void;
}) {
  // Emparejamiento TOLERANTE, como en el resto del código.
  const asgn = assignments.find(a => a.teacherId === result.teacherId && nkStudent(a.studentName) === nkStudent(name));
  const units = (rs: ClassFinanceRow[]) => rs.reduce((s, r) => s + r.billingUnits, 0);
  const euros = (rs: ClassFinanceRow[]) => rs.reduce((s, r) => s + r.rate * r.billingUnits, 0);
  const pagables = rows.filter(r => r.status === 'pagable');
  const revisar  = rows.filter(r => r.status === 'a_revisar');
  const excede   = rows.filter(r => r.status === 'excede_limite');
  const excTipo  = rows.filter(r => r.status === 'excede_limite_tipo');
  const quota = studentQuotaOf(result, name);
  const lleno = quota?.limit != null && quota.used >= quota.limit;
  const ultimaSub = [...rows].reverse().find(r => r.subscriptionStatus);
  const subOk = isActiveWooStatus(ultimaSub?.subscriptionStatus);
  const plan = planContratado(rows[0]);
  const problemas: Array<{ n: number; amount: number; txt: string; det: string }> = [];
  if (revisar.length > 0) problemas.push({ n: units(revisar), amount: euros(revisar), txt: 'sin transcript', det: 'Las dio y todavía no subió el texto. Pasan a pagables solas en cuanto lo suba, o se pagan a mano desde la fila.' });
  if (excede.length > 0) problemas.push({ n: units(excede), amount: euros(excede), txt: 'fuera del cupo del mes', det: `Superan las ${quota?.limit ?? '—'} que incluye su plan. Cada una se puede incluir igual desde la fila.` });
  if (excTipo.length > 0) problemas.push({ n: units(excTipo), amount: euros(excTipo), txt: 'faltas o cancelaciones de más', det: 'Superan las 2 cobrables de ese tipo en el mes. Cada una se puede incluir igual desde la fila.' });

  return (
    <div className={`fz-al${abierto ? ' open' : ''}`}>
      <button type="button" className="fz-al-h" onClick={onToggle} aria-expanded={abierto}>
        <span className="fz-caret">{abierto ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</span>
        <span className="nom">{name}{rows[0]?.planLabel && rows[0].planLabel !== 'Inglés general' && <span className="fz-pill gris">{rows[0].planLabel}</span>}{!asgn && <span className="fz-pill gris" title="Ya no tiene plan con este profesor, pero sus clases del mes siguen contando para el pago">ex-alumno</span>}</span>
        <span className="flags">
          {problemas.length === 0
            ? <span className="fz-pill ok">Al día</span>
            : <>
                {revisar.length > 0 && <span className="fz-pill pend">{units(revisar)} sin transcript</span>}
                {(excede.length > 0 || excTipo.length > 0) && <span className="fz-pill pend">{units(excede) + units(excTipo)} fuera del cupo</span>}
              </>}
        </span>
        <span className="cl">{units(pagables)} {units(pagables) === 1 ? 'clase' : 'clases'}</span>
        <span className="eur">{eur(euros(pagables))}</span>
      </button>
      {abierto && (
        <div className="fz-al-b">
          <div className="fz-ctx">
            <span><b>{rows[0]?.planLabel ?? '—'}</b> · {asgn?.startDate ? `desde el ${finDateShort(asgn.startDate)}` : 'sin asignación activa'}</span>
            {plan && <span>Plan contratado: <b>{plan.producto}</b>{plan.variante ? ` · ${plan.variante}` : ''}</span>}
            {ultimaSub && (
              <span className="fz-ctx-sub" title="Estado de WooCommerce registrado en su última clase. No es una comprobación de hoy.">
                Suscripción: <b style={{ color: subOk ? '#167A2D' : '#C81E1E' }}>{plainPill(subscriptionBadge(ultimaSub.subscriptionStatus).label)}</b> · visto el {finDateShort(ultimaSub.date)}
              </span>
            )}
          </div>
          <div className="fz-cupo">
            <span>Cupo del mes</span>
            {quota?.limit == null ? <span style={{ color: '#6E6E66' }}>Sin cupo: ya no tiene plan con este profesor</span> : (
              <>
                <span className="fz-bar" style={{ flex: 1, maxWidth: 220, height: 6 }}><span style={{ width: `${Math.min(100, pct(quota.used, quota.limit))}%`, background: lleno ? '#B45309' : '#1E9E3A' }} /></span>
                <span><b style={{ color: lleno ? '#B45309' : undefined }}>{quota.used} de {quota.limit}</b></span>
              </>
            )}
          </div>
          {problemas.map((p, k) => (
            <div className="fz-aviso" key={k}>
              <span className="n">{p.n}</span>
              <span><span className="t">{p.n === 1 ? 'clase' : 'clases'} {p.txt} · {eur(p.amount)} sin pagar</span><span className="d">{p.det}</span></span>
            </div>
          ))}
          <div className="fz-tabla">
            <div className="fz-cls head" aria-hidden><span>Fecha</span><span>Hora</span><span>Estado</span><span>Tipo y notas</span><span style={{ textAlign: 'right' }}>Importe</span><span /></div>
            {rows.map((r, i) => (
              <FilaClase key={i} r={r} result={result} approvals={approvals}
                onApproveReview={date => onApproveReview(name, date)} onApproveExceed={date => onApproveExceed(name, date)} onRevertAbsence={onRevertAbsence} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DetalleProfesor({ r, teacher, extras, penalties, funnelData, monthYear, assignments, approvals, reciente, ocupado, onVolver, onPagar, onDeshacer, onRevertPenalty, onApproveReview, onApproveExceed, onRevertAbsence }: {
  r: TeacherFinanceResult; teacher: Teacher | undefined; extras: Extras; penalties: ScoringEvent[];
  funnelData: ReturnType<typeof useFunnelData>; monthYear: string; assignments: Assignment[]; approvals: FinanceManualApproval[];
  reciente: boolean; ocupado: boolean;
  onVolver: () => void; onPagar: () => void; onDeshacer: () => void; onRevertPenalty: (p: ScoringEvent) => void;
  onApproveReview: (studentName: string, date: string) => void; onApproveExceed: (studentName: string, date: string) => void; onRevertAbsence: (row: ClassFinanceRow) => void;
}) {
  const { classJoinLogs, classRecords, classAnalyses, students, financeRates } = useTeachers();
  const [filtro, setFiltro] = useState<'todos' | 'pendiente'>('todos');
  const [abierto, setAbierto] = useState<string | null>(null);
  const pagado = r.paymentStatus === 'paid';

  // Agrupar filas por alumno.
  const porAlumno = useMemo(() => {
    const m = new Map<string, ClassFinanceRow[]>();
    for (const row of r.rows) { if (!m.has(row.studentName)) m.set(row.studentName, []); m.get(row.studentName)!.push(row); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [r.rows]);
  const conPendiente = (rows: ClassFinanceRow[]) => rows.some(x => x.status === 'a_revisar' || x.status === 'excede_limite' || x.status === 'excede_limite_tipo');
  const alumnos = porAlumno.filter(([, rows]) => filtro === 'todos' || conPendiente(rows));
  const nPend = porAlumno.filter(([, rows]) => conPendiente(rows)).length;

  // Tarifas usadas en las pagables, para la línea de "Clases pagables".
  const tarifas = [...new Set(r.rows.filter(x => x.status === 'pagable').map(x => x.rate))].sort((a, b) => a - b);
  const euros = (rs: ClassFinanceRow[]) => rs.reduce((s, x) => s + x.rate * x.billingUnits, 0);
  const excede = r.rows.filter(x => x.status === 'excede_limite');
  const excTipo = r.rows.filter(x => x.status === 'excede_limite_tipo');
  const dadas = r.totalPagable + r.totalARevisar + r.totalExcedeLimite + r.totalExcedeLimiteTipo;

  // El embudo: misma función que ve el profesor en /mis-clases.
  const spain = getSpainParts(new Date());
  const asgs = useMemo(() => funnelData?.grids.get(r.teacherId) ?? [], [funnelData, r.teacherId]);
  const funnel = useMemo(() => teacher && funnelData ? buildClassFunnel({
    monthYear, teacherId: teacher.id, assignments: asgs,
    joinLogs: classJoinLogs, classRecords, analyses: classAnalyses,
    requests: funnelData.requests.filter(q => q.teacherId === teacher.id), dropouts: funnelData.dropouts,
    gridOccupancy: gridOccupancyOfTeacher(teacher), finance: r,
    todayIso: spain.dateStr, nowMinutes: spain.hour * 60 + spain.minute,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }) : null, [monthYear, teacher, funnelData, classJoinLogs, classRecords, classAnalyses, r]);
  // Cuánto vale lo que el profesor todavía puede reclamar (misma estimación que ve él).
  const claimAmount = useMemo(() => funnel ? funnel.missing.filter(c => c.signal !== null).reduce((s, c) => s + estimateClassAmount({
    assignment: asgs.find(a => nkStudent(a.studentName) === nkStudent(c.studentName)),
    student: students.find(x => nkStudent(x.name) === nkStudent(c.studentName)),
    rates: financeRates, date: c.date, durationHours: c.durationHours,
  }), 0) : 0, [funnel, asgs, students, financeRates]);

  return (
    <div className="fz-det">
      <button type="button" className="fz-back" onClick={onVolver}><ChevronLeft size={20} strokeWidth={2.25} aria-hidden /> Finanzas · {finMonthLabel(monthYear)}</button>
      <div className="fz-dh">
        <div><h2 className="fz-dh-n">{r.teacherName}</h2><p className="fz-dh-s">Desglose de {finMonthLabel(monthYear)} · {porAlumno.length} alumno{porAlumno.length === 1 ? '' : 's'} · {dadas} clase{dadas === 1 ? '' : 's'} dada{dadas === 1 ? '' : 's'}</p></div>
        <div className="fz-dh-r">
          <span className={`fz-pill ${pagado ? 'ok' : 'pend'}`} style={{ height: 28, fontSize: 13 }}>{pagado ? `Pagado ${r.paidAt ? finDateShort(r.paidAt.slice(0, 10)) : ''}` : 'Por pagar'}</span>
          <div className="fz-dh-imp">{eur(r.totalAPagar)}<small>a pagar</small></div>
          {pagado
            ? <button type="button" className="adm-btn adm-btn-ghost" disabled={ocupado} onClick={onDeshacer}><Undo2 size={14} aria-hidden /> Deshacer el pago</button>
            : <button type="button" className="adm-btn adm-btn-primary" disabled={ocupado} onClick={onPagar}><Check size={14} strokeWidth={3} aria-hidden /> Marcar pagado</button>}
        </div>
      </div>
      {reciente && <div className="fz-aviso" style={{ background: '#EAF5EC', marginBottom: 12 }}><span><span className="t">Marcado como pagado hace un momento.</span><span className="d">Si fue un error, «Deshacer el pago» lo devuelve a Por pagar.</span></span></div>}

      <div className="fz-tres">
        {/* Cómo se llega al importe */}
        <div className="adm-card fz-kpi">
          <p className="fz-sec-t">Cómo se llega al importe</p>
          <div className="fz-led">
            <div className="fz-lrow"><span>Clases pagables<span className="sub">{tarifas.length ? tarifas.map(t => eur(t)).join(' · ') : 'sin clases pagables'}</span></span><span className="q">{r.totalPagable} clase{r.totalPagable === 1 ? '' : 's'}</span><span className="v">{eur(r.montoPagable)}</span></div>
            <div className="fz-lrow"><span>Bonos de retención (6 meses){extras.detBonos.length > 0 && <span className="sub">{extras.detBonos.join(', ')}</span>}</span><span className="q">{extras.nBonos}</span><span className="v" style={{ color: extras.bonos ? undefined : '#a4a7a1' }}>{eur(extras.bonos)}</span></div>
            <div className="fz-lrow"><span>Upsells</span><span className="q">{extras.nUpsells}</span><span className="v" style={{ color: extras.upsells ? undefined : '#a4a7a1' }}>{eur(extras.upsells)}</span></div>
            {extras.otros > 0 && <div className="fz-lrow"><span>Otros bonos</span><span className="q" /><span className="v">{eur(extras.otros)}</span></div>}
            {penalties.map(p => (
              <div className="fz-lrow" key={p.id}>
                <span>Penalización · {p.note.replace(/^(Falta sin aviso registrada|Cancelación sin antelación) — /, '')}<span className="sub">{p.studentRef ? `${p.studentRef} · ` : ''}{finDateShort((p.createdAt ?? '').slice(0, 10))}{p.reverted ? ` · revertida${p.revertedBy ? ` por ${p.revertedBy}` : ''}` : ''}</span></span>
                <span className="q">{!p.reverted && r.paymentStatus !== 'paid' && <button type="button" className="fz-link gris" onClick={() => onRevertPenalty(p)}>Revertir</button>}</span>
                <span className="v neg" style={{ textDecoration: p.reverted ? 'line-through' : undefined, color: p.reverted ? '#a4a7a1' : undefined }}>{eur(p.euros)}</span>
              </div>
            ))}
            <div className="fz-lrow tot"><span>A pagar</span><span /><span className="v">{eur(r.totalAPagar)}</span></div>
          </div>
        </div>

        {/* No entra en el pago (todavía) */}
        <div className="adm-card fz-kpi fz-fuera">
          <p className="fz-sec-t">No entra en el pago (todavía)</p>
          <div className="fz-led">
            <div className="fz-lrow"><span>Retenido hasta el transcript</span><span className="q">{r.totalARevisar} clase{r.totalARevisar === 1 ? '' : 's'}</span><span className={`v${r.montoARevisar ? '' : ' cero'}`}>{eur(r.montoARevisar)}</span></div>
            <div className="fz-lrow"><span>Fuera del cupo del plan</span><span className="q">{r.totalExcedeLimite}</span><span className={`v${excede.length ? '' : ' cero'}`}>{eur(euros(excede))}</span></div>
            <div className="fz-lrow"><span>Faltas o cancelaciones de más</span><span className="q">{r.totalExcedeLimiteTipo}</span><span className={`v${excTipo.length ? '' : ' cero'}`}>{eur(euros(excTipo))}</span></div>
          </div>
          <div className="fz-nota">Las tres se pueden incluir a mano desde la lista de clases del alumno; las retenidas entran solas cuando llega el transcript.</div>
        </div>

        {/* Embudo */}
        {funnel ? <EmbudoCompacto funnel={funnel} claimAmount={claimAmount} /> : <div className="adm-card fz-kpi"><p className="fz-sec-t">Clases del mes</p><div className="fz-kpi-s">Cargando el embudo…</div></div>}
      </div>

      <div className="adm-card fz-lista" style={{ marginTop: 16 }}>
        <div className="fz-lh" style={{ justifyContent: 'space-between' }}>
          <span className="fz-sec-t" style={{ margin: 0 }}>Alumnos · {porAlumno.length}</span>
          <span className="fz-chips">
            <button type="button" className="fz-chip" aria-pressed={filtro === 'todos'} onClick={() => setFiltro('todos')}>Todos<span className="n">{porAlumno.length}</span></button>
            <button type="button" className="fz-chip" aria-pressed={filtro === 'pendiente'} onClick={() => setFiltro('pendiente')}>Con algo pendiente<span className="n">{nPend}</span></button>
          </span>
        </div>
        {alumnos.length === 0 && <div className="fz-vacio">{porAlumno.length === 0 ? 'Sin clases registradas este mes.' : 'Nadie con algo pendiente.'}</div>}
        {alumnos.map(([name, rows]) => (
          <AlumnoFila key={name} result={r} name={name} rows={rows} assignments={assignments} approvals={approvals}
            abierto={abierto === name} onToggle={() => setAbierto(abierto === name ? null : name)}
            onApproveReview={onApproveReview} onApproveExceed={onApproveExceed} onRevertAbsence={onRevertAbsence} />
        ))}
      </div>
    </div>
  );
}

// ─── La pestaña ───────────────────────────────────────────────────────────────
function FinanceTab({ onHow }: { onHow: () => void }) {
  const { user } = useAuth();
  const {
    teachers, students, assignments, classJoinLogs, classRecords, classAnalyses, financeRates, financePayments,
    scoringEvents, manualApprovals,
    loadFinanceData, markPaymentAsPaid, markPaymentAsPending, approveReviewClass, approveExceedLimitClass, revertStudentAbsence,
  } = useTeachers();
  const approvedBy = user?.displayName || user?.username || 'admin';

  const nowSpain = getSpainParts(new Date());
  const [monthYear, setMonthYear] = useState(nowSpain.dateStr.slice(0, 7));
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'pending'>('all');
  const [abierto, setAbierto] = useState<string | null>(null);
  const funnelData = useFunnelData(abierto !== null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  // El último pago marcado (o deshecho): la fila en verde, el toast y las
  // deltas de "Por pagar / Pagado" durante VENTANA_DESHACER_MS.
  const [reciente, setReciente] = useState<Reciente | null>(null);
  const [deshacerModal, setDeshacerModal] = useState<{ teacherId: string; nombre: string; importe: number } | null>(null);
  const [loteModal, setLoteModal] = useState(false);
  const [error, setError] = useState('');
  // Reversión de penalización (Bloque 4.5).
  const [revertModal, setRevertModal] = useState<ScoringEvent | null>(null);
  const [revertReason, setRevertReason] = useState('');
  const [reverting, setReverting] = useState(false);
  // Reversión de una falta sin aviso del ALUMNO (otra cosa que la penalización).
  const [absenceModal, setAbsenceModal] = useState<{ row: ClassFinanceRow; teacherName: string } | null>(null);
  const [absenceError, setAbsenceError] = useState('');
  const [revertingAbsence, setRevertingAbsence] = useState(false);

  useEffect(() => { loadFinanceData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!reciente) return;
    const t = setTimeout(() => setReciente(null), VENTANA_DESHACER_MS);
    return () => clearTimeout(t);
  }, [reciente]);
  // Al cambiar de mes se vuelve a la lista.
  const cambiarMes = (delta: number) => { setMonthYear(m => shiftMonth(m, delta)); setAbierto(null); setReciente(null); };

  async function handleRevertAbsence() {
    if (!absenceModal?.row.recordId) return;
    setRevertingAbsence(true); setAbsenceError('');
    try {
      await revertStudentAbsence(absenceModal.row.recordId, approvedBy);
      setAbsenceModal(null);
      await loadFinanceData();
    } catch (e) {
      setAbsenceError((e as Error).message || 'No se pudo revertir la falta.');
    } finally {
      setRevertingAbsence(false);
    }
  }

  async function handleRevert() {
    if (!revertModal || !revertReason.trim()) return;
    setReverting(true);
    try {
      await dbRevertPenalty({
        penaltyId: revertModal.id, teacherId: revertModal.teacherId, teacherName: revertModal.teacherName,
        originalDate: (revertModal.createdAt ?? '').slice(0, 10), studentName: revertModal.studentRef,
        reason: revertReason.trim(), adminName: approvedBy,
        amount: Math.abs(revertModal.euros ?? 5),   // devuelve lo que se descontó
      });
      setRevertModal(null); setRevertReason('');
      await loadFinanceData();
    } catch (e) {
      setError(`No se pudo revertir: ${(e as Error).message}`);
    } finally {
      setReverting(false);
    }
  }

  // Toda penalización del mes = cualquier evento con euros negativos, sea del tipo
  // que sea. Si se filtrara por un event_type concreto, una penalización de otro
  // tipo restaría del total sin salir en la lista ni poder revertirse.
  const penaltiesOf = (teacherId: string): ScoringEvent[] => scoringEvents.filter(e =>
    e.teacherId === teacherId && (e.euros ?? 0) < 0 && (e.createdAt ?? '').slice(0, 7) === monthYear);
  const extras = (teacherId: string) => extrasDe(scoringEvents, teacherId, monthYear);

  // Finanzas de cada profesor: MISMAS entradas que la vista del profesor
  // (app/mis-clases) y que la liquidación (TeachersContext.markPaymentAsPaid).
  const results = useMemo<TeacherFinanceResult[]>(() => teachers.map(t => {
    const payment = financePayments.find(p => p.teacherId === t.id && p.monthYear === monthYear) ?? null;
    return calculateTeacherFinance({
      teacherId: t.id, teacherName: t.name, monthYear,
      assignments, joinLogs: classJoinLogs, classRecords, classAnalyses, rates: financeRates,
      scoringEvents, students, manualApprovals, payment,
      gridOccupancy: gridOccupancyOfTeacher(t),
    });
  }), [teachers, students, monthYear, assignments, classJoinLogs, classRecords, classAnalyses, financeRates, scoringEvents, manualApprovals, financePayments]);

  // Solo profesores con actividad en el mes.
  const conActividad = results.filter(r => r.rows.length > 0 || r.bonusFromScoring > 0 || r.penaltiesFromScoring < 0 || r.paymentStatus === 'paid');
  const visible = conActividad.filter(r => statusFilter === 'all' || (statusFilter === 'paid' ? r.paymentStatus === 'paid' : r.paymentStatus !== 'paid'));
  const cifras = useMemo(() => cifrasDe(conActividad, extras), [conActividad]); // eslint-disable-line react-hooks/exhaustive-deps
  const cerrado = cifras.nTot > 0 && cifras.nPag === cifras.nTot;
  const pendientes = conActividad.filter(r => r.paymentStatus !== 'paid');
  const actual = abierto ? results.find(r => r.teacherId === abierto) ?? null : null;

  async function pagar(r: TeacherFinanceResult) {
    setOcupado(r.teacherId); setError('');
    try {
      await markPaymentAsPaid(r.teacherId, monthYear);
      setReciente({ teacherId: r.teacherId, nombre: r.teacherName, importe: r.totalAPagar });
    } catch (e) { setError(`No se pudo marcar el pago: ${(e as Error).message}`); }
    finally { setOcupado(null); }
  }
  async function deshacer(teacherId: string, nombre: string, importe: number) {
    setOcupado(teacherId); setError(''); setDeshacerModal(null);
    try {
      await markPaymentAsPending(teacherId, monthYear);
      setReciente({ teacherId, nombre, importe, deshecho: true });
    } catch (e) { setError(`No se pudo deshacer: ${(e as Error).message}`); }
    finally { setOcupado(null); }
  }
  // Deshacer: directo dentro de la ventana de 8 s; pasada, pide confirmación.
  function pedirDeshacer(r: TeacherFinanceResult) {
    if (reciente && reciente.teacherId === r.teacherId && !reciente.deshecho) deshacer(r.teacherId, r.teacherName, r.totalAPagar);
    else setDeshacerModal({ teacherId: r.teacherId, nombre: r.teacherName, importe: r.totalAPagar });
  }
  async function pagarLote() {
    setLoteModal(false); setOcupado('lote'); setError('');
    try {
      for (const r of pendientes) await markPaymentAsPaid(r.teacherId, monthYear);
    } catch (e) { setError(`No se pudieron marcar todos los pagos: ${(e as Error).message}`); }
    finally { setOcupado(null); }
  }

  function exportCsv() {
    // Horas/Cuenta como: una sesión de 2h es una fila que vale 2 clases.
    const lines = ['Profesor,Alumno,Fecha,Hora,Horas,Cuenta como,Tarifa,Importe,Estado,Total profesor'];
    for (const r of conActividad) {
      for (const row of r.rows) {
        lines.push([
          `"${r.teacherName}"`, `"${row.studentName}"`, row.date,
          `"${rowHoursLabel(row)}"`, row.durationHours, row.billingUnits,
          row.rate.toFixed(2), (row.rate * row.billingUnits).toFixed(2),
          row.status, r.totalAPagar.toFixed(2),
        ].join(','));
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `finanzas_${monthYear}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const mesLabel = finMonthLabel(monthYear);

  return (
    <div className="fz">
      {error && <div className="fz-error" role="alert">{error}</div>}

      {actual ? (
        <DetalleProfesor
          r={actual} teacher={teachers.find(t => t.id === actual.teacherId)} extras={extras(actual.teacherId)} penalties={penaltiesOf(actual.teacherId)}
          funnelData={funnelData} monthYear={monthYear} assignments={assignments} approvals={manualApprovals}
          reciente={!!reciente && reciente.teacherId === actual.teacherId && !reciente.deshecho} ocupado={ocupado !== null}
          onVolver={() => setAbierto(null)} onPagar={() => pagar(actual)} onDeshacer={() => pedirDeshacer(actual)}
          onRevertPenalty={p => { setRevertModal(p); setRevertReason(''); }}
          onApproveReview={(student, date) => approveReviewClass(actual.teacherId, student, date, approvedBy)}
          onApproveExceed={(student, date) => approveExceedLimitClass(actual.teacherId, student, date, approvedBy)}
          onRevertAbsence={row => { setAbsenceModal({ row, teacherName: actual.teacherName }); setAbsenceError(''); }}
        />
      ) : (
        <>
          <div className="fz-head">
            <div className="fz-head-l"><div><h1 className="fz-h1">Finanzas</h1><p className="fz-sub">Pago mensual a los profesores</p></div><SelectorMes label={mesLabel} alTope={monthYear >= nowSpain.dateStr.slice(0, 7)} onCambiar={cambiarMes} /></div>
            <div className="fz-head-r">
              <button type="button" className="adm-btn adm-btn-ghost" onClick={onHow}>¿Cómo entra y se paga una clase?</button>
              <button type="button" className="adm-btn adm-btn-ghost fz-csv" onClick={exportCsv}><Download size={15} aria-hidden /> Exportar CSV</button>
            </div>
          </div>

          <CabeceraMes c={cifras} reciente={reciente} cerrado={cerrado} mesLabel={mesLabel.charAt(0).toUpperCase() + mesLabel.slice(1)} />

          <div className="adm-card fz-lista">
            <div className="fz-lh">
              <div className="fz-chips" role="group" aria-label="Filtrar">
                {([['all', 'Todos', cifras.nTot], ['pending', 'Por pagar', cifras.nTot - cifras.nPag], ['paid', 'Pagados', cifras.nPag]] as const).map(([id, label, n]) => (
                  <button key={id} type="button" className="fz-chip" aria-pressed={statusFilter === id} onClick={() => setStatusFilter(id)}>{label}<span className="n">{n}</span></button>
                ))}
              </div>
              {pendientes.length > 1 && (
                <button type="button" className="adm-btn adm-btn-ghost fz-lote" disabled={ocupado !== null} onClick={() => setLoteModal(true)}>
                  <Check size={14} strokeWidth={3} aria-hidden /> Marcar pagados los {pendientes.length} que faltan
                </button>
              )}
            </div>
            {visible.length === 0 ? (
              <div className="fz-vacio">{conActividad.length === 0 ? `Sin clases ni pagos en ${mesLabel}.` : statusFilter === 'pending' ? 'Nadie por pagar.' : 'Nadie pagado todavía.'}</div>
            ) : (
              <>
                <div className="fz-row head" aria-hidden><span>Profesor</span><span>Clases pagables</span><span>Retenido</span><span>Bonos y upsells</span><span style={{ textAlign: 'right' }}>A pagar</span><span style={{ textAlign: 'right' }}>Estado</span></div>
                {visible.map(r => (
                  <FilaProfesor key={r.teacherId} r={r} extras={extras(r.teacherId)}
                    reciente={!!reciente && reciente.teacherId === r.teacherId && !reciente.deshecho}
                    ocupado={ocupado !== null}
                    onAbrir={() => setAbierto(r.teacherId)} onPagar={() => pagar(r)} onDeshacer={() => pedirDeshacer(r)} />
                ))}
              </>
            )}
          </div>

          {/* Solicitudes de revisión y clases fuera de horario: siguen aquí,
              debajo de la lista, como hasta ahora. */}
          <ReviewRequestsTab />
          <OutOfScheduleTab monthYear={monthYear} monthLabel={mesLabel} />
        </>
      )}

      {/* Toast: el último pago marcado (o deshecho), con Deshacer a mano. */}
      {reciente && (
        <div className="fz-toast" role="status">
          <span className="fz-toast-t">{reciente.deshecho ? <>El pago de <b>{reciente.nombre}</b> vuelve a Por pagar</> : <>Pago de <b>{reciente.nombre}</b> marcado</>} · {eur(reciente.importe)}</span>
          {!reciente.deshecho && <button type="button" className="fz-toast-u" onClick={() => deshacer(reciente.teacherId, reciente.nombre, reciente.importe)}><Undo2 size={14} aria-hidden /> Deshacer</button>}
        </div>
      )}

      {/* Confirmación de deshacer (pasados los 8 s). */}
      {deshacerModal && (
        <Modal onClose={() => setDeshacerModal(null)}>
          <div className="fz-mod-t">¿Volver a poner a {deshacerModal.nombre} como pendiente?</div>
          <p className="fz-mod-s">Sus {eur(deshacerModal.importe)} vuelven a «Por pagar». No se borra nada más.</p>
          <div className="fz-mod-b">
            <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setDeshacerModal(null)}>Cancelar</button>
            <button type="button" className="adm-btn adm-btn-primary" onClick={() => deshacer(deshacerModal.teacherId, deshacerModal.nombre, deshacerModal.importe)}><Undo2 size={14} aria-hidden /> Sí, deshacer</button>
          </div>
        </Modal>
      )}

      {/* Confirmación del pago en lote. */}
      {loteModal && (
        <Modal onClose={() => setLoteModal(false)}>
          <div className="fz-mod-t">¿Marcar como pagados a los {pendientes.length} que faltan?</div>
          <p className="fz-mod-s">{eur(pendientes.reduce((s, r) => s + r.totalAPagar, 0))} en total. Cada uno se puede deshacer después desde su fila.</p>
          <div className="fz-mod-b">
            <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setLoteModal(false)}>Cancelar</button>
            <button type="button" className="adm-btn adm-btn-primary" onClick={pagarLote}><Check size={14} strokeWidth={3} aria-hidden /> Sí, marcar los {pendientes.length}</button>
          </div>
        </Modal>
      )}

      {/* Reversión de una FALTA SIN AVISO DEL ALUMNO: QUITA una clase que se le
          estaba pagando (no confundir con la penalización de abajo). */}
      {absenceModal && (
        <Modal onClose={() => { if (!revertingAbsence) setAbsenceModal(null); }}>
          <div className="fz-mod-t">Revertir falta sin aviso</div>
          <p className="fz-mod-s">
            Se quitará la marca de falta de la clase de <b>{absenceModal.row.studentName}</b> del <b>{absenceModal.row.date}</b> ({absenceModal.teacherName}).
            La clase vuelve a <b>pendiente de transcript</b>: deja de sumar los <b>{eur(absenceModal.row.rate * absenceModal.row.billingUnits)}</b> al pago,
            libera el cupo mensual del alumno y el hueco del tope de faltas del mes. Queda el registro de que la falta existió y de quién la revirtió.
          </p>
          {absenceError && <div className="fz-error">{absenceError}</div>}
          <div className="fz-mod-b">
            <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setAbsenceModal(null)} disabled={revertingAbsence}>Cancelar</button>
            <button type="button" className="adm-btn adm-btn-primary" onClick={handleRevertAbsence} disabled={revertingAbsence}>{revertingAbsence ? 'Revirtiendo…' : 'Confirmar reversión'}</button>
          </div>
        </Modal>
      )}

      {/* Reversión de penalización (Bloque 4.5): devuelve euros al profesor. */}
      {revertModal && (
        <Modal onClose={() => { if (!reverting) setRevertModal(null); }}>
          <div className="fz-mod-t">Revertir penalización</div>
          <p className="fz-mod-s">
            Se devolverán <b>{eur(Math.abs(revertModal.euros ?? 5))}</b> al balance de <b>{revertModal.teacherName}</b> por la falta registrada
            el {(revertModal.createdAt ?? '').slice(0, 10)}{revertModal.studentRef ? ` con ${revertModal.studentRef}` : ''}.
          </p>
          <label className="fz-mod-l">Motivo de la reversión</label>
          <textarea value={revertReason} onChange={e => setRevertReason(e.target.value)} rows={3} autoFocus placeholder="Ej: el alumno confirmó que avisó por WhatsApp" className="fz-mod-ta" />
          <div className="fz-mod-b">
            <button type="button" className="adm-btn adm-btn-ghost" onClick={() => setRevertModal(null)} disabled={reverting}>Cancelar</button>
            <button type="button" className="adm-btn adm-btn-primary" onClick={handleRevert} disabled={reverting || !revertReason.trim()}>{reverting ? 'Revirtiendo…' : 'Confirmar reversión'}</button>
          </div>
        </Modal>
      )}
      <style>{ESTILOS}</style>
    </div>
  );
}

function SelectorMes({ label, alTope, onCambiar }: { label: string; alTope: boolean; onCambiar: (delta: number) => void }) {
  return (
    <div className="fz-mes">
      <button type="button" className="fz-mes-b" onClick={() => onCambiar(-1)} aria-label="Mes anterior"><ChevronLeft size={18} /></button>
      <span className="fz-mes-l">{label.charAt(0).toUpperCase() + label.slice(1)}</span>
      <button type="button" className="fz-mes-b" onClick={() => onCambiar(1)} disabled={alTope} aria-label="Mes siguiente"><ChevronRight size={18} /></button>
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fz-scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="fz-mod" role="dialog">{children}</div>
    </div>
  );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────
// Misma anatomía que el resto del admin (.adm-card, .adm-btn, tokens). Por
// debajo de 768 px la fila del profesor se vuelve tarjeta con el círculo de
// pagado a la derecha, y las cuatro cifras se apilan con "Estado del pago"
// primero; nada se desliza en horizontal.
const ESTILOS = `
.fz { font-family: var(--font-app); color: #1a1c1a; position: relative; }
.fz-error { background: #FDECEC; color: #C81E1E; border: 1px solid rgba(200,30,30,0.3); border-radius: 10px; padding: 10px 14px; font-size: 13px; margin-bottom: 12px; }
.fz-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
.fz-head-l { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.fz-head-r { display: flex; gap: 8px; flex-wrap: wrap; }
.fz-h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.015em; margin: 0; }
.fz-sub { font-size: 13px; color: var(--text-secondary); margin: 4px 0 0; }
.fz-mes { display: inline-flex; align-items: center; gap: 2px; background: #fff; border: 1px solid #E0E0DA; border-radius: 10px; padding: 4px; }
.fz-mes-b { width: 36px; height: 36px; min-height: 36px; border-radius: 7px; border: 0; background: transparent; display: grid; place-items: center; color: #4A4A4A; cursor: pointer; }
.fz-mes-b:hover:not(:disabled) { background: #f4f5f2; } .fz-mes-b:disabled { opacity: 0.35; cursor: default; }
.fz-mes-l { font-size: 15px; font-weight: 600; padding: 0 10px; white-space: nowrap; min-width: 150px; text-align: center; }
.fz-kpis { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1.1fr); gap: 12px; margin-bottom: 16px; }
.fz-kpi { padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.fz-kpi-l { font-size: 12.5px; font-weight: 600; color: #4A4A4A; }
.fz-kpi-v { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
.fz-kpi-v small { font-size: 15px; font-weight: 500; color: #6E6E66; letter-spacing: 0; }
.fz-kpi-s { font-size: 12.5px; color: #6E6E66; line-height: 1.45; }
.fz-kpi-def { font-size: 12.5px; color: #4A4A4A; line-height: 1.45; padding-top: 8px; border-top: 1px dashed #E0E0DA; }
.fz-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: #ECECE8; }
.fz-bar > span { display: block; height: 100%; }
.fz-leg { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: #4A4A4A; }
.fz-leg span { display: inline-flex; align-items: center; gap: 6px; }
.fz-dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; flex-shrink: 0; }
.fz-desg { display: flex; flex-direction: column; gap: 6px; }
.fz-dr { display: grid; grid-template-columns: minmax(0, 1fr) auto 38px; align-items: center; gap: 8px; font-size: 13px; }
.fz-dr .n { display: inline-flex; align-items: center; gap: 8px; color: #4A4A4A; min-width: 0; }
.fz-dr .pct { font-size: 11.5px; color: #6E6E66; text-align: right; white-space: nowrap; }
.fz-dr .v { font-weight: 600; white-space: nowrap; text-align: right; }
.fz-dr.total { border-top: 1px solid #E0E0DA; padding-top: 8px; margin-top: 2px; font-size: 15px; }
.fz-dr.total .n { color: #1A1A1A; font-weight: 600; } .fz-dr.total .v { font-size: 18px; }
.fz-dos { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.fz-dos .fz-kpi-v { font-size: 24px; }
.fz-delta { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 1px 7px; border-radius: 999px; margin-top: 4px; }
.fz-delta.mas { background: #EAF5EC; color: #167A2D; } .fz-delta.menos { background: #F0F0ED; color: #4A4A4A; }
.fz-cerrado { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: #167A2D; background: #EAF5EC; border-radius: 999px; padding: 4px 10px; }
.fz-lista { overflow: clip; }
.fz-lh { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #E0E0DA; flex-wrap: wrap; }
.fz-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fz-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-radius: 999px; border: 1.5px solid #E0E0DA; background: transparent; font-family: inherit; font-size: 13px; font-weight: 500; color: #4A4A4A; cursor: pointer; }
.fz-chip:hover { background: #f4f5f2; }
.fz-chip[aria-pressed="true"] { border-color: #1E9E3A; background: rgba(30,158,58,0.1); color: #1E9E3A; font-weight: 700; }
.fz-chip .n { font-size: 12px; font-weight: 700; color: #6E6E66; } .fz-chip[aria-pressed="true"] .n { color: #1E9E3A; }
.fz-lote { margin-left: auto; }
.fz-row { display: grid; grid-template-columns: minmax(0, 1fr) 120px 120px 150px 120px 250px; grid-template-areas: "nom cl ret ex imp est"; align-items: center; gap: 12px; min-height: 56px; padding: 6px 16px; border-top: 1px solid #ECECE8; font-size: 13.5px; }
.fz-row.head { min-height: 36px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; }
.fz-row.head span:nth-child(1) { grid-area: nom; } .fz-row.head span:nth-child(2) { grid-area: cl; } .fz-row.head span:nth-child(3) { grid-area: ret; } .fz-row.head span:nth-child(4) { grid-area: ex; } .fz-row.head span:nth-child(5) { grid-area: imp; } .fz-row.head span:nth-child(6) { grid-area: est; }
.fz-row.pagado { background: #FAFDF9; } .fz-row.pagado .fz-imp { color: #6E6E66; }
.fz-row.reciente { background: #EAF5EC; box-shadow: inset 3px 0 0 #1E9E3A; }
.fz-nom { grid-area: nom; display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; padding: 0; font-family: inherit; font-size: 14.5px; font-weight: 600; color: #1a1c1a; cursor: pointer; text-align: left; min-width: 0; min-height: 0; }
.fz-nom:hover { color: #167A2D; text-decoration: underline; }
.fz-warn { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 999px; background: #FFF6E0; color: #B45309; font-size: 11px; font-weight: 700; cursor: help; }
.fz-cl { grid-area: cl; color: #4A4A4A; } .fz-cl b { color: #1A1A1A; font-weight: 600; }
.fz-ret { grid-area: ret; color: #B45309; font-weight: 500; } .fz-ret.cero { color: #a4a7a1; }
.fz-ex { grid-area: ex; color: #4A4A4A; font-size: 13px; } .fz-ex.cero { color: #a4a7a1; }
.fz-meta { display: none; }
.fz-imp { grid-area: imp; font-size: 15px; font-weight: 600; text-align: right; } .fz-imp-est { display: none; }
.fz-est { grid-area: est; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.fz-chk { display: none; }
.fz-pill { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.fz-pill.ok { background: #EAF5EC; color: #167A2D; } .fz-pill.pend { background: #FFF6E0; color: #B45309; } .fz-pill.gris { background: #F0F0ED; color: #4A4A4A; height: 20px; font-size: 11.5px; margin-left: 6px; }
.fz-link { display: inline-flex; align-items: center; gap: 4px; background: none; border: 0; padding: 0; font-family: inherit; font-size: 12.5px; font-weight: 600; color: #167A2D; cursor: pointer; white-space: nowrap; min-height: 0; }
.fz-link.gris { color: #6E6E66; } .fz-link:hover { text-decoration: underline; } .fz-link:disabled { opacity: 0.5; cursor: default; }
.fz-btn-ok { border: 1px solid rgba(22,122,45,0.30); background: #EAF5EC; color: #167A2D; min-height: 32px; padding: 5px 11px; font-size: 12.5px; border-radius: 7px; }
.fz-btn-ok:hover:not(:disabled) { background: #1E9E3A; color: #fff; } .fz-btn-ok:disabled { opacity: 0.5; cursor: default; }
.fz-btn-sm { min-height: 32px; padding: 5px 11px; font-size: 12.5px; border-radius: 7px; }
.fz-vacio { padding: 40px 16px; text-align: center; color: #6E6E66; font-size: 14px; }
.fz-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 90; display: flex; align-items: center; gap: 12px; background: #1A1A1A; color: #fff; border-radius: 12px; padding: 12px 14px 12px 16px; font-size: 13.5px; box-shadow: 0 8px 24px rgba(0,0,0,0.18); max-width: calc(100vw - 32px); }
.fz-toast-t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fz-toast-u { display: inline-flex; align-items: center; gap: 4px; font-family: inherit; font-weight: 700; font-size: 13.5px; color: #7EDD98; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,0.08); border: 0; cursor: pointer; white-space: nowrap; min-height: 0; }
.fz-scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(3px); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 16px; }
.fz-mod { background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 22px; width: 100%; max-width: 460px; }
.fz-mod-t { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
.fz-mod-s { font-size: 13.5px; color: #4A4A4A; line-height: 1.55; margin: 0 0 16px; }
.fz-mod-l { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
.fz-mod-ta { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border); font-size: 13px; background: #fff; color: var(--text-primary); font-family: inherit; box-sizing: border-box; resize: vertical; margin-bottom: 14px; }
.fz-mod-b { display: flex; gap: 10px; } .fz-mod-b .adm-btn { flex: 1; }
/* Desglose */
.fz-back { display: inline-flex; align-items: center; gap: 4px; min-height: 40px; font-family: inherit; font-size: 14px; font-weight: 600; color: #167A2D; background: none; border: 0; padding: 0; cursor: pointer; }
.fz-dh { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 4px 0 16px; }
.fz-dh-n { font-size: 24px; font-weight: 700; letter-spacing: -0.015em; margin: 0; }
.fz-dh-s { font-size: 13px; color: #6E6E66; margin: 3px 0 0; }
.fz-dh-r { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.fz-dh-imp { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; text-align: right; }
.fz-dh-imp small { display: block; font-size: 12.5px; font-weight: 500; color: #6E6E66; letter-spacing: 0; margin-top: 2px; }
.fz-tres { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
.fz-sec-t { font-size: 12.5px; font-weight: 600; color: #4A4A4A; margin: 0 0 10px; }
.fz-led { display: flex; flex-direction: column; }
.fz-lrow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: baseline; gap: 12px; padding: 8px 0; border-top: 1px solid #ECECE8; font-size: 13.5px; }
.fz-lrow:first-child { border-top: 0; padding-top: 0; }
.fz-lrow .q { font-size: 12.5px; color: #6E6E66; white-space: nowrap; }
.fz-lrow .v { font-weight: 600; white-space: nowrap; min-width: 80px; text-align: right; }
.fz-lrow .v.neg { color: #B45309; }
.fz-lrow .sub { display: block; font-size: 12px; color: #6E6E66; margin-top: 2px; }
.fz-lrow.tot { border-top: 2px solid #1A1A1A; margin-top: 4px; padding-top: 10px; font-size: 15px; font-weight: 600; }
.fz-lrow.tot .v { font-size: 20px; }
.fz-fuera .fz-lrow .v { color: #B45309; } .fz-fuera .fz-lrow .v.cero { color: #a4a7a1; }
.fz-nota { font-size: 12.5px; color: #4A4A4A; line-height: 1.45; padding-top: 10px; border-top: 1px dashed #E0E0DA; margin-top: 8px; }
.fz-emb { display: flex; flex-direction: column; gap: 8px; }
.fz-emb-g { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-top: 1px solid #ECECE8; }
.fz-emb-g:first-child { border-top: 0; padding-top: 0; }
.fz-emb-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13.5px; font-weight: 600; }
.fz-emb-h .n { display: inline-flex; align-items: center; gap: 8px; }
.fz-emb-r { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12.5px; color: #4A4A4A; padding-left: 16px; }
.fz-emb-r .c { font-weight: 600; color: #1A1A1A; } .fz-emb-r .c.cero { color: #a4a7a1; font-weight: 500; }
.fz-emb-eur { color: #6E6E66; margin-right: 10px; }
.fz-emb-ok { font-size: 12px; color: #6E6E66; }
.fz-al { border-top: 1px solid #ECECE8; }
.fz-al-h { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto 90px 110px; align-items: center; gap: 12px; min-height: 52px; width: 100%; padding: 6px 16px; font-family: inherit; font-size: 13.5px; background: none; border: 0; text-align: left; cursor: pointer; color: inherit; }
.fz-al-h:hover { background: #FAFAF8; }
.fz-al-h .nom { font-size: 14.5px; font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.fz-al-h .flags { display: inline-flex; gap: 6px; }
.fz-al-h .cl { color: #6E6E66; text-align: right; } .fz-al-h .eur { font-weight: 600; text-align: right; }
.fz-caret { color: #6E6E66; display: inline-flex; }
.fz-al.open { background: #FAFAF8; }
.fz-al-b { padding: 4px 16px 16px 46px; display: flex; flex-direction: column; gap: 12px; }
.fz-ctx { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; font-size: 13px; color: #4A4A4A; }
.fz-ctx b { font-weight: 600; color: #1A1A1A; } .fz-ctx-sub { margin-left: auto; }
.fz-cupo { display: flex; align-items: center; gap: 10px; font-size: 13px; color: #4A4A4A; }
.fz-cupo > span:first-child { white-space: nowrap; }
.fz-aviso { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; background: #FFF6E0; font-size: 13px; }
.fz-aviso .n { font-size: 18px; font-weight: 700; color: #B45309; line-height: 1.1; }
.fz-aviso .t { font-weight: 600; } .fz-aviso .d { display: block; font-size: 12.5px; color: #4A4A4A; margin-top: 2px; }
.fz-tabla { border: 1px solid #ECECE8; border-radius: 8px; overflow: hidden; background: #fff; }
.fz-cls { display: grid; grid-template-columns: 64px 96px 180px minmax(0, 1fr) 80px auto; grid-template-areas: "f h st tipo e act"; align-items: center; gap: 12px; min-height: 40px; padding: 4px 12px; border-top: 1px solid #ECECE8; font-size: 13px; }
.fz-cls.head { min-height: 30px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #6E6E66; background: #FAFAF8; border-top: 0; }
.fz-cls.head span:nth-child(1) { grid-area: f; } .fz-cls.head span:nth-child(2) { grid-area: h; } .fz-cls.head span:nth-child(3) { grid-area: st; } .fz-cls.head span:nth-child(4) { grid-area: tipo; } .fz-cls.head span:nth-child(5) { grid-area: e; } .fz-cls.head span:nth-child(6) { grid-area: act; }
.fz-cls .f { grid-area: f; font-weight: 600; } .fz-cls .h { grid-area: h; color: #6E6E66; white-space: nowrap; }
.fz-cls .st { grid-area: st; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.fz-cls .tipo { grid-area: tipo; color: #4A4A4A; } .fz-cls .tipo .sin { color: #C81E1E; font-weight: 600; } .fz-cls .tipo .dudoso { color: #6E6E66; font-style: italic; }
.fz-cls .e { grid-area: e; font-weight: 600; text-align: right; white-space: nowrap; }
.fz-cls .act { grid-area: act; display: flex; justify-content: flex-end; gap: 6px; min-width: 0; }
.fz-cls .nota { grid-column: 1 / -1; font-size: 12px; color: #167A2D; }
.fz-cls.rojo { background: #FFFBFA; }

@media (max-width: 1100px) {
  .fz-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fz-tres { grid-template-columns: minmax(0, 1fr); }
  .fz-row { grid-template-columns: minmax(0, 1fr) 100px 100px 130px 110px 230px; gap: 10px; }
}

/* Teléfono */
@media (max-width: 767px) {
  .fz-head { margin-bottom: 12px; }
  .fz-head-l { width: 100%; justify-content: space-between; gap: 10px; }
  .fz-sub, .fz-csv { display: none; }
  .fz-head-r { width: 100%; } .fz-head-r .adm-btn { width: 100%; min-height: 44px; }
  .fz-mes-l { min-width: 0; font-size: 14px; } .fz-mes-b { width: 40px; height: 40px; min-height: 40px; }
  .fz-kpis { display: flex; flex-direction: column; gap: 10px; }
  .fz-k-estado { order: 0; } .fz-k-clases { order: 1; } .fz-k-ret { order: 2; } .fz-k-total { order: 3; }
  .fz-kpi { padding: 12px 14px; gap: 6px; } .fz-kpi-v { font-size: 24px; }
  .fz-lista { background: transparent; border: 0; box-shadow: none; overflow: visible; }
  .fz-lh { padding: 0 0 10px; border: 0; }
  .fz-lote { margin-left: 0; width: 100%; min-height: 44px; }
  .fz-row.head { display: none; }
  .fz-row { grid-template-columns: minmax(0, 1fr) auto 44px; grid-template-areas: "nom imp chk" "meta meta chk"; gap: 2px 12px; padding: 10px 12px 10px 14px; min-height: 0; background: #fff; border: 1px solid #E0E0DA; border-radius: 10px; margin-bottom: 8px; }
  .fz-row.reciente { border-color: rgba(22,122,45,0.30); box-shadow: none; }
  .fz-nom { font-size: 15px; } .fz-nom:hover { text-decoration: none; }
  .fz-cl, .fz-ret, .fz-ex, .fz-est { display: none; }
  .fz-meta { display: block; grid-area: meta; font-size: 12.5px; color: #6E6E66; line-height: 1.35; } .fz-meta b { color: #B45309; font-weight: 500; }
  .fz-imp { grid-area: imp; font-size: 16px; display: flex; flex-direction: column; align-items: flex-end; }
  .fz-imp-est { display: block; font-size: 11.5px; font-weight: 600; color: #167A2D; margin-top: 1px; white-space: nowrap; }
  .fz-chk { grid-area: chk; display: grid; place-items: center; width: 44px; height: 44px; min-height: 44px; border-radius: 999px; border: 1.5px solid #C8C8C0; background: #fff; color: #fff; padding: 0; cursor: pointer; align-self: center; }
  .fz-chk.on { background: #1E9E3A; border-color: #1E9E3A; } .fz-chk:disabled { opacity: 0.5; }
  .fz-vacio { background: #fff; border: 1px solid #E0E0DA; border-radius: 10px; }
  .fz-toast { left: 16px; right: 16px; bottom: calc(80px + env(safe-area-inset-bottom)); transform: none; max-width: none; padding: 12px 12px 12px 14px; }
  .fz-toast-t { white-space: normal; line-height: 1.35; flex: 1; } .fz-toast-u { min-height: 40px; }
  .fz-scrim { align-items: flex-end; padding: 0; }
  .fz-mod { border-radius: 16px 16px 0 0; max-width: none; padding: 18px 16px calc(16px + env(safe-area-inset-bottom)); }
  .fz-mod-b .adm-btn { min-height: 44px; }
  /* Desglose */
  .fz-back { min-height: 44px; }
  .fz-dh { align-items: flex-start; } .fz-dh-r { width: 100%; justify-content: space-between; }
  .fz-dh-r .adm-btn { width: 100%; min-height: 44px; order: 3; }
  .fz-dh-imp { font-size: 26px; }
  .fz-lh .fz-chips { width: 100%; }
  .fz-al-h { grid-template-columns: 18px minmax(0, 1fr) auto; grid-template-areas: "caret nom eur" "caret flags cl"; gap: 2px 10px; padding: 10px 12px; }
  .fz-al-h .fz-caret { grid-area: caret; } .fz-al-h .nom { grid-area: nom; } .fz-al-h .flags { grid-area: flags; } .fz-al-h .cl { grid-area: cl; } .fz-al-h .eur { grid-area: eur; }
  .fz-al-b { padding: 4px 12px 12px; }
  .fz-ctx-sub { margin-left: 0; }
  .fz-cls.head { display: none; }
  .fz-cls { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "f h e" "st st st" "tipo tipo act"; gap: 4px 10px; padding: 10px 12px; }
  .fz-cls .tipo:empty { display: none; }
  .fz-cls .act { justify-content: flex-end; } .fz-cls .act .adm-btn { min-height: 36px; }
  .fz-cls .nota { grid-column: 1 / -1; }
}
`;

// ─── Page ─────────────────────────────────────────────────────────────────────
// Explica la regla de DOS NIVELES (entrada y pago). Solo informativo.
function HowItWorksModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#F7F7F5', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '88vh', overflowY: 'auto', padding: 26, fontFamily: 'var(--font-app)' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1c1a', marginBottom: 6 }}>
          Cómo entra y cómo se paga una clase
        </div>
        <p style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.65, margin: '0 0 18px' }}>
          Son <b>dos preguntas distintas</b>, y en este orden:
        </p>

        <ol style={{ margin: '0 0 18px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>
              ¿Entra a finanzas? — lo decide el clic en &laquo;Unirse a clase&raquo;
            </div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              El acceso queda registrado con la hora exacta y es lo que hace que la clase exista para
              el pago. <b>Si el profesor no pulsó el botón, la clase no aparece acá</b>: no se cuenta
              ni siquiera como pendiente, y subir el transcript después no la trae de vuelta.
            </div>
          </li>
          <li>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1c1a' }}>
              ¿Se cobra? — lo decide el transcript
            </div>
            <div style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.6, marginTop: 3 }}>
              De las clases que entraron, se pagan las que tienen el transcript subido y validado
              (&laquo;Mis clases&raquo; → &laquo;Añadir clase&raquo;, el texto que genera Fathom).
              Las demás quedan pendientes y pasan a pagables solas en cuanto se sube.
            </div>
          </li>
        </ol>

        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#8b8e88', marginBottom: 8 }}>
          Estados posibles
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 }}>
          {[
            { dot: '#1E9E3A', label: 'Pagable', desc: 'clic + transcript validado — suma al total a cobrar' },
            { dot: '#FFC400', label: 'Pendiente de transcript', desc: 'clic sin transcript: la clase se dio y se ve, pero NO suma al total' },
            { dot: '#a4a7a1', label: 'No aparece', desc: 'sin clic en «Unirse a clase» la clase no entró a finanzas' },
          ].map(s => (
            <div key={s.label} style={{ display: 'grid', gridTemplateColumns: '9px 1fr', gap: 10, alignItems: 'start' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: s.dot, marginTop: 6 }} />
              <span style={{ fontSize: 13.5, color: '#5f6360', lineHeight: 1.55 }}>
                <b style={{ color: '#1a1c1a' }}>{s.label}</b> — {s.desc}
              </span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12.5, color: '#9a6516', background: '#fdf3e7', border: '1px solid #f2e2c9', borderRadius: 10, padding: '10px 13px', lineHeight: 1.6, marginBottom: 18 }}>
          Única excepción al clic: <b>falta sin aviso</b> y <b>cancelación sobre la hora</b>. El alumno
          no vino, así que no puede haber ingreso: entran por el registro que crea el profesor y se
          cobran las 2 primeras de cada tipo por alumno, sin transcript.
        </div>

        <button
          onClick={onClose}
          style={{ width: '100%', padding: '11px', borderRadius: 10, border: 'none', background: '#1E9E3A', color: '#fff', fontFamily: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
        >
          Entendido
        </button>
      </div>
    </div>
  );
}


function FinanzasContent() {
  const { reloadAll } = useTeachers();
  const [howOpen, setHowOpen] = useState(false);
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <NavBar />
      <PullToRefresh onRefresh={reloadAll}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 48px' }}>
          <LastUpdated />
          <FinanceTab onHow={() => setHowOpen(true)} />
        </div>
      </PullToRefresh>
      {howOpen && <HowItWorksModal onClose={() => setHowOpen(false)} />}
    </div>
  );
}

export default function FinanzasPage() {
  return (
    <AuthGuard allowedRoles={['admin']}>
      <FinanzasContent />
    </AuthGuard>
  );
}
