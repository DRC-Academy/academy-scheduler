'use client';

// Card de alumno en la cuadrícula: compacta, escaneable y navegable.
//
// Las tres pestañas (Perfil / Seguimiento / Próxima clase) son la página
// /mis-alumnos/[studentId], que es la ÚNICA implementación. La card enlaza ahí.

import Link from 'next/link';
import { fichaFromRow } from '@/lib/aiTypes';
import { classCategoryBadge } from '@/lib/finance';
import type { StudentBundle } from '@/lib/misAlumnos';

/** Color de la insignia por nivel CEFR. Neutro si el nivel no se reconoce. */
const LEVEL_BADGE: Record<string, { bg: string; color: string }> = {
  A1: { bg: '#f2eef8', color: '#6d34c9' },
  A2: { bg: '#eef1f8', color: '#3b5b9e' },
  B1: { bg: '#eef4ef', color: '#2f7a42' },
  B2: { bg: '#eaf4f2', color: '#0f766e' },
  C1: { bg: '#fdf3e7', color: '#9a6516' },
  C2: { bg: '#fdf3e7', color: '#9a6516' },
};
const LEVEL_NEUTRAL = { bg: '#f0f1ee', color: '#5f6360' };

export function levelOf(raw?: string | null): string | null {
  const m = (raw ?? '').toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/);
  return m ? m[1] : null;
}

/** Estado de la ficha de IA de un alumno. Deriva del dato real, no de un flag. */
export type FichaState = 'ready' | 'generable' | 'no-form';

export function fichaStateOf(bundle: StudentBundle): FichaState {
  if (fichaFromRow(bundle.profile)) return 'ready';
  // Sin ficha pero con fila de perfil = el formulario está respondido y la
  // ficha se puede generar. Sin fila, primero hace falta el formulario.
  return bundle.profile ? 'generable' : 'no-form';
}

interface Props {
  bundle: StudentBundle;
  studentKey: string;
  generating: boolean;
  onGenerate: (bundle: StudentBundle) => void;
}

export default function StudentCard({ bundle, studentKey, generating, onGenerate }: Props) {
  const { assignment: a, analyses } = bundle;

  const level = levelOf(a.studentLevel);
  const badge = level ? (LEVEL_BADGE[level] ?? LEVEL_NEUTRAL) : LEVEL_NEUTRAL;
  const plan = classCategoryBadge({ assignmentPlan: a.plan, assignmentObjetivo: a.objetivo });
  const mainSlot = a.slots?.[0] ? `${a.slots[0].day} ${a.slots[0].hour}` : null;
  const state = fichaStateOf(bundle);

  const initials = a.studentName.trim().split(/\s+/).slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '').join('') || '?';

  // La URL usa el student_id real cuando existe; si no, el id de la assignment
  // (la página resuelve ambos). `studentKey` puede ser "name:…", que no sirve.
  const href = `/mis-alumnos/${encodeURIComponent(a.studentId || a.id)}`;

  return (
    <article className="alu-card">
      <div className="alu-card-top">
        <div className="alu-avatar" aria-hidden>{initials}</div>
        <div style={{ minWidth: 0 }}>
          <div className="alu-name" title={a.studentName}>{a.studentName}</div>
          <div className="alu-badges">
            {level && <span className="alu-badge" style={badge}>{level}</span>}
            <span className="alu-type" title={plan.label}>{plan.label}</span>
          </div>
        </div>
      </div>

      <div className="alu-meta">
        {[mainSlot, `${analyses.length} ${analyses.length === 1 ? 'clase' : 'clases'}`]
          .filter(Boolean).join(' · ')}
      </div>

      <div className="alu-foot">
        {state === 'ready' ? (
          <span className="alu-state">
            <span className="alu-dot" style={{ background: '#16a34a' }} />
            Ficha lista
          </span>
        ) : state === 'generable' ? (
          <button
            className="alu-gen"
            onClick={() => onGenerate(bundle)}
            disabled={generating}
            aria-label={`Generar ficha de IA de ${a.studentName}`}
          >
            <span className="alu-dot" style={{ background: '#e0912f' }} />
            {generating ? 'Generando…' : 'Generar ficha'}
          </button>
        ) : (
          // Sin formulario respondido no hay nada con lo que generar la ficha:
          // se informa en vez de ofrecer un botón que fallaría.
          <span className="alu-state is-muted" title="El alumno todavía no completó el formulario inicial">
            <span className="alu-dot" style={{ background: '#d0d3cd' }} />
            Sin formulario
          </span>
        )}

        <Link href={href} className="alu-view" data-student-key={studentKey}>
          Ver ficha →
        </Link>
      </div>
    </article>
  );
}
