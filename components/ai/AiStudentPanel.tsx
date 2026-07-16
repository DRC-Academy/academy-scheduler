'use client';

// Ficha del alumno con las dos secciones:
//   A — 📋 Perfil del alumno (del formulario inicial, no cambia)
//   B — 📚 Seguimiento clase a clase (se actualiza tras cada clase)
//
// Se usa tanto en Mis Alumnos (profesor) como en el panel de admin.

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  fetchStudentProfile, fetchClassAnalyses, regenerateFicha, analysisFromRow, riskOf,
  type ClassAnalysisRow, type StudentProfileRow,
} from '@/lib/aiClient';
import { asObject, fichaFromRow, type NextClassIA } from '@/lib/aiTypes';
import {
  ProfileCards, StatusSummary, ClassTimeline, FichaMarkdown, RiskBadge, DRC, panelBox,
} from '@/components/ai/FichaView';
import RegisterClassModal from '@/components/ai/RegisterClassModal';
import NextClassModal from '@/components/ai/NextClassModal';

interface Props {
  studentName: string;
  studentId?: string | null;
  formTokenId?: string | null;
  teacherId?: string | null;
  teacherName: string;
  plan?: string | null;
  level?: string | null;
  classNumber?: number | null;
  /** true = abierto de entrada, sin botón de plegar (panel de admin). */
  alwaysOpen?: boolean;
  /** false = sólo lectura, sin botones de acción (panel de admin). */
  canEdit?: boolean;
}

export default function AiStudentPanel({
  studentName, studentId, formTokenId, teacherId, teacherName,
  plan, level, classNumber, alwaysOpen = false, canEdit = true,
}: Props) {
  const [profile, setProfile] = useState<StudentProfileRow | null>(null);
  const [analyses, setAnalyses] = useState<ClassAnalysisRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(alwaysOpen);
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [nextClassOpen, setNextClassOpen] = useState(false);
  const [forceRegen, setForceRegen] = useState(false);

  const load = useCallback(async () => {
    const row = await fetchStudentProfile({ studentId, formTokenId, studentName });
    const rows = row ? await fetchClassAnalyses({ studentId: row.student_id ?? studentId, studentName, limit: 50 }) : [];
    return { row, rows };
  }, [studentId, formTokenId, studentName]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { row, rows } = await load();
      if (cancelled) return;
      setProfile(row);
      setAnalyses(rows);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [load]);

  const ficha        = fichaFromRow(profile);
  const nextClass    = asObject<NextClassIA>(profile?.next_class_content);
  const risk         = riskOf(profile);
  const lastAnalysis = analyses[0] ? analysisFromRow(analyses[0]) : null;
  const totalClasses = analyses.length || profile?.total_classes_analyzed || 0;
  const lastClassAt  = analyses[0]?.class_date ?? analyses[0]?.analyzed_at ?? profile?.last_class_analyzed_at ?? null;
  const hasResponses = Boolean(profile?.form_responses);

  // Número sugerido: la siguiente a la última analizada, o el contador de la app.
  const nextNumber = analyses[0]?.class_number != null
    ? analyses[0].class_number + 1
    : (classNumber ?? 1);

  async function handleGenerateFicha() {
    if (!profile) return;
    setGenLoading(true);
    setGenError(null);
    try {
      await regenerateFicha({ profileId: profile.id, teacherName, plan, level });
      const { row, rows } = await load();
      setProfile(row);
      setAnalyses(rows);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'No se pudo generar la ficha.');
    } finally {
      setGenLoading(false);
    }
  }

  async function refresh() {
    const { row, rows } = await load();
    setProfile(row);
    setAnalyses(rows);
  }

  if (!loaded) return null;

  // Sin ficha en la base: el alumno no ha completado el formulario todavía.
  if (!profile) {
    if (alwaysOpen) {
      return <div style={{ ...panelBox, fontSize: 13, color: '#6b7280' }}>Este alumno no ha completado el formulario inicial todavía.</div>;
    }
    return null;
  }

  const body = (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ═══ SECCIÓN A — Perfil ═══ */}
      <section>
        <SectionTitle>📋 Perfil del alumno</SectionTitle>
        {ficha ? (
          <ProfileCards ficha={ficha} />
        ) : profile.ai_ficha ? (
          <>
            <div style={{ ...noteBox, marginBottom: 10 }}>
              Esta ficha está en el formato anterior. Puedes regenerarla para verla en cards.
            </div>
            <FichaMarkdown text={profile.ai_ficha} />
            {canEdit && <GenerateFichaBtn onClick={handleGenerateFicha} loading={genLoading} label="🤖 Regenerar ficha" />}
          </>
        ) : (
          <div style={{ ...panelBox, textAlign: 'center', padding: '22px 16px' }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>📭</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 4 }}>
              No se encontró la ficha de este alumno.
            </div>
            <div style={{ fontSize: 12.5, color: '#6b7280', lineHeight: 1.5, marginBottom: 14 }}>
              {hasResponses
                ? '¿Quieres generarla ahora? Sus respuestas del formulario están guardadas.'
                : 'No hay respuestas del formulario guardadas, así que no hay nada que analizar.'}
            </div>
            {canEdit && hasResponses && (
              <GenerateFichaBtn onClick={handleGenerateFicha} loading={genLoading} label="🤖 Generar ficha" />
            )}
            {genError && <div style={errNote}>⚠️ {genError}</div>}
          </div>
        )}
        {ficha && genError && <div style={errNote}>⚠️ {genError}</div>}
      </section>

      {/* ═══ SECCIÓN B — Seguimiento ═══ */}
      <section>
        <SectionTitle>📚 Seguimiento clase a clase</SectionTitle>

        <StatusSummary
          totalClasses={totalClasses}
          lastClassAt={lastClassAt}
          progressScore={profile.progress_score ?? 5}
          risk={risk}
          nextClass={nextClass}
        />

        {/* Próxima clase preparada */}
        {nextClass ? (
          <div style={{ ...nextClassCard, marginTop: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#166534', marginBottom: 3 }}>✨ Próxima clase lista</div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111827', marginBottom: 10 }}>
              {nextClass.classTitle}
            </div>
            <button onClick={() => setNextClassOpen(true)} style={outlineGreen}>📄 Ver clase completa</button>
          </div>
        ) : canEdit && ficha ? (
          <div style={{ ...nextClassCard, marginTop: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#166534', marginBottom: 3 }}>✨ Próxima clase</div>
            <div style={{ fontSize: 13, color: '#4b5563', marginBottom: 10 }}>
              Todavía no hay una clase preparada para este alumno.
            </div>
            <button onClick={() => { setForceRegen(true); setNextClassOpen(true); }} style={outlineGreen}>
              ✨ Generar clase {nextNumber}
            </button>
          </div>
        ) : null}

        {/* Registrar clase */}
        {canEdit && (
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setRegisterOpen(true)} style={primaryGreen}>➕ Registrar clase dada</button>
          </div>
        )}

        {/* Línea de tiempo */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: '#374151', marginBottom: 8 }}>
            🗂 Historial ({analyses.length})
          </div>
          <ClassTimeline rows={analyses} />
        </div>
      </section>
    </div>
  );

  return (
    <div style={alwaysOpen ? undefined : { marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--border)' }}>
      {!alwaysOpen && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => setOpen(o => !o)} style={toggleBtn} aria-expanded={open}>
            📋 {open ? 'Ocultar ficha IA' : 'Ver ficha IA'}
          </button>
          {risk && <RiskBadge risk={risk} compact />}
          {!ficha && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ficha sin generar</span>}
          {analyses.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{analyses.length} clase(s) analizada(s)</span>
          )}
        </div>
      )}

      {open && body}

      {registerOpen && (
        <RegisterClassModal
          studentName={studentName}
          studentId={profile.student_id ?? studentId}
          teacherId={teacherId ?? profile.teacher_id}
          teacherName={teacherName}
          profileId={profile.id}
          plan={plan}
          level={level}
          suggestedClassNumber={nextNumber}
          ficha={ficha}
          classHistory={analyses.slice(0, 3).map(historyItem)}
          onSaved={() => { void refresh(); }}
          onGenerateNext={() => { setRegisterOpen(false); setForceRegen(true); setNextClassOpen(true); }}
          onClose={() => { setRegisterOpen(false); void refresh(); }}
        />
      )}

      {nextClassOpen && ficha && (
        <NextClassModal
          profileId={profile.id}
          studentName={studentName}
          teacherName={teacherName}
          classNumber={forceRegen ? nextNumber : (nextClass?.classNumber ?? nextNumber)}
          ficha={ficha}
          lastAnalysis={lastAnalysis}
          classHistory={analyses.slice(0, 3).map(historyItem)}
          plan={plan}
          level={level}
          cached={forceRegen ? null : nextClass}
          onSaved={nc => setProfile(p => (p ? { ...p, next_class_content: nc } : p))}
          onClose={() => { setNextClassOpen(false); setForceRegen(false); void refresh(); }}
        />
      )}
    </div>
  );
}

