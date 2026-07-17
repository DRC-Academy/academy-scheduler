'use client';

// Card de alumno: colapsada (compacta) o expandida con tabs.

import { useState } from 'react';
import { asObject, fichaFromRow, isRiskSignal, type FichaIA, type NextClassIA } from '@/lib/aiTypes';
import { regenerateFicha } from '@/lib/aiClient';
import { classCategoryBadge } from '@/lib/finance';
import type { StudentBundle } from '@/lib/misAlumnos';
import {
  Avatar, Collapsible, DataField, RiskDot, SectionLabel, Tabs, bodyTextStyle,
  btnPrimary, btnSecondary, cardStyle, fieldLabelStyle, formatDate, relativeDays,
} from '@/components/alumnos/ui';
import ProximaClaseTab from '@/components/alumnos/ProximaClaseTab';

const TABS = [
  { id: 'perfil', label: 'Perfil' },
  { id: 'seguimiento', label: 'Seguimiento' },
  { id: 'proxima', label: 'Próxima clase' },
] as const;
type TabId = typeof TABS[number]['id'];

interface Props {
  bundle: StudentBundle;
  teacherName: string;
  classNumber: number;
  onToast: (m: string) => void;
  onRefresh: () => Promise<void>;
  onLocalNextClass: (studentKey: string, nc: NextClassIA) => void;
  studentKey: string;
}

