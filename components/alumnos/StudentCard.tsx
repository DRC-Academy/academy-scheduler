'use client';

// Card de alumno en la lista: compacta y navegable.
//
// Las tres pestañas (Perfil / Seguimiento / Próxima clase) vivían acá en línea;
// ahora son la página /mis-alumnos/[studentId], que es la ÚNICA implementación.
// La card solo enlaza a esa página — se abre en pestaña nueva para no perder la
// posición en la lista.

import Link from 'next/link';
import { asObject, fichaFromRow, isRiskSignal, type GeneratedClassIA } from '@/lib/aiTypes';
import { classCategoryBadge } from '@/lib/finance';
import type { StudentBundle } from '@/lib/misAlumnos';
import { Avatar, RiskDot, btnSecondary, cardStyle } from '@/components/alumnos/ui';

interface Props {
  bundle: StudentBundle;
  studentKey: string;
}

export default function StudentCard({ bundle, studentKey }: Props) {
  const { assignment: a, profile, analyses } = bundle;

  const ficha = fichaFromRow(profile);
  const nextClass = asObject<GeneratedClassIA>(profile?.next_class_content);
  const risk = profile && isRiskSignal(profile.risk_signal) ? profile.risk_signal : null;
  const plan = classCategoryBadge({ assignmentPlan: a.plan, assignmentObjetivo: a.objetivo });
  const mainSlot = a.slots?.[0] ? `${a.slots[0].day} ${a.slots[0].hour}` : null;

  // La URL usa el student_id real cuando existe; si no, el id de la assignment
  // (la página resuelve ambos). `studentKey` puede ser "name:…", que no sirve.
  const routeId = a.studentId || a.id;
  const href = `/mis-alumnos/${encodeURIComponent(routeId)}`;

  return (
    <div style={{ ...cardStyle, padding: 16 }}>
      <div className="alu-card-head" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Avatar name={a.studentName} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{a.studentName}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            {[a.studentLevel, plan.label, mainSlot].filter(Boolean).join(' · ')}
          </div>
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {risk ? <RiskDot risk={risk} /> : (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {ficha ? 'Sin señal registrada' : 'Sin ficha de IA'}
              </span>
            )}
            {nextClass && (
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>· Clase preparada</span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            {analyses.length} {analyses.length === 1 ? 'clase' : 'clases'}
          </div>
          {/* Navegación en la MISMA pestaña: <Link> ya hace navegación cliente,
              así que no hace falta useRouter. Se quitó target="_blank" a
              propósito — abrir con rel="noopener" creaba una pestaña con
              sessionStorage vacío, que fue el origen del rebote al login. */}
          <Link
            href={href}
            data-student-key={studentKey}
            style={{ ...btnSecondary, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}
          >
            Ver ficha →
          </Link>
        </div>
      </div>
    </div>
  );
}