/** Resumen compacto de una clase, para pasarle contexto a la IA sin la transcripción entera. */
function historyItem(r: ClassAnalysisRow) {
  return {
    clase: r.class_number,
    fecha: r.class_date ?? r.analyzed_at,
    titulo: r.class_title,
    resumen: r.class_summary,
    errores: r.errors_detected,
    progreso: r.progress_notes,
    riesgo: r.risk_signal,
  };
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 14.5, fontWeight: 800, color: '#111827', marginBottom: 10, letterSpacing: '-0.2px' }}>
      {children}
    </div>
  );
}

function GenerateFichaBtn({ onClick, loading, label }: { onClick: () => void; loading: boolean; label: string }) {
  return (
    <button onClick={onClick} disabled={loading} style={{ ...primaryGreen, opacity: loading ? 0.7 : 1, marginTop: 8 }}>
      {loading ? '🤖 Generando…' : label}
    </button>
  );
}

const toggleBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 7,
  border: `1px solid ${DRC.green}66`, background: 'rgba(30,158,58,0.08)', color: DRC.green,
  cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
};
const primaryGreen: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '9px 16px', borderRadius: 9,
  border: `1.5px solid ${DRC.green}`, background: DRC.green, color: 'white',
  cursor: 'pointer', fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
};
const outlineGreen: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 13px', borderRadius: 8,
  border: `1.5px solid ${DRC.green}`, background: 'white', color: DRC.green,
  cursor: 'pointer', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
};
const nextClassCard: CSSProperties = {
  background: 'rgba(30,158,58,0.07)', border: `1.5px solid ${DRC.green}55`,
  borderRadius: 10, padding: '14px 16px',
};
const noteBox: CSSProperties = {
  fontSize: 12.5, color: '#92400E', background: 'rgba(255,196,0,0.14)',
  border: '1px solid rgba(255,196,0,0.45)', borderRadius: 8, padding: '10px 12px',
};
const errNote: CSSProperties = {
  marginTop: 10, fontSize: 12.5, color: '#C0392B', background: 'rgba(192,57,43,0.08)',
  border: '1px solid rgba(192,57,43,0.35)', borderRadius: 8, padding: '9px 12px',
};
