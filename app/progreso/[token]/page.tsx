'use client';

// Página PÚBLICA de progreso del alumno (link único, sin login).
//
// Es la ÚNICA pantalla del sistema que ve un cliente que paga, así que va con
// diseño propio (namespace `pg-`, CSS al final de este archivo) y no reutiliza el
// bloque `.sp-*` de globals.css, que es la ficha INTERNA del profesor. Compartir
// hoja de estilos con una pantalla interna significaba que cualquier retoque en
// el panel del profesor podía descolocar en silencio la página del alumno. Mismo
// criterio que /test/[token] y /formulario/[token].
//
// QUÉ NO SE ENSEÑA AQUÍ, a propósito: errores detectados, notas para el profesor,
// transcripciones, señal de riesgo, puntuación de progreso (1-10). Un 5/10 delante
// del alumno desmotiva y no le dice qué hacer.
//
// Sí se enseñan los puntos a reforzar (`weak_points`), que antes se ocultaban:
// dichos como "lo que estamos reforzando" son la mitad útil del informe, y sin
// ellos el foco actual llegaba sin explicación de por qué es el foco.

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { toBullets } from '@/components/alumnos/studentPageUi';
import { keepForStudent, forStudentOrNull } from '@/lib/studentFacing';
import { CEFR_LADDER, parseCefr } from '@/lib/studentViz';
import { getNextMilestone, isMilestone } from '@/lib/milestones';
import { buildEstimate, monthsLabel, type Estimate } from '@/lib/progressEstimate';
import type { ClassAnalysisRow, StudentProfileRow } from '@/lib/aiTypes';

interface TokenRow {
  token: string;
  student_id: string | null;
  student_name: string;
  expires_at: string | null;
}

/** Lo poco que hace falta de `assignments`: horas del plan y textos del objetivo. */
interface AssignmentLite {
  weekly_hours: number | null;
  plan: string | null;
  objetivo: string | null;
  student_level: string | null;
  slots: Array<{ day: string; hour: string }> | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'ready'; row: TokenRow; profile: StudentProfileRow | null; analyses: ClassAnalysisRow[]; assignment: AssignmentLite | null };

const PROFILE_COLS =
  'id, student_id, student_name, strong_points, weak_points, personal_objective, recommended_focus, ' +
  'current_level, level_test_cefr, total_classes_analyzed';
const ANALYSIS_COLS = 'id, student_id, student_name, class_number, class_summary, class_title, analyzed_at, class_date';
// `status` NO se pide: la columna puede no estar migrada (ver
// supabase-assignment-status.sql) y pedirla rompería la consulta con un 42703.
const ASSIGNMENT_COLS = 'weekly_hours, plan, objetivo, student_level, slots';

/** A dónde lleva "Amplía tu plan". Configurable sin tocar código. */
const UPSELL_URL = process.env.NEXT_PUBLIC_UPSELL_URL || 'https://drcacademy.com/mi-cuenta';

/**
 * El alumno puede tener más de una fila en `assignments` (cambios de profesor,
 * altas viejas sin borrar). Gana la que tenga MÁS celdas asignadas: es la que
 * describe el plan que está dando de verdad.
 */
function pickAssignment(rows: AssignmentLite[]): AssignmentLite | null {
  if (rows.length === 0) return null;
  const score = (a: AssignmentLite) => Math.max(a.slots?.length ?? 0, a.weekly_hours ?? 0);
  return rows.reduce((best, r) => (score(r) > score(best) ? r : best), rows[0]);
}

/** Horas semanales del plan. Las celdas del calendario mandan sobre el número guardado. */
function resolveWeeklyHours(a: AssignmentLite | null): number | null {
  if (!a) return null;
  const fromSlots = a.slots?.length ?? 0;
  if (fromSlots > 0) return fromSlots;
  const stored = Number(a.weekly_hours ?? 0);
  return stored > 0 ? stored : null;
}

