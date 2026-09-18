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

import { useMemo, useState } from 'react';
import { toBullets } from '@/components/alumnos/studentPageUi';
import { keepForStudent, forStudentOrNull } from '@/lib/studentFacing';
import { CEFR_LADDER } from '@/lib/studentViz';
import { effectiveLevelOf } from '@/lib/effectiveLevel';
import { isMilestone } from '@/lib/milestones';
import { construirEstimacion, type Estimacion } from '@/lib/estimacion';
import { resolveWeeklyHours, type AssignmentLite, type StudentLite } from '@/lib/progresoData';
import { BannerAmpliar } from '@/components/BannerAmpliar';
import { CALENDARIO_CSS } from '@/components/DiplomaCalendario';
import type { ClassAnalysisRow, StudentProfileRow } from '@/lib/aiTypes';

// `studentName` ya no se muestra (el saludo con el nombre se quitó en
// septiembre de 2026: la página empieza directamente con la escalera de
// niveles). Sigue en la firma para no tocar a los dos que la montan.
export function ProgresoFicha({ profile, analyses, assignment, student, diplomaSlot }: {
  /** Nombre completo del alumno. Solo se usa el nombre de pila. */
  studentName: string;
  profile: StudentProfileRow | null;
  analyses: ClassAnalysisRow[];
  assignment: AssignmentLite | null;
  /** Fila de `students`: de aquí sale el producto de WooCommerce, que es lo que
   *  mejor dice si el alumno prepara un examen. Opcional: sin ella la detección
   *  cae a los textos de la assignment, como antes. */
  student?: StudentLite | null;
  /** El calendario de cuenta atrás del diploma (components/DiplomaCalendario),
   *  ya envuelto por la ruta en lo que difiere la consulta al LMS. Va DENTRO de
   *  la tarjeta "Tu nivel", debajo de la tira de niveles, donde hasta el
   *  18/09/2026 iba la fila de cifras. Sin él la tarjeta acaba en la tira. */
  diplomaSlot?: React.ReactNode;
}) {
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
  // `eff.decided` (si el nivel lo midió alguien o es el del alta) ya no se
  // enseña: la nota "Estimado · confírmalo con tu profesor" iba en la fila de
  // cifras, que se quitó el 18/09/2026.

  const weeklyHours = resolveWeeklyHours(assignment);

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
      {/* Sin encabezado: lo primero que ve el alumno es la escalera de niveles,
          en una tarjeta fina (18/09/2026): tira compacta y, debajo, el
          calendario de cuenta atrás del diploma, que se pinta desde el primer
          render con la fecha de inicio; lo que llega del LMS después (lecciones,
          "conseguido") cambia texto, nunca altura. */}
      <section className="pg-card pg-hero pg-rise" style={{ animationDelay: '0ms' }}>
        <LevelLadder level={level} target={estimacion?.meta.nivel ?? null} />
        {diplomaSlot}
      </section>

      {/* El banner de ampliación sube: ocupa el sitio que dejaron la fila de
          cifras y la tarjeta ancha del diploma. */}
      <BannerAmpliar estimacion={estimacion} />

      {/* La caja de objetivo va DEBAJO del banner (antes iba encima): así el
          botón "Amplía tu plan" queda más arriba. Misma caja, mismo estilo. */}
      {objective && (
        <section className="pg-card pg-goal pg-rise" style={{ animationDelay: '120ms' }}>
          <p className="pg-kicker">Tu objetivo</p>
          <blockquote className="pg-goal-text">{objective}</blockquote>
        </section>
      )}

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
  return <style dangerouslySetInnerHTML={{ __html: PROGRESO_CSS + CALENDARIO_CSS }} />;
}