export default function StudentCard({
  bundle, teacherName, classNumber, onToast, onRefresh, onLocalNextClass, studentKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<TabId>('perfil');
  const { assignment: a, profile, analyses } = bundle;

  const ficha = fichaFromRow(profile);
  const nextClass = asObject<NextClassIA>(profile?.next_class_content);
  const risk = profile && isRiskSignal(profile.risk_signal) ? profile.risk_signal : null;
  const plan = classCategoryBadge({
    assignmentPlan: a.plan, assignmentObjetivo: a.objetivo,
  });
  const mainSlot = a.slots?.[0] ? `${a.slots[0].day} ${a.slots[0].hour}` : null;
  const lastAnalysis = analyses[0];
  const nextNumber = lastAnalysis?.class_number != null ? lastAnalysis.class_number + 1 : classNumber;

  return (
    <div style={{ ...cardStyle, padding: open ? 20 : 16 }}>
      {/* ── Cabecera (siempre visible) ── */}
      <div className="alu-card-head" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Avatar name={a.studentName} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>{a.studentName}</span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            {[a.studentLevel, plan.label, mainSlot].filter(Boolean).join(' · ')}
          </div>
          <div style={{ marginTop: 6 }}>
            {risk ? (
              <RiskDot risk={risk} />
            ) : (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sin ficha de IA</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
            Clase {classNumber}
          </div>
          <button onClick={() => setOpen(o => !o)} style={btnSecondary} aria-expanded={open}>
            {open ? 'Contraer' : 'Expandir'}
          </button>
        </div>
      </div>

      {/* ── Contenido expandido ── */}
      {open && (
        <div style={{ marginTop: 20 }}>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />

          {tab === 'perfil' && (
            <PerfilTab bundle={bundle} ficha={ficha} teacherName={teacherName} onToast={onToast} onRefresh={onRefresh} />
          )}

          {tab === 'seguimiento' && (
            <SeguimientoTab bundle={bundle} risk={risk} hasPending={Boolean(nextClass)} onGoToProxima={() => setTab('proxima')} />
          )}

          {tab === 'proxima' && (
            <ProximaClaseTab
              assignment={a}
              profile={profile}
              ficha={ficha}
              analyses={analyses}
              nextClass={nextClass}
              teacherName={teacherName}
              nextNumber={nextNumber}
              onToast={onToast}
              onRefresh={onRefresh}
              onNextClass={nc => onLocalNextClass(studentKey, nc)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ═══ TAB PERFIL ═══
function PerfilTab({ bundle, ficha, teacherName, onToast, onRefresh }: {
  bundle: StudentBundle; ficha: FichaIA | null; teacherName: string;
  onToast: (m: string) => void; onRefresh: () => Promise<void>;
}) {
  const { assignment: a, profile } = bundle;
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generar() {
    if (!profile) return;
    setGen(true);
    setErr(null);
    try {
      await regenerateFicha({ profileId: profile.id, teacherName, plan: a.plan, level: a.studentLevel });
      await onRefresh();
      onToast('Ficha generada correctamente');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo generar la ficha.');
    } finally {
      setGen(false);
    }
  }

  const hasResponses = Boolean(profile?.form_responses);

  return (
    <div>
      {/* Sub-sección A */}
      <section style={{ marginBottom: 24 }}>
        <SectionLabel>Datos del alumno</SectionLabel>
        <div className="alu-two-col">
          <div>
            <DataField label="Email de contacto" value={a.studentEmail || '—'} />
            <DataField label="Fecha de inicio" value={a.startDate ? formatDate(a.startDate + 'T00:00:00') : '—'} />
            <DataField label="Horas semanales" value={a.weeklyHours ? `${a.weeklyHours} h` : '—'} />
          </div>
          <div>
            <DataField label="Plan" value={a.plan || '—'} />
            <DataField label="Horarios" value={a.slots?.length ? a.slots.map(s => `${s.day} ${s.hour}`).join(' · ') : '—'} />
            <DataField label="Nivel" value={a.studentLevel || '—'} />
          </div>
        </div>
        <div style={{ marginTop: 4 }}>
          {ficha ? (
            <span style={{
              display: 'inline-block', padding: '4px 11px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: 'rgba(30,158,58,0.1)', border: '1px solid rgba(30,158,58,0.35)', color: '#166534',
            }}>
              Formulario completado
            </span>
          ) : null}
        </div>
      </section>

      {/* Sub-sección B */}
      <section>
        <SectionLabel>Ficha IA</SectionLabel>
        {ficha ? (
          <>
            <div className="alu-two-col">
              <div>
                <DataField label="Objetivo" value={ficha.personalObjective} />
                <DataField label="Perfil profesional" value={ficha.occupation} />
                <DataField label="Estilo de aprendizaje" value={ficha.learningStyle} />
              </div>
              <div>
                <DataField label="Puntos fuertes" value={ficha.strongPoints} />
                <DataField label="Áreas a trabajar" value={ficha.weakPoints} />
                <DataField label="Foco recomendado" value={ficha.recommendedFocus} />
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <DataField label="Diagnóstico inicial" value={ficha.initialDiagnosis} />
            </div>
          </>
        ) : (
          <div>
            <div style={{ ...bodyTextStyle, marginBottom: 4 }}>No hay ficha de IA para este alumno.</div>
            <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 14 }}>
              {hasResponses
                ? 'El alumno ya respondió el formulario: puedes generar la ficha ahora.'
                : 'Envía el formulario inicial para generarla automáticamente.'}
            </div>
            {hasResponses && (
              <button onClick={generar} disabled={gen} style={{ ...btnPrimary, opacity: gen ? 0.6 : 1 }}>
                {gen ? 'Generando...' : 'Generar ficha'}
              </button>
            )}
            {err && <div style={{ marginTop: 12, fontSize: 13, color: '#B91C1C' }}>{err}</div>}
          </div>
        )}
      </section>
    </div>
  );
}

// ═══ TAB SEGUIMIENTO ═══
function SeguimientoTab({ bundle, risk, hasPending, onGoToProxima }: {
  bundle: StudentBundle;
  risk: ReturnType<typeof isRiskSignal> extends true ? never : 'verde' | 'amarillo' | 'rojo' | null;
  hasPending: boolean;
  onGoToProxima: () => void;
}) {
  const { analyses } = bundle;
  const last = analyses[0];
  const lastWhen = last?.class_date ?? last?.analyzed_at ?? null;

  return (
    <div>
      <div style={{ ...cardStyle, marginBottom: 20, padding: 16 }}>
        <div className="alu-two-col" style={{ gap: 16 }}>
          <div>
            <div style={fieldLabelStyle}>Clases analizadas</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{analyses.length}</div>
          </div>
          <div>
            <div style={fieldLabelStyle}>Última clase</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
              {lastWhen ? relativeDays(lastWhen) : '—'}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div style={fieldLabelStyle}>Señal actual</div>
          {risk ? <RiskDot risk={risk} /> : <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Sin analizar</span>}
        </div>
      </div>

      {analyses.length === 0 ? (
        <div style={{ ...bodyTextStyle, color: 'var(--text-secondary)' }}>
          Aún no hay clases registradas para este alumno.
          <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>Registra la primera clase después de darla.</div>
        </div>
      ) : (
        <div>
          <SectionLabel>Historial</SectionLabel>
          {analyses.map(r => <TimelineRow key={r.id} row={r} />)}
        </div>
      )}

      {!hasPending && (
        <div className="alu-btn-row" style={{ marginTop: 24 }}>
          <button onClick={onGoToProxima} style={btnPrimary}>Registrar clase dada</button>
        </div>
      )}
    </div>
  );
}

function TimelineRow({ row }: { row: StudentBundle['analyses'][number] }) {
  const risk = isRiskSignal(row.risk_signal) ? row.risk_signal : null;
  const when = row.class_date ?? row.analyzed_at;
  const guide = asObject(row.next_class_guide);

  return (
    <Collapsible
      title={`Clase ${row.class_number ?? '—'} — ${when ? formatDate(when) : ''}`}
      meta={row.class_title ?? undefined}
    >
      {risk && <div style={{ marginBottom: 12 }}><RiskDot risk={risk} /></div>}
      <DataField label="Resumen" value={row.class_summary} />
      <DataField label="Errores detectados" value={row.errors_detected} />
      <DataField label="Progreso" value={row.progress_notes} />
      {guide && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div style={{ ...fieldLabelStyle, marginBottom: 8 }}>Guía generada para la siguiente clase</div>
          <DataField label="Prioridad" value={guide.priority} />
          <DataField label="Warm-up" value={guide.warmUp} />
          <DataField label="Foco principal" value={guide.mainFocus} />
          <DataField label="Actividad" value={guide.activity} />
          <DataField label="Notas" value={guide.notes} />
        </div>
      )}
    </Collapsible>
  );
}