export default function ProgresoPage() {
  const params = useParams<{ token: string }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from('progress_tokens')
        .select('token, student_id, student_name, expires_at')
        .eq('token', token)
        .limit(1);

      const row = (rows?.[0] ?? null) as TokenRow | null;
      if (!row) { if (!cancelled) setState({ kind: 'invalid' }); return; }
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
        if (!cancelled) setState({ kind: 'expired' });
        return;
      }

      // La ficha, las clases y la assignment se buscan por student_id y, como
      // respaldo, por nombre — el mismo criterio tolerante que usa el resto del
      // sistema.
      const profileQ = row.student_id
        ? supabase.from('student_profiles').select(PROFILE_COLS).eq('student_id', row.student_id).limit(1)
        : supabase.from('student_profiles').select(PROFILE_COLS).ilike('student_name', row.student_name).limit(1);
      const analysesQ = row.student_id
        ? supabase.from('class_analyses').select(ANALYSIS_COLS).eq('student_id', row.student_id).order('analyzed_at', { ascending: false })
        : supabase.from('class_analyses').select(ANALYSIS_COLS).ilike('student_name', row.student_name).order('analyzed_at', { ascending: false });
      const assignQ = row.student_id
        ? supabase.from('assignments').select(ASSIGNMENT_COLS).eq('student_id', row.student_id)
        : supabase.from('assignments').select(ASSIGNMENT_COLS).ilike('student_name', row.student_name);

      const [pRes, aRes, asgRes] = await Promise.all([profileQ, analysesQ, assignQ]);
      if (cancelled) return;
      setState({
        kind: 'ready',
        row,
        profile: (pRes.data?.[0] ?? null) as unknown as StudentProfileRow | null,
        analyses: (aRes.data ?? []) as unknown as ClassAnalysisRow[],
        assignment: pickAssignment((asgRes.data ?? []) as unknown as AssignmentLite[]),
      });
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="pg-page">
      <ProgresoStyles />
      <div className="pg-topline" aria-hidden />

      <header className="pg-header">
        <div className="pg-header-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/drc-logo.png" alt="DRC Academy" className="pg-logo" />
          <span className="pg-header-tag">Informe de progreso</span>
        </div>
      </header>

      <main className="pg-main">
        {state.kind === 'loading' && (
          <div className="pg-notice" role="status">Cargando tu progreso…</div>
        )}

        {state.kind === 'invalid' && (
          <div className="pg-notice">
            <strong>Este enlace no es válido.</strong>
            <span>Pídele a tu profesor que te comparta uno nuevo.</span>
          </div>
        )}

        {state.kind === 'expired' && (
          <div className="pg-notice">
            <strong>Este enlace ha caducado.</strong>
            <span>Pídele a tu profesor que te comparta uno nuevo.</span>
          </div>
        )}

        {state.kind === 'ready' && (
          <Progress
            row={state.row}
            profile={state.profile}
            analyses={state.analyses}
            assignment={state.assignment}
          />
        )}
      </main>
    </div>
  );
}