const PROGRESO_CSS = `
.pg-page {
  --pg-green: #1E9E3A;
  --pg-green-dark: #14722A;
  --pg-green-deep: #103A1E;
  --pg-green-bright: #37C457;
  --pg-yellow: #FFC400;
  /* Tintes de fondo de las filas del banner. El verde es el mismo que ya usan los
     peldaños superados de la escalera, para no meter un tercer verde en la ficha. */
  --pg-green-tint: #E9F4EB;
  --pg-grey-tint: #F1F1EF;
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

.pg-main {
  max-width: 780px; margin: 0 auto; padding: 28px 20px 72px;
  display: flex; flex-direction: column; gap: 18px;
}

/* ── Entrada escalonada ─────────────────────────────────────────────────── */
.pg-rise { animation: pg-rise 0.55s cubic-bezier(0.22, 0.61, 0.36, 1) backwards; }
@keyframes pg-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

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
/* TARJETA FINA (18/09/2026): la tira arriba y, debajo, el calendario del diploma
   (components/DiplomaCalendario). Menos aire que las otras tarjetas (16 px
   arriba y abajo) y el rótulo más pegado a la tira: todo lo que ahorra aquí
   sube el banner de "Amplía tu plan". */
.pg-hero { display: flex; flex-direction: column; gap: 14px; padding-top: 16px; padding-bottom: 16px; }
.pg-hero .pg-kicker { margin-bottom: 9px; }
.pg-ladder-wrap { min-width: 0; }
.pg-ladder {
  display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px;
  list-style: none; margin: 0; padding: 0;
}
/* Peldaños a la mitad de alto que antes (~36 px con la nota): la letra arriba
   y, solo en el actual y en la meta, la nota de 9 px justo debajo. Todos los
   peldaños de la fila miden lo mismo (la rejilla los estira). */
.pg-rung {
  position: relative; text-align: center; padding: 4px 2px 3px;
  border-radius: 9px; background: #F1F2ED; border: 1.5px solid transparent;
  color: var(--pg-faint); font-size: 13.5px; font-weight: 600;
}
.pg-rung.is-done { background: #E9F4EB; color: #2F7A42; }
.pg-rung.is-current {
  background: var(--pg-surface); border-color: var(--pg-green); color: var(--pg-green-dark);
  font-weight: 700; box-shadow: 0 3px 10px rgba(30, 158, 58, 0.16);
}
.pg-rung.is-target { background: #FFFBEE; border-color: var(--pg-yellow); border-style: dashed; color: #7A5B00; }
.pg-rung-label { display: block; line-height: 15px; }
.pg-rung-note {
  display: block; margin-top: 1px; font-size: 9px; line-height: 10px; font-weight: 700;
  letter-spacing: 0.05em; text-transform: uppercase; color: var(--pg-green);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pg-rung-note-target { color: #A87A00; }

/* ── Objetivo (las palabras del propio alumno, en cursiva) ──────────────── */
.pg-goal { border-left: 4px solid var(--pg-green); }
.pg-goal-text {
  margin: 0; font-size: 17px; font-style: italic; font-weight: 400;
  line-height: 1.62; color: #24271F; white-space: pre-wrap;
}

/* ── Banner de ampliacion de plan ───────────────────────────────────────── */
/*
   TARJETA BLANCA, plana y sin animaciones. Antes era un bloque verde oscuro con
   barras en degradado que crecian al entrar; ahora el unico elemento que salta
   es la etiqueta amarilla del ahorro, que es lo que se quiere que mire el alumno.
   Las tres filas comparten el mismo ancho de barra a proposito: si cada una
   empezara en un sitio distinto, la comparacion visual mentiria.
*/
/* Luminoso y plano: sin sombra en la tarjeta, borde casi imperceptible, aire
   entre elementos. Dos tamaños de texto en todo el banner (20 px el título, 15 px
   el resto, 13 px lo secundario): el contraste lo pone el peso, no el tamaño. */
.pg-pace { padding: 28px 26px 26px; box-shadow: none; border-color: #ECEDE8; }
.pg-pace-title {
  font-size: 20px; font-weight: 700; letter-spacing: -0.02em;
  line-height: 1.25; margin: 0 0 6px; color: var(--pg-ink); text-wrap: balance;
}
.pg-pace-lede {
  font-size: 15px; font-weight: 400; line-height: 1.55; color: var(--pg-muted);
  margin: 0 0 22px; max-width: 52ch;
}

/* Cada plan, en su propia tarjeta. Tres pesos:
   · el actual: gris apagado, sin borde — el punto de partida;
   · los superiores: blanco con borde suave — "vivos" al lado del primero;
   · el de más horas: verde clarísimo y borde verde algo más marcado.

   ESCRITORIO Y TABLET: tres columnas. Las tarjetas comparten las CINCO filas de
   la rejilla madre (subgrid: plan · hueco del ahorro · meses · barra · fecha),
   así todas miden lo mismo, el hueco vacío de la primera es tan alto como la
   etiqueta amarilla de las otras, y las tres barras arrancan a la misma altura
   y miden el mismo ancho. La comparación no puede mentir. */
.pg-bars {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: auto; gap: 12px;
}
.pg-bar-row {
  display: grid; grid-row: span 5; grid-template-rows: subgrid; row-gap: 0; min-width: 0;
  background: #FFFFFF; border: 1px solid #E0ECE2; border-radius: 14px; padding: 16px 16px 14px;
}
.pg-bar-row.is-current { background: #F2F3F0; border-color: transparent; }
.pg-bar-row.is-best { background: #F1FAF3; border-color: #9BD6A8; position: relative; }

.pg-bar-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; align-self: start; }
.pg-bar-plan { font-size: 15px; font-weight: 700; color: var(--pg-ink); }
.pg-bar-row.is-current .pg-bar-plan { color: var(--pg-muted); }
.pg-chip {
  font-size: 13px; font-weight: 400; color: var(--pg-faint); white-space: nowrap;
}
/* Distintivo del plan de más horas: chico, verde de marca, montado sobre el
   borde superior de la tarjeta, a la derecha. Así no ocupa sitio en la línea
   del plan (en una columna de 200 px no cabían los dos) y en 360 px nunca se
   monta sobre "4 h a la semana". Secundario a propósito: la etiqueta amarilla
   es la que tiene que llamar la atención. */
.pg-badge-best {
  position: absolute; top: -10px; right: 12px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.02em; line-height: 1;
  background: var(--pg-green); color: #fff; padding: 5px 9px; border-radius: 999px; white-space: nowrap;
}
/* El hueco del ahorro existe en las tres tarjetas (vacío en la del plan actual):
   es lo que las mantiene cuadradas entre sí. */
.pg-save-slot { margin-top: 10px; min-height: 32px; display: flex; align-items: flex-start; }
/* El ahorro: lo más visible de la tarjeta. Es lo que se quiere que mire el alumno. */
.pg-save {
  display: inline-block;
  font-size: 15px; font-weight: 700; letter-spacing: -0.01em; white-space: nowrap;
  background: var(--pg-yellow); color: var(--pg-ink);
  padding: 6px 13px; border-radius: 999px;
}

/* Los meses, en grande, encima de la barra; la barra ocupa el ancho de la
   tarjeta, fina y con las puntas redondeadas. */
.pg-bar-months {
  display: block; margin-top: 12px;
  font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; color: var(--pg-ink);
  white-space: nowrap;
}
.pg-bar-row.is-current .pg-bar-months { color: var(--pg-muted); }
.pg-track { height: 6px; margin-top: 10px; border-radius: 999px; background: #E9EBE6; overflow: hidden; min-width: 0; align-self: center; }
.pg-fill { height: 100%; border-radius: 999px; background: var(--pg-green); }
/* El plan actual siempre esta lleno del todo, y en gris: es la referencia. */
.pg-bar-row.is-current .pg-fill { background: #C4C6BF; }
.pg-bar-date { margin: 10px 0 0; font-size: 13px; line-height: 1.4; color: var(--pg-faint); align-self: end; }

/* Boton: pildora verde centrada, sin hover llamativo. Es lo unico que va debajo
   de las filas: la nota que repetia el ahorro y el descargo se quitaron. */
.pg-cta-block { margin-top: 22px; display: flex; justify-content: center; }
.pg-cta {
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  min-height: 44px; margin: 0; padding: 12px 28px; border: 0; border-radius: 999px;
  background: var(--pg-green); color: #fff; font: inherit; font-size: 15px; font-weight: 700;
  text-decoration: none; cursor: pointer; box-shadow: 0 6px 16px rgba(30, 158, 58, 0.26);
}
.pg-cta:focus-visible { outline: 3px solid var(--pg-green-dark); outline-offset: 3px; }


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
  .pg-main { padding: 20px 14px 56px; gap: 14px; }
  .pg-card { padding: 20px 18px; border-radius: 16px; }
  .pg-hero { padding-top: 14px; padding-bottom: 14px; gap: 12px; }
  .pg-pace { padding: 24px 18px 20px; }
  .pg-ladder { gap: 4px; }
  .pg-rung { padding: 4px 1px 3px; font-size: 13px; border-radius: 8px; }
  .pg-split { grid-template-columns: 1fr; gap: 14px; }
  .pg-goal-text { font-size: 16px; }
  /* Tres columnas no entran: las tarjetas se apilan en versión compacta. Los
     meses suben a la línea del plan (a la derecha), la etiqueta amarilla va
     debajo solo donde existe (el hueco vacío no ocupa altura), la barra ocupa
     todo el ancho y la fecha cierra. Con nowrap el número nunca se parte. */
  /* 12 px de hueco entre filas: el distintivo asoma 10 px por encima de su tarjeta. */
  .pg-bars { display: flex; flex-direction: column; gap: 12px; }
  .pg-bar-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto;
    grid-template-areas: "head months" "save save" "track track" "date date";
    align-items: center; column-gap: 10px; padding: 11px 12px 10px; border-radius: 12px;
  }
  .pg-bar-head { grid-area: head; gap: 6px 8px; }
  .pg-bar-months { grid-area: months; margin: 0; font-size: 17px; letter-spacing: -0.01em; }
  .pg-save-slot { grid-area: save; margin: 0; min-height: 0; }
  .pg-save-slot:empty { display: none; }
  .pg-save { margin-top: 7px; font-size: 14px; padding: 4px 11px; }
  .pg-track { grid-area: track; margin-top: 8px; }
  .pg-bar-date { grid-area: date; margin-top: 6px; font-size: 12.5px; }
  .pg-badge-best { padding: 4px 8px; }
  /* Ancho completo solo en móvil: ahí es más cómodo de tocar. */
  .pg-cta { width: 100%; }
  .pg-timeline { padding-left: 22px; }
  .pg-tl-node { left: -22px; top: 19px; }
  .pg-tl-card { padding: 16px 16px; }
}

/* Teléfonos: seis peldaños en una fila no dejan sitio a "ESTÁS AQUÍ" en 9 px
   sin partirla en dos líneas, así que la tira va en dos filas de tres. */
@media (max-width: 480px) {
  .pg-ladder { grid-template-columns: repeat(3, 1fr); gap: 5px; }
}

@media (prefers-reduced-motion: reduce) {
  .pg-rise { animation: none; }
  .pg-fill { transition: none; }
  .pg-cta, .pg-cta-arrow { transition: none; }
}
`;
