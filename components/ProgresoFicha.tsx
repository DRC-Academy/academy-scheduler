'use client';

// -- La ficha de progreso del alumno ------------------------------------------
//
// EL CONTENIDO, sin la cascara. Lo montan DOS rutas y por eso vive aca:
//
//   . /progreso/[token]  - enlace unico que comparte el profesor. Carga los datos
//     en el navegador (anon key) y pinta su cabecera con el logo de DRC.
//   . /progreso-cuenta   - dentro de un iframe en "Mi cuenta" de WooCommerce. Los
//     datos llegan ya cargados DESDE EL SERVIDOR y no pinta cabecera: la pagina
//     de Mi cuenta ya tiene la suya.
//
// Estaba dentro de app/progreso/[token]/page.tsx como `Progress`. Se movio tal
// cual -mismo JSX, mismo CSS, mismas reglas- y lo unico que cambio es que recibe
// `studentName` en vez de la fila del token, que era el unico dato que usaba de
// ella. Copiar el contenido en la ruta nueva habria dejado dos fichas que se
// separan en el primer retoque.
//
// Diseno propio (prefijo `pg-`, CSS al final del archivo): no reutiliza el bloque
// `.sp-*` de globals.css, que es la ficha INTERNA del profesor. Compartir hoja de
// estilos con una pantalla interna significaba que cualquier retoque en el panel
// del profesor podia descolocar en silencio la pagina del alumno.
//
// QUE NO SE ENSENA AQUI, a proposito: errores detectados, notas para el profesor,
// transcripciones, senal de riesgo, puntuacion de progreso (1-10). Un 5/10
// delante del alumno desmotiva y no le dice que hacer.

import { useEffect, useMemo, useState } from 'react';
import { toBullets } from '@/components/alumnos/studentPageUi';
import { keepForStudent, forStudentOrNull } from '@/lib/studentFacing';
import { CEFR_LADDER } from '@/lib/studentViz';
import { effectiveLevelOf } from '@/lib/effectiveLevel';
import { getNextMilestone, isMilestone } from '@/lib/milestones';
import { construirEstimacion, type Estimacion } from '@/lib/estimacion';
import { resolveWeeklyHours, type AssignmentLite, type StudentLite } from '@/lib/progresoData';
import { BannerAmpliar } from '@/components/BannerAmpliar';
import type { ClassAnalysisRow, StudentProfileRow } from '@/lib/aiTypes';

export function ProgresoFicha({ studentName, profile, analyses, assignment, student }: {
  /** Nombre completo del alumno. Solo se usa el nombre de pila. */
  studentName: string;
  profile: StudentProfileRow | null;
  analyses: ClassAnalysisRow[];
  assignment: AssignmentLite | null;
  /** Fila de `students`: de aquí sale el producto de WooCommerce, que es lo que
   *  mejor dice si el alumno prepara un examen. Opcional: sin ella la detección
   *  cae a los textos de la assignment, como antes. */
  student?: StudentLite | null;
}) {
  const firstName = studentName.trim().split(/\s+/)[0] || studentName;

  // Todo lo que sale de la ficha pasa por el cortafuegos: está escrita para el
  // profesor y, con el formulario a medias, la IA deja ahí notas de trabajo que
  // no puede leer un cliente. Ver lib/studentFacing.ts.
  const strong = keepForStudent(toBullets(profile?.strong_points));
  const weak = keepForStudent(toBullets(profile?.weak_points));
  const objective = forStudentOrNull(profile?.personal_objective);
  const focus = forStudentOrNull(profile?.recommended_focus);

  // Nivel: manda el que confirmó el profesor tras las primeras clases; si no se
  // pronunció, la ficha, el test de nivel y por último lo que puso el setter al
  // dar de alta al alumno. Regla única en lib/effectiveLevel.
  const eff = effectiveLevelOf(profile, assignment?.student_level);
  const rawLevel = eff.raw;
  const level = eff.level;

  const weeklyHours = resolveWeeklyHours(assignment);

  const classCount = useMemo(() => {
    const fromNumbers = analyses.reduce((max, a) => Math.max(max, a.class_number ?? 0), 0);
    return Math.max(fromNumbers, analyses.length);
  }, [analyses]);

  const nextMilestone = getNextMilestone(classCount);

  // Las fuentes van EN ORDEN y gana la primera con un examen reconocible. El
  // producto de WooCommerce va primero porque es lo que el alumno compró y lo más
  // específico: 54 de los 63 alumnos de examen solo se detectan por ahí.
  const estimacion = useMemo<Estimacion | null>(() => construirEstimacion({
    nivelActual: rawLevel,
    horasSemanales: weeklyHours,
    fuentes: {
      productoWoo: student?.product_name,
      planAlumno: student?.plan,
      planAssignment: assignment?.plan,
      objetivo: assignment?.objetivo,
      objetivoPersonal: objective,
    },
  }), [rawLevel, weeklyHours, student?.product_name, student?.plan,
       assignment?.plan, assignment?.objetivo, objective]);

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
        <LevelLadder level={level} target={estimacion?.meta.nivel ?? null} />

        <div className="pg-stats">
          <div className="pg-stat">
            <span className="pg-stat-num">{classCount}</span>
            <span className="pg-stat-label">{classCount === 1 ? 'Clase hecha' : 'Clases hechas'}</span>
          </div>
          <div className="pg-stat">
            <span className="pg-stat-num">{level ?? '—'}</span>
            <span className="pg-stat-label">Nivel actual</span>
            {/*
              `decided` es false cuando el nivel NO lo fijó ni el profesor ni la
              prueba: lo que se enseña es el curso que contrató o un texto viejo
              de la ficha. Enseñarlo sin más lo haría pasar por una medición.
              El dato ya lo calculaba `effectiveLevelOf`; hasta ahora se tiraba.
            */}
            {level && !eff.decided && (
              <span className="pg-stat-nota">Estimado · confírmalo con tu profesor</span>
            )}
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

      <BannerAmpliar estimacion={estimacion} />

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

export function ProgresoStyles() {
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
/* La nota bajo el nivel cuando nadie lo ha medido todavía. En minúsculas y sin
   negrita a propósito, para matizar la cifra sin competir con ella. */
.pg-stat-nota {
  display: block; margin-top: 4px; font-size: 10.5px; line-height: 1.35;
  color: var(--pg-faint); text-transform: none; letter-spacing: 0;
  text-wrap: balance;
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