function Progress({ row, profile, analyses, assignment }: {
  row: TokenRow;
  profile: StudentProfileRow | null;
  analyses: ClassAnalysisRow[];
  assignment: AssignmentLite | null;
}) {
  const firstName = row.student_name.trim().split(/\s+/)[0] || row.student_name;

  // Todo lo que sale de la ficha pasa por el cortafuegos: está escrita para el
  // profesor y, con el formulario a medias, la IA deja ahí notas de trabajo que
  // no puede leer un cliente. Ver lib/studentFacing.ts.
  const strong = keepForStudent(toBullets(profile?.strong_points));
  const weak = keepForStudent(toBullets(profile?.weak_points));
  const objective = forStudentOrNull(profile?.personal_objective);
  const focus = forStudentOrNull(profile?.recommended_focus);

  // Nivel: la ficha manda, luego el test de nivel y por último lo que puso el
  // setter al dar de alta al alumno.
  const rawLevel = profile?.current_level || profile?.level_test_cefr || assignment?.student_level || null;
  const level = parseCefr(rawLevel);

  const weeklyHours = resolveWeeklyHours(assignment);

  const classCount = useMemo(() => {
    const fromNumbers = analyses.reduce((max, a) => Math.max(max, a.class_number ?? 0), 0);
    return Math.max(fromNumbers, analyses.length);
  }, [analyses]);

  const nextMilestone = getNextMilestone(classCount);

  const estimate = useMemo<Estimate | null>(() => buildEstimate({
    currentLevel: rawLevel,
    weeklyHours,
    planTexts: [assignment?.plan, assignment?.objetivo, objective],
  }), [rawLevel, weeklyHours, assignment?.plan, assignment?.objetivo, objective]);

  return (
    <>
      <section className="pg-intro pg-rise" style={{ animationDelay: '0ms' }}>
        <p className="pg-eyebrow">Tu progreso en inglés</p>
        <h1 className="pg-h1">Esto es lo que llevas conseguido, {firstName}.</h1>
        <p className="pg-lede">
          Un resumen de tu nivel, de lo que ya dominas y de hacia dónde vamos en las próximas clases.
        </p>
      </section>

      <section className="pg-card pg-hero pg-rise" style={{ animationDelay: '60ms' }}>
        <LevelLadder level={level} target={estimate?.target.level ?? null} />

        <div className="pg-stats">
          <div className="pg-stat">
            <span className="pg-stat-num">{classCount}</span>
            <span className="pg-stat-label">{classCount === 1 ? 'Clase hecha' : 'Clases hechas'}</span>
          </div>
          <div className="pg-stat">
            <span className="pg-stat-num">{level ?? '—'}</span>
            <span className="pg-stat-label">Nivel actual</span>
          </div>
          <div className="pg-stat">
            <span className="pg-stat-num">
              {weeklyHours != null ? weeklyHours : '—'}
              {weeklyHours != null && <span className="pg-stat-unit">h</span>}
            </span>
            <span className="pg-stat-label">Cada semana</span>
          </div>
          <div className="pg-stat">
            <span className="pg-stat-num">
              {nextMilestone ? <><span className="pg-stat-pre">Clase</span>{nextMilestone}</> : '✓'}
            </span>
            <span className="pg-stat-label">{nextMilestone ? 'Próximo hito' : 'Hitos completos'}</span>
          </div>
        </div>
      </section>

      {objective && (
        <section className="pg-card pg-goal pg-rise" style={{ animationDelay: '120ms' }}>
          <p className="pg-kicker">Tu objetivo</p>
          <blockquote className="pg-goal-text">{objective}</blockquote>
        </section>
      )}

      {estimate && <PaceBanner estimate={estimate} />}

      {(strong.length > 0 || weak.length > 0) && (
        <section className="pg-split pg-rise" style={{ animationDelay: '240ms' }}>
          {strong.length > 0 && (
            <div className="pg-card">
              <p className="pg-kicker">Lo que ya haces bien</p>
              <ul className="pg-list">
                {strong.map((t, i) => (
                  <li key={i}><span className="pg-mark pg-mark-ok" aria-hidden>✓</span><span>{t}</span></li>
                ))}
              </ul>
            </div>
          )}
          {weak.length > 0 && (
            <div className="pg-card">
              <p className="pg-kicker">Lo que estamos reforzando</p>
              <ul className="pg-list">
                {weak.map((t, i) => (
                  <li key={i}><span className="pg-mark pg-mark-up" aria-hidden>↗</span><span>{t}</span></li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {focus && (
        <section className="pg-card pg-focus pg-rise" style={{ animationDelay: '300ms' }}>
          <div className="pg-focus-head">
            <p className="pg-kicker">En qué trabajamos ahora</p>
            <span className="pg-badge">Foco actual</span>
          </div>
          <p className="pg-body">{focus}</p>
        </section>
      )}

      <Timeline analyses={analyses} />

      <p className="pg-foot">
        Este informe es privado y sólo para ti. Si te surge cualquier duda, coméntasela a tu profesor.
      </p>
    </>
  );
}

/**
 * La escalera del MCER con el alumno colocado en su peldaño y la bandera en el
 * objetivo. Es la pieza que hace entender de un vistazo dónde está y a dónde va.
 */
function LevelLadder({ level, target }: { level: string | null; target: string | null }) {
  const at = level ? CEFR_LADDER.indexOf(level as typeof CEFR_LADDER[number]) : -1;
  const targetAt = target ? CEFR_LADDER.indexOf(target as typeof CEFR_LADDER[number]) : -1;

  return (
    <div className="pg-ladder-wrap">
      <p className="pg-kicker">Tu nivel</p>
      <ol className="pg-ladder">
        {CEFR_LADDER.map((label, i) => {
          const done = at >= 0 && i < at;
          const current = at >= 0 && i === at;
          const isTarget = targetAt >= 0 && i === targetAt;
          const cls = ['pg-rung', done && 'is-done', current && 'is-current', isTarget && 'is-target']
            .filter(Boolean).join(' ');
          return (
            <li key={label} className={cls} aria-current={current ? 'step' : undefined}>
              <span className="pg-rung-label">{label}</span>
              {current && <span className="pg-rung-note">Estás aquí</span>}
              {isTarget && <span className="pg-rung-note pg-rung-note-target">Tu meta</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * EL BANNER. La misma distancia recorrida a dos o tres velocidades, con la fecha
 * de llegada de cada una. La fecha es lo que convence: "29 meses" es abstracto,
 * "mayo de 2028" se entiende de golpe.
 *
 * Las barras se animan desde 0 al montar para que la diferencia de longitud se
 * lea como movimiento y no como un gráfico estático.
 */
function PaceBanner({ estimate }: { estimate: Estimate }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGrown(true), 260);
    return () => clearTimeout(t);
  }, []);

  const best = estimate.options[estimate.options.length - 1];
  const targetIsExam = estimate.target.source === 'examen';

  return (
    <section className="pg-card pg-pace pg-rise" style={{ animationDelay: '180ms' }}>
      <p className="pg-kicker pg-kicker-light">Tu ritmo</p>
      <h2 className="pg-pace-title">
        {estimate.hasUpgrade ? 'Puedes llegar antes de lo que crees' : 'Vas al mejor ritmo posible'}
      </h2>
      <p className="pg-pace-lede">
        Para alcanzar el <strong>{estimate.target.level}</strong>
        {targetIsExam ? ' que preparas' : ''} quedan unas <strong>{estimate.hoursNeeded} horas</strong> de inglés.
        {estimate.hasUpgrade
          ? ' Esto es lo que tardarías según las horas que hagas cada semana.'
          : ' A tu ritmo actual, esta es la previsión.'}
      </p>

      <ol className="pg-bars">
        {estimate.options.map(o => (
          <li key={o.weeklyHours} className={`pg-bar-row${o.isCurrent ? ' is-current' : ''}`}>
            <div className="pg-bar-head">
              <span className="pg-bar-plan">
                {o.weeklyHours} h a la semana
                {o.isCurrent && <span className="pg-chip">Tu plan</span>}
              </span>
              <span className="pg-bar-months">{monthsLabel(o.months)}</span>
            </div>

            <div className="pg-track">
              <div
                className="pg-fill"
                style={{ width: grown ? `${o.barPct}%` : '0%' }}
                aria-hidden
              />
            </div>

            <div className="pg-bar-foot">
              <span className="pg-bar-date">Llegarías en {o.arrival}</span>
              {o.monthsSaved > 0 && (
                <span className="pg-save">{monthsLabel(o.monthsSaved)} antes</span>
              )}
            </div>
          </li>
        ))}
      </ol>

      {estimate.hasUpgrade && (
        <div className="pg-cta-block">
          <a className="pg-cta" href={UPSELL_URL} target="_blank" rel="noopener noreferrer">
            Amplía tu plan
            <span className="pg-cta-arrow" aria-hidden>→</span>
          </a>
          <p className="pg-cta-note">
            Con una hora más a la semana llegarías {monthsLabel(estimate.options[1].monthsSaved)} antes.
            {best.weeklyHours > estimate.options[1].weeklyHours &&
              ` Con ${best.weeklyHours} horas, ${monthsLabel(best.monthsSaved)} antes.`}
          </p>
        </div>
      )}

      <p className="pg-disclaimer">
        Estimación orientativa. Partimos de las horas de estudio guiado que Cambridge asocia a cada
        nivel del MCER y contamos con que practicas por tu cuenta entre clases. Tu ritmo real depende
        de ti y de tu constancia.
      </p>
    </section>
  );
}

/** "19 de agosto de 2026", o null si la fila no trae una fecha usable. */
function classDate(r: ClassAnalysisRow): string | null {
  const raw = r.class_date ?? r.analyzed_at;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** El recorrido clase a clase. Los hitos de DRC (1, 15, 30, 50) van marcados. */
function Timeline({ analyses }: { analyses: ClassAnalysisRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const VISIBLE = 6;

  // Las clases cuyo informe quedó pendiente o falló no tienen ni título ni
  // resumen: pintaban una tarjeta vacía con sólo la fecha, que al alumno no le
  // dice nada. Se quedan fuera hasta que el informe exista.
  const withContent = analyses.filter(
    r => (r.class_summary ?? '').trim() || (r.class_title ?? '').trim(),
  );
  const shown = showAll ? withContent : withContent.slice(0, VISIBLE);
  const hidden = withContent.length - shown.length;

  return (
    <section className="pg-rise" style={{ animationDelay: '360ms' }}>
      <p className="pg-section-title">Tu recorrido, clase a clase</p>

      {withContent.length === 0 ? (
        <div className="pg-card pg-empty">
          Aquí irá apareciendo el resumen de cada clase. Se irá llenando a medida que avances.
        </div>
      ) : (
        <>
          <ol className="pg-timeline">
            {shown.map(r => {
              const n = r.class_number ?? 0;
              const milestone = n > 0 && isMilestone(n);
              const fecha = classDate(r);
              return (
                <li key={r.id} className={`pg-tl-item${milestone ? ' is-milestone' : ''}`}>
                  <span className="pg-tl-node" aria-hidden />
                  <div className="pg-card pg-tl-card">
                    {/* Muchas filas no traen número de clase. Antes salía
                        "Clase —", que parecía un fallo; sin número manda la fecha. */}
                    <div className="pg-tl-head">
                      {n > 0 && <span className="pg-tl-num">Clase {n}</span>}
                      {fecha && <span className={n > 0 ? 'pg-tl-date' : 'pg-tl-num'}>{fecha}</span>}
                      {milestone && <span className="pg-badge pg-badge-sm">Hito</span>}
                    </div>
                    {r.class_title && <p className="pg-tl-title">{r.class_title}</p>}
                    {r.class_summary && <p className="pg-body">{r.class_summary}</p>}
                  </div>
                </li>
              );
            })}
          </ol>

          {hidden > 0 && (
            <button className="pg-more" onClick={() => setShowAll(true)}>
              Ver las {withContent.length} clases
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ProgresoStyles() {
  return <style dangerouslySetInnerHTML={{ __html: PROGRESO_CSS }} />;
}

const PROGRESO_CSS = `
.pg-page {
  --pg-green: #1E9E3A;
  --pg-green-dark: #14722A;
  --pg-green-deep: #103A1E;
  --pg-green-bright: #37C457;
  --pg-yellow: #FFC400;
  --pg-cream: #F7F7F5;
  --pg-surface: #FFFFFF;
  --pg-ink: #191A17;
  --pg-muted: #63675F;
  --pg-faint: #8D9188;
  --pg-line: #E4E5DE;

  min-height: 100dvh;
  background: var(--pg-cream);
  color: var(--pg-ink);
  font-family: 'Radio Canada', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}

.pg-topline { height: 4px; background: linear-gradient(90deg, var(--pg-green) 0%, var(--pg-green) 58%, var(--pg-yellow) 100%); }

.pg-header { background: var(--pg-surface); border-bottom: 1px solid var(--pg-line); }
.pg-header-in {
  max-width: 780px; margin: 0 auto; padding: 14px 20px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
.pg-logo { height: 30px; width: auto; object-fit: contain; display: block; }
.pg-header-tag {
  font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--pg-faint);
}

.pg-main {
  max-width: 780px; margin: 0 auto; padding: 36px 20px 72px;
  display: flex; flex-direction: column; gap: 18px;
}

/* ── Entrada escalonada ─────────────────────────────────────────────────── */
.pg-rise { animation: pg-rise 0.55s cubic-bezier(0.22, 0.61, 0.36, 1) backwards; }
@keyframes pg-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

/* ── Cabecera de contenido ──────────────────────────────────────────────── */
.pg-intro { padding: 6px 2px 4px; }
.pg-eyebrow {
  font-size: 11.5px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--pg-green-dark); margin: 0 0 12px;
}
.pg-h1 {
  font-size: clamp(27px, 6.2vw, 40px); font-weight: 700; letter-spacing: -0.03em;
  line-height: 1.12; margin: 0; text-wrap: balance;
}
.pg-lede { font-size: 15.5px; line-height: 1.6; color: var(--pg-muted); margin: 12px 0 0; max-width: 46ch; }

/* ── Tarjeta base ───────────────────────────────────────────────────────── */
.pg-card {
  background: var(--pg-surface); border: 1px solid var(--pg-line); border-radius: 18px;
  padding: 24px 26px; box-shadow: 0 1px 2px rgba(16, 32, 16, 0.04);
}
.pg-kicker {
  font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--pg-faint); margin: 0 0 14px;
}
.pg-body { font-size: 15px; line-height: 1.7; color: var(--pg-ink); margin: 0; white-space: pre-wrap; }
.pg-section-title {
  font-size: 19px; font-weight: 700; letter-spacing: -0.02em; margin: 18px 0 14px; padding-left: 2px;
}

/* ── Escalera MCER ──────────────────────────────────────────────────────── */
.pg-hero { display: flex; flex-direction: column; gap: 24px; }
.pg-ladder-wrap { min-width: 0; }
.pg-ladder {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;
  list-style: none; margin: 0; padding: 0;
}
.pg-rung {
  position: relative; text-align: center; padding: 13px 2px 11px;
  border-radius: 11px; background: #F1F2ED; border: 1.5px solid transparent;
  color: var(--pg-faint); font-size: 14px; font-weight: 600;
}
.pg-rung.is-done { background: #E9F4EB; color: #2F7A42; }
.pg-rung.is-current {
  background: var(--pg-surface); border-color: var(--pg-green); color: var(--pg-green-dark);
  font-weight: 700; box-shadow: 0 4px 14px rgba(30, 158, 58, 0.18);
}
.pg-rung.is-target { background: #FFFBEE; border-color: var(--pg-yellow); border-style: dashed; color: #7A5B00; }
.pg-rung-label { display: block; line-height: 1; }
.pg-rung-note {
  display: block; margin-top: 6px; font-size: 9.5px; font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--pg-green);
}
.pg-rung-note-target { color: #A87A00; }

/* ── Cifras del hero ────────────────────────────────────────────────────── */
.pg-stats {
  display: grid; grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid var(--pg-line); padding-top: 20px;
}
.pg-stat { padding: 0 14px; border-left: 1px solid var(--pg-line); min-width: 0; }
.pg-stat:first-child { padding-left: 0; border-left: none; }
.pg-stat-num {
  display: block; font-size: 26px; font-weight: 700; letter-spacing: -0.03em;
  line-height: 1.1; color: var(--pg-green-dark);
}
.pg-stat-unit { font-size: 16px; font-weight: 300; margin-left: 1px; }
.pg-stat-pre { font-size: 15px; font-weight: 400; margin-right: 5px; color: var(--pg-muted); }
.pg-stat-label {
  display: block; margin-top: 5px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--pg-faint);
}

/* ── Objetivo (las palabras del propio alumno, en cursiva) ──────────────── */
.pg-goal { border-left: 4px solid var(--pg-green); }
.pg-goal-text {
  margin: 0; font-size: 17px; font-style: italic; font-weight: 400;
  line-height: 1.62; color: #24271F; white-space: pre-wrap;
}

/* ── Banner de ritmo ────────────────────────────────────────────────────── */
.pg-pace {
  background: var(--pg-green-deep); border-color: var(--pg-green-deep); color: #fff;
  padding: 28px 26px 24px; box-shadow: 0 14px 36px rgba(16, 58, 30, 0.22);
}
.pg-kicker-light { color: var(--pg-yellow); }
.pg-pace-title {
  font-size: clamp(21px, 4.6vw, 27px); font-weight: 700; letter-spacing: -0.025em;
  line-height: 1.2; margin: 0 0 10px; color: #fff; text-wrap: balance;
}
.pg-pace-lede { font-size: 15px; line-height: 1.62; color: rgba(255, 255, 255, 0.76); margin: 0 0 24px; max-width: 52ch; }
.pg-pace-lede strong { color: #fff; font-weight: 700; }

.pg-bars { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 18px; }
.pg-bar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 7px; }
.pg-bar-plan {
  font-size: 14px; font-weight: 600; color: rgba(255, 255, 255, 0.82);
  display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.pg-chip {
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  background: rgba(255, 255, 255, 0.16); color: rgba(255, 255, 255, 0.9);
  padding: 3px 8px; border-radius: 999px;
}
.pg-bar-months { font-size: 19px; font-weight: 700; letter-spacing: -0.02em; color: #fff; white-space: nowrap; }

.pg-track { height: 12px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); overflow: hidden; }
.pg-fill {
  height: 100%; border-radius: 999px; min-width: 12px;
  background: linear-gradient(90deg, var(--pg-green) 0%, var(--pg-green-bright) 100%);
  transition: width 0.9s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.pg-bar-row.is-current .pg-fill { background: rgba(255, 255, 255, 0.26); }

.pg-bar-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 7px; }
.pg-bar-date { font-size: 12.5px; color: rgba(255, 255, 255, 0.58); }
.pg-save {
  font-size: 11px; font-weight: 700; letter-spacing: 0.03em; white-space: nowrap;
  background: var(--pg-yellow); color: #3D2C00; padding: 4px 10px; border-radius: 999px;
}

.pg-cta-block {
  margin-top: 26px; padding-top: 22px; border-top: 1px solid rgba(255, 255, 255, 0.14);
  display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
}
.pg-cta {
  display: inline-flex; align-items: center; gap: 10px; text-decoration: none;
  background: var(--pg-yellow); color: #2E2100; border-radius: 12px;
  padding: 14px 24px; font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em;
  box-shadow: 0 6px 18px rgba(255, 196, 0, 0.26);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.pg-cta:hover { transform: translateY(-1px); box-shadow: 0 9px 24px rgba(255, 196, 0, 0.34); }
.pg-cta:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
.pg-cta-arrow { transition: transform 0.18s ease; }
.pg-cta:hover .pg-cta-arrow { transform: translateX(3px); }
.pg-cta-note { font-size: 13.5px; line-height: 1.55; color: rgba(255, 255, 255, 0.72); margin: 0; flex: 1; min-width: 200px; }

.pg-disclaimer {
  margin: 22px 0 0; font-size: 11.5px; line-height: 1.6; color: rgba(255, 255, 255, 0.45);
}

/* ── Fuertes / a reforzar ───────────────────────────────────────────────── */
.pg-split { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
.pg-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 11px; }
.pg-list li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; font-size: 14.5px; line-height: 1.6; }
.pg-mark { font-weight: 700; line-height: 1.55; }
.pg-mark-ok { color: var(--pg-green); }
.pg-mark-up { color: #C98A08; }

/* ── Foco actual ────────────────────────────────────────────────────────── */
.pg-focus { border-left: 4px solid var(--pg-yellow); }
.pg-focus-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.pg-focus-head .pg-kicker { margin: 0; }
.pg-badge {
  font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
  background: var(--pg-yellow); color: #493600; padding: 4px 11px; border-radius: 999px; white-space: nowrap;
}
.pg-badge-sm { font-size: 9px; padding: 3px 8px; }

/* ── Recorrido ──────────────────────────────────────────────────────────── */
.pg-timeline { list-style: none; margin: 0; padding: 0 0 0 26px; position: relative; display: flex; flex-direction: column; gap: 14px; }
.pg-timeline::before {
  content: ""; position: absolute; left: 5px; top: 12px; bottom: 12px; width: 2px;
  background: linear-gradient(180deg, var(--pg-green) 0%, #DDE0D9 100%);
}
.pg-tl-item { position: relative; }
.pg-tl-node {
  position: absolute; left: -26px; top: 22px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--pg-surface); border: 2.5px solid var(--pg-green); box-sizing: border-box;
}
.pg-tl-item.is-milestone .pg-tl-node { background: var(--pg-yellow); border-color: var(--pg-yellow); box-shadow: 0 0 0 4px rgba(255, 196, 0, 0.2); }
.pg-tl-card { padding: 18px 22px; }
.pg-tl-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.pg-tl-num { font-size: 14px; font-weight: 700; letter-spacing: -0.01em; }
.pg-tl-date { font-size: 12.5px; color: var(--pg-faint); }
.pg-tl-title { font-size: 14.5px; font-weight: 600; color: var(--pg-green-dark); margin: 8px 0 0; }
.pg-tl-card .pg-body { margin-top: 9px; font-size: 14.5px; color: var(--pg-muted); }

.pg-more {
  display: block; width: 100%; margin-top: 14px; padding: 13px 18px;
  background: var(--pg-surface); border: 1px solid var(--pg-line); border-radius: 12px;
  font-family: inherit; font-size: 14px; font-weight: 600; color: var(--pg-green-dark);
  cursor: pointer; transition: background 0.16s ease, border-color 0.16s ease;
}
.pg-more:hover { background: #F1F7F2; border-color: #CBE3D1; }
.pg-more:focus-visible { outline: 2px solid var(--pg-green); outline-offset: 2px; }

/* ── Estados y pie ──────────────────────────────────────────────────────── */
.pg-empty { text-align: center; padding: 34px 22px; color: var(--pg-faint); font-size: 14.5px; line-height: 1.65; }
.pg-notice {
  background: var(--pg-surface); border: 1px solid var(--pg-line); border-radius: 18px;
  padding: 46px 26px; text-align: center; color: var(--pg-muted); font-size: 15px; line-height: 1.7;
  display: flex; flex-direction: column; gap: 4px;
}
.pg-notice strong { color: var(--pg-ink); font-size: 16.5px; font-weight: 700; }
.pg-foot { margin: 26px 0 0; text-align: center; font-size: 12.5px; line-height: 1.65; color: var(--pg-faint); }

/* ── Móvil ──────────────────────────────────────────────────────────────── */
@media (max-width: 720px) {
  .pg-main { padding: 26px 14px 56px; gap: 14px; }
  .pg-card { padding: 20px 18px; border-radius: 16px; }
  .pg-pace { padding: 24px 18px 20px; }
  .pg-ladder { gap: 4px; }
  .pg-rung { padding: 10px 1px 9px; font-size: 12.5px; border-radius: 9px; }
  .pg-rung-note { font-size: 8px; letter-spacing: 0.03em; margin-top: 4px; }
  .pg-stats { grid-template-columns: 1fr 1fr; gap: 16px 0; padding-top: 18px; }
  .pg-stat { padding: 0 12px; }
  .pg-stat:nth-child(odd) { padding-left: 0; border-left: none; }
  .pg-stat-num { font-size: 23px; }
  .pg-split { grid-template-columns: 1fr; gap: 14px; }
  .pg-goal-text { font-size: 16px; }
  .pg-bar-months { font-size: 17px; }
  .pg-cta-block { gap: 14px; }
  .pg-cta { width: 100%; justify-content: center; }
  .pg-cta-note { min-width: 0; text-align: center; }
  .pg-timeline { padding-left: 22px; }
  .pg-tl-node { left: -22px; top: 19px; }
  .pg-tl-card { padding: 16px 16px; }
  .pg-header-tag { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .pg-rise { animation: none; }
  .pg-fill { transition: none; }
  .pg-cta, .pg-cta-arrow { transition: none; }
}
`;
