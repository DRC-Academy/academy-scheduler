'use client';

// Piezas de presentación compartidas del módulo de IA.
// Sin lógica de datos: reciben props y pintan. Branding DRC.

import { useState, type CSSProperties } from 'react';
import {
  RISK_META, RISK_CAUSE_META, asObject, isRiskSignal, isRiskCause, isConversacionGuiada,
  type ClassAnalysisRow, type FichaIA, type NextClassIA, type TranscriptIA, type RiskSignal,
  type RiskCause, type GeneratedClassIA, type ConversacionGuiadaIA,
} from '@/lib/aiTypes';
import {
  ESCALATION_BANNER, asDetections, normalizeSuggestion,
  type Detection, type InterventionSuggestion,
} from '@/lib/interventions';

export const DRC = {
  green: '#1E9E3A',
  greenDark: '#167a2d',
  yellow: '#FFC400',
  bg: '#F7F7F5',
  font: "'Radio Canada', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

// ── Bloque etiqueta + texto ───────────────────────────────────────────────────
export function Field({ label, value }: { label: string; value?: string | null }) {
  if (!value?.trim()) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, color: DRC.green, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{value}</div>
    </div>
  );
}

export const panelBox: CSSProperties = {
  background: 'white', border: '1px solid #d1d5db', borderRadius: 10, padding: '14px 16px',
};

// ── Detalle de una alerta: motivo + causa + qué hacer ─────────────────────────

/**
 * Lo que hay detrás de una señal de riesgo, en un solo bloque. FUENTE ÚNICA de
 * este "ver detalle": lo usan la ficha del alumno y la cola del admin, porque
 * una alerta amarilla no puede explicarse distinto según dónde se mire.
 *
 * Antes el color llegaba solo: el profesor veía "amarillo" sin el porqué ni la
 * intervención, y tenía que deducir qué hacer.
 */
export function RiskActionDetail({ explanation, cause, stillOpenReason, intervention, detections }: {
  explanation?: string | null;
  cause?: RiskCause | null;
  stillOpenReason?: string | null;
  intervention?: InterventionSuggestion | null;
  detections?: Detection[];
}) {
  const dets = detections ?? [];
  const hayAlgo = !!explanation?.trim() || !!stillOpenReason?.trim() || !!intervention || dets.length > 0
    || (!!cause && cause !== 'no_aplica');
  if (!hayAlgo) return null;

  const causeMeta = cause && cause !== 'no_aplica' ? RISK_CAUSE_META[cause] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {explanation?.trim() && (
        <div>
          <div style={eyebrowStyle}>Motivo</div>
          <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{explanation}</div>
        </div>
      )}

      {/* La causa cambia la intervención tanto como el color: un amarillo por
          vacaciones y uno por desmotivación no se tratan igual. */}
      {causeMeta && (
        <div>
          <span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 700, color: '#5f6360', background: '#f0f1ee', border: '1px solid #e4e5e1', borderRadius: 20, padding: '3px 11px' }}>
            {causeMeta.label}
          </span>
          {causeMeta.hint && (
            <div style={{ fontSize: 12.5, color: '#8b8e88', lineHeight: 1.5, marginTop: 5 }}>{causeMeta.hint}</div>
          )}
        </div>
      )}

      {/* Solo aparece cuando la alerta sobrevivió a alguna clase posterior. */}
      {stillOpenReason?.trim() && (
        <div style={{ background: 'rgba(255,196,0,0.12)', border: '1px solid rgba(255,196,0,0.5)', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ ...eyebrowStyle, color: '#9a6516' }}>Por qué sigue abierta</div>
          <div style={{ fontSize: 13, color: '#7a5412', lineHeight: 1.55 }}>{stillOpenReason}</div>
        </div>
      )}

      {intervention && (
        <div>
          <div style={eyebrowStyle}>Intervención sugerida</div>
          {intervention.escalateToSupport && (
            <div style={{ fontSize: 12.5, color: '#b91c1c', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 8, padding: '8px 11px', marginBottom: 8, lineHeight: 1.5 }}>
              <b>{ESCALATION_BANNER.title}.</b> {ESCALATION_BANNER.body}
            </div>
          )}
          {intervention.action && (
            <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, marginBottom: intervention.steps.length ? 8 : 0 }}>
              {intervention.action}
            </div>
          )}
          {intervention.steps.length > 0 && (
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {intervention.steps.map((s, i) => (
                <li key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5 }}>{s}</li>
              ))}
            </ol>
          )}
          {intervention.reconnectHook && (
            <div style={{ fontSize: 12.5, color: DRC.greenDark, marginTop: 8, lineHeight: 1.5 }}>
              <b>Oportunidad:</b> {intervention.reconnectHook}
            </div>
          )}
        </div>
      )}

      {/* Cada cosa detectada con SU acción. Van juntas a propósito: el
          diagnóstico suelto es justo lo que no le servía al profesor. */}
      {dets.length > 0 && (
        <div>
          <div style={eyebrowStyle}>Detectado en la clase, y qué hacer</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {dets.map((d, i) => (
              <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '9px 11px', background: 'white' }}>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{d.finding}</div>
                <div style={{ fontSize: 13, color: DRC.greenDark, lineHeight: 1.5, marginTop: 5, paddingTop: 5, borderTop: '1px dashed #e5e7eb' }}>
                  <b>Prueba:</b> {d.action}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const eyebrowStyle: CSSProperties = {
  fontSize: 11.5, fontWeight: 800, color: DRC.green,
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
};

/** "Ver detalle" plegable alrededor de RiskActionDetail. */
export function RiskDetailToggle(props: React.ComponentProps<typeof RiskActionDetail>) {
  const [open, setOpen] = useState(false);
  const content = RiskActionDetail(props);
  if (!content) return null;
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: DRC.green }}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span> {open ? 'Ocultar detalle' : 'Ver detalle'}
      </button>
      {open && <div style={{ marginTop: 8 }}>{content}</div>}
    </div>
  );
}

// ── Badge de riesgo ───────────────────────────────────────────────────────────
export function RiskBadge({ risk, compact }: { risk: RiskSignal; compact?: boolean }) {
  const m = RISK_META[risk];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: compact ? '2px 8px' : '3px 10px', borderRadius: 10,
      fontSize: compact ? 10.5 : 11.5, fontWeight: 700, whiteSpace: 'nowrap',
      background: m.bg, border: `1px solid ${m.border}`, color: m.color,
    }}>
      {m.emoji} {m.label}
    </span>
  );
}

// ═══ SECCIÓN A — Perfil del alumno ════════════════════════════════════════════
const PROFILE_CARDS: Array<{ label: string; key: keyof FichaIA; wide?: boolean }> = [
  { label: 'Objetivo',              key: 'personalObjective' },
  { label: 'Perfil',                key: 'occupation' },
  { label: 'Estilo de aprendizaje', key: 'learningStyle' },
  { label: 'Puntos fuertes',        key: 'strongPoints' },
  { label: 'Áreas a trabajar',      key: 'weakPoints' },
  { label: 'Diagnóstico inicial',   key: 'initialDiagnosis', wide: true },
  { label: 'Foco recomendado',      key: 'recommendedFocus', wide: true },
];

const DOMAIN_LABEL: Record<string, string> = { social: 'Social', laboral: 'Laboral', educacional: 'Educacional' };

export function ProfileCards({ ficha }: { ficha: FichaIA }) {
  const eyebrow: CSSProperties = {
    fontSize: 11, fontWeight: 800, color: DRC.green, textTransform: 'uppercase', letterSpacing: '0.06em',
    borderLeft: `3px solid ${DRC.green}`, paddingLeft: 8, marginBottom: 6,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {ficha.domain && (
        <div>
          <span style={{ display: 'inline-block', fontSize: 11, fontWeight: 700, color: DRC.greenDark, background: 'rgba(30,158,58,0.1)', border: `1px solid ${DRC.green}`, borderRadius: 20, padding: '3px 12px' }}>
            Dominio · {DOMAIN_LABEL[ficha.domain] ?? ficha.domain}
          </span>
        </div>
      )}

      {ficha.priorities?.length > 0 && (
        <div style={{ ...panelBox, padding: '13px 15px', background: 'rgba(30,158,58,0.06)' }}>
          <div style={eyebrow}>Prioridades del diagnóstico</div>
          <div style={{ fontSize: 11.5, color: '#6b7280', marginBottom: 6 }}>De más a menos importante — base para elegir el objetivo de cada clase.</div>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
            {ficha.priorities.map((p, i) => <li key={i} style={{ marginBottom: 3 }}>{p}</li>)}
          </ol>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
        {PROFILE_CARDS.map(c => {
          const value = ficha[c.key];
          if (typeof value !== 'string' || !value.trim()) return null;
          return (
            <div key={c.key} style={{ ...panelBox, gridColumn: c.wide ? '1 / -1' : undefined, padding: '13px 15px' }}>
              <div style={eyebrow}>{c.label}</div>
              <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{value}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══ SECCIÓN B — Resumen de estado ════════════════════════════════════════════
export function StatusSummary({
  totalClasses, lastClassAt, progressScore, risk, nextClass,
}: {
  totalClasses: number;
  lastClassAt: string | null;
  progressScore: number;
  risk: RiskSignal | null;
  nextClass: GeneratedClassIA | null;
}) {
  return (
    <div style={{ ...panelBox, padding: '16px 18px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14, alignItems: 'start' }}>
        <Stat label="Clases analizadas" value={String(totalClasses)} />
        <Stat label="Última clase" value={lastClassAt ? relativeDays(lastClassAt) : '—'} />
        <div>
          <div style={statLabel}>Progreso general</div>
          <ProgressBar score={progressScore} />
        </div>
        <div>
          <div style={statLabel}>Señal de riesgo</div>
          {risk ? <RiskBadge risk={risk} /> : <span style={{ fontSize: 13, color: '#9ca3af' }}>Sin analizar</span>}
        </div>
      </div>
      {nextClass && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
          <div style={statLabel}>Última clase preparada</div>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111827' }}>
            Clase {nextClass.classNumber} — {nextClass.classTitle}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={statLabel}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: '#111827', lineHeight: 1.2 }}>{value}</div>
    </div>
  );
}

const statLabel: CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase',
  letterSpacing: '0.05em', marginBottom: 5,
};

export function ProgressBar({ score }: { score: number }) {
  const s = Math.min(10, Math.max(1, score || 5));
  const color = s >= 7 ? DRC.green : s >= 4 ? DRC.yellow : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <div style={{ flex: 1, minWidth: 60, height: 9, borderRadius: 5, background: '#e5e7eb', overflow: 'hidden' }}>
        <div style={{ width: `${s * 10}%`, height: '100%', background: color, borderRadius: 5, transition: 'width 0.4s ease' }} />
      </div>
      <span style={{ fontSize: 13.5, fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{s}/10</span>
    </div>
  );
}

export function relativeDays(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  return `hace ${days} días`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ═══ SECCIÓN B — Línea de tiempo de clases ════════════════════════════════════
export function ClassTimeline({ rows }: { rows: ClassAnalysisRow[] }) {
  if (rows.length === 0) {
    return (
      <div style={{ ...panelBox, textAlign: 'center', padding: '22px 16px', color: '#6b7280', fontSize: 13 }}>
        Todavía no hay clases analizadas. Usa “➕ Registrar clase dada” después de dar una clase.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map(r => <TimelineRow key={r.id} row={r} />)}
    </div>
  );
}

function TimelineRow({ row }: { row: ClassAnalysisRow }) {
  const [open, setOpen] = useState(false);
  const risk = isRiskSignal(row.risk_signal) ? row.risk_signal : null;
  const when = row.class_date ?? row.analyzed_at;
  const guide = asObject(row.next_class_guide);

  return (
    <div style={{ ...panelBox, padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
          padding: '12px 14px', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 800, color: '#111827' }}>
            {row.class_number != null ? `Clase ${row.class_number}` : 'Clase'}
            {when && <span style={{ fontWeight: 500, color: '#6b7280' }}> — {formatDate(when)}</span>}
          </span>
          {risk && <RiskBadge risk={risk} compact />}
        </div>
        {row.class_title && (
          <div style={{ fontSize: 13, color: '#4b5563', marginTop: 3, fontStyle: 'italic' }}>“{row.class_title}”</div>
        )}
        <div style={{ fontSize: 11.5, color: DRC.green, fontWeight: 700, marginTop: 6 }}>
          {open ? '▲ Ocultar resumen' : '▼ Ver resumen'}
        </div>
      </button>

      {open && (
        <div style={{ padding: '2px 14px 14px', borderTop: '1px dashed #e5e7eb' }}>
          <div style={{ height: 10 }} />
          <Field label="Resumen de lo que se trabajó" value={row.class_summary} />
          <Field label="Errores detectados" value={row.errors_detected} />
          <Field label="Progreso respecto a la anterior" value={row.progress_notes} />
          <Field label="Contenidos" value={row.topics_covered} />
          {/* Motivo + causa + intervención + detecciones, en un solo bloque y con
              la misma forma que ve el admin. Sustituye al "Motivo de la señal de
              riesgo" suelto, que decía por qué pero no qué hacer. */}
          <div style={{ marginTop: 4, marginBottom: 12 }}>
            <RiskActionDetail
              explanation={row.risk_explanation}
              cause={isRiskCause(row.risk_cause) ? row.risk_cause : null}
              intervention={normalizeSuggestion(asObject(row.intervention_suggestion))}
              detections={asDetections(row.detections)}
            />
          </div>
          {guide && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed #e5e7eb' }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: '#111827', marginBottom: 8 }}>
                🎯 Guía que se generó para la siguiente clase
              </div>
              <Field label="Prioridad" value={guide.priority} />
              <Field label="Warm-up" value={guide.warmUp} />
              <Field label="Foco principal" value={guide.mainFocus} />
              <Field label="Actividad" value={guide.activity} />
              <Field label="Notas" value={guide.notes} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Análisis de una clase (resultado del paso 3) ───────────────────────────────
export function TranscriptAnalysisView({ a }: { a: TranscriptIA }) {
  const risk = isRiskSignal(a.riskSignal) ? a.riskSignal : 'verde';
  const m = RISK_META[risk];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Section icon="📊" title="Resumen de la clase"><Body text={a.classSummary} /></Section>
      <Section icon="📝" title="Errores y patrones detectados"><Body text={a.errorsDetected} /></Section>
      <Section icon="📈" title="Progreso">
        <Body text={a.progressNotes} />
        <div style={{ marginTop: 10 }}><ProgressBar score={a.progressScore} /></div>
      </Section>
      <Section icon="🚦" title={`Señal de riesgo: ${m.emoji} ${m.label}`}>
        <div style={{ padding: '10px 12px', borderRadius: 8, background: m.bg, border: `1px solid ${m.border}`, fontSize: 13, color: m.color, lineHeight: 1.55, marginBottom: 12 }}>
          {a.riskExplanation}
        </div>
        <RiskActionDetail
          cause={isRiskCause(a.riskCause) ? a.riskCause : null}
          intervention={normalizeSuggestion(a.interventionSuggestion)}
        />
      </Section>
      {/* Cada detección con su acción. Va en su propia sección y NO dentro del
          riesgo: se generan también en verde, porque son hallazgos pedagógicos. */}
      {asDetections(a.detections).length > 0 && (
        <Section icon="🎯" title="Detectado, y qué hacer">
          <RiskActionDetail detections={asDetections(a.detections)} />
        </Section>
      )}
      <Section icon="✨" title="Guía para la siguiente clase" defaultOpen>
        <Field label="Prioridad" value={a.nextClassGuide?.priority} />
        <Field label="Warm-up" value={a.nextClassGuide?.warmUp} />
        <Field label="Foco principal" value={a.nextClassGuide?.mainFocus} />
        <Field label="Actividad" value={a.nextClassGuide?.activity} />
        <Field label="Notas" value={a.nextClassGuide?.notes} />
      </Section>
    </div>
  );
}

function Body({ text }: { text?: string | null }) {
  if (!text?.trim()) return <div style={{ fontSize: 13, color: '#9ca3af' }}>—</div>;
  return <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{text}</div>;
}

export function Section({ icon, title, children, defaultOpen = true }: {
  icon: string; title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...panelBox, padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: 'transparent', border: 'none', padding: '11px 14px', cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 13, fontWeight: 800, color: '#111827', textAlign: 'left',
        }}
      >
        <span>{icon} {title}</span>
        <span style={{ color: DRC.green, fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && <div style={{ padding: '0 14px 14px' }}>{children}</div>}
    </div>
  );
}

// ── Clase generada ────────────────────────────────────────────────────────────
// Misma lengua visual que el PDF: fases NUMERADAS en metodología aplicada (la
// secuencia input→práctica→producción es un orden real), cards ETIQUETADAS sin
// número en conversación guiada, y la sección del profesor separada (ámbar).
export function NextClassView({ nc }: { nc: GeneratedClassIA }) {
  if (isConversacionGuiada(nc)) return <ConversacionGuiadaView nc={nc} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {nc.objectives?.length > 0 && (
        <LabeledCard label="Objetivos de la clase" lead>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
            {nc.objectives.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </LabeledCard>
      )}
      <PhaseCard n={1} fallback="Warm-up" block={nc.warmUp} />
      <PhaseCard n={2} fallback="Contenido principal" block={nc.mainContent} />
      <PhaseCard n={3} fallback="Práctica" block={nc.practiceActivity} />
      <PhaseCard n={4} fallback="Cierre" block={nc.closing} />
      {nc.challenge && <ChallengeSection challenge={nc.challenge} />}
      <TeacherSection teacherNotes={nc.teacherNotes} connectionToPrevious={nc.connectionToPrevious} />
    </div>
  );
}

// Modo conversación guiada: sin fases; habilidad preparada + tópicos + preguntas.
function ConversacionGuiadaView({ nc }: { nc: ConversacionGuiadaIA }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: '#6b7280', fontStyle: 'italic' }}>
        Conversación guiada — charla continua. El tópico lo elige el alumno; sostené la habilidad preparada y corregí en vivo sin cortar el flujo.
      </div>
      <LabeledCard label="Habilidad a trabajar">
        <Body text={nc.skillObjective} />
        {nc.priorityAddressed && (
          <div style={{ marginTop: 8, fontSize: 12.5, color: '#6b7280', fontStyle: 'italic' }}>Prioridad del diagnóstico · {nc.priorityAddressed}</div>
        )}
      </LabeledCard>
      {nc.suggestedOpeners?.length > 0 && (
        <LabeledCard label="Aperturas de tópico">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
            {nc.suggestedOpeners.map((o, i) => <li key={i}>{o}</li>)}
          </ul>
        </LabeledCard>
      )}
      {nc.guidingQuestions?.length > 0 && (
        <LabeledCard label="Preguntas dirigidas">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
            {nc.guidingQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </LabeledCard>
      )}
      {nc.correctionFocus && (
        <LabeledCard label="Foco de corrección">
          <Body text={nc.correctionFocus} />
        </LabeledCard>
      )}
      {nc.challenge && <ChallengeSection challenge={nc.challenge} />}
      <TeacherSection teacherNotes={nc.teacherNotes} connectionToPrevious={nc.connectionToPrevious} />
    </div>
  );
}

const numChip: CSSProperties = {
  flex: '0 0 auto', width: 22, height: 22, borderRadius: '50%', background: DRC.green, color: '#fff',
  fontSize: 12.5, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
};

// Fase numerada (metodología aplicada).
function PhaseCard({ n, fallback, block }: { n: number; fallback: string; block?: { title: string; duration: string; content: string } }) {
  if (!block) return null;
  return (
    <div style={{ ...panelBox, padding: '13px 15px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
        <span style={numChip}>{n}</span>
        <span style={{ fontSize: 14, fontWeight: 800, color: '#111827' }}>{block.title || fallback}</span>
        {block.duration && <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: '#9ca3af' }}>{block.duration}</span>}
      </div>
      <Body text={block.content} />
    </div>
  );
}

// Card con header etiquetado (barra verde), para conversación guiada y objetivos.
function LabeledCard({ label, lead, children }: { label: string; lead?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ ...panelBox, padding: '13px 15px', background: lead ? 'rgba(30,158,58,0.06)' : 'white' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: '#111827', borderLeft: `3px solid ${DRC.green}`, paddingLeft: 9, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

// Desafío para llevarse — destacado en verde, mirando al alumno.
function ChallengeSection({ challenge }: { challenge: string }) {
  return (
    <div style={{ background: DRC.green, color: 'white', borderRadius: 10, padding: '12px 15px' }}>
      <div style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.9, marginBottom: 4 }}>🏆 Tu desafío</div>
      <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{challenge}</div>
    </div>
  );
}

// Bloque "Para el profesor" separado del material del alumno (borde punteado ámbar).
function TeacherSection({ teacherNotes, connectionToPrevious }: { teacherNotes: string; connectionToPrevious: string }) {
  if (!teacherNotes && !connectionToPrevious) return null;
  return (
    <div style={{ marginTop: 4, paddingTop: 14, borderTop: '2px dashed rgba(235,212,138,0.9)' }}>
      <div style={{ display: 'inline-block', fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#7A5B00', background: 'rgba(255,196,0,0.18)', border: '1px solid rgba(235,212,138,0.9)', borderRadius: 5, padding: '2px 9px', marginBottom: 10 }}>Para el profesor</div>
      {connectionToPrevious && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: '#111827', marginBottom: 3 }}>Conexión con la clase anterior</div>
          <Body text={connectionToPrevious} />
        </div>
      )}
      {teacherNotes && (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: '#111827', marginBottom: 3 }}>Notas</div>
          <Body text={teacherNotes} />
        </div>
      )}
    </div>
  );
}

/** Texto plano de la clase, para copiar al portapapeles. */
export function nextClassToText(nc: GeneratedClassIA, studentName: string): string {
  const header = [
    `${nc.classTitle}`,
    `Clase ${nc.classNumber} — ${studentName}${nc.duration ? ` · ${nc.duration}` : ''}`,
    '='.repeat(50),
  ];

  if (isConversacionGuiada(nc)) {
    const list = (title: string, items: string[]) =>
      items?.length ? `\n${title}\n${items.map(i => `  • ${i}`).join('\n')}\n` : '';
    return [
      ...header,
      '\n💬 CONVERSACIÓN GUIADA — charla continua; el tópico lo elige el alumno.',
      `\n🎯 HABILIDAD A TRABAJAR\n${'-'.repeat(50)}\n${nc.skillObjective}`,
      nc.priorityAddressed ? `\nPrioridad del diagnóstico: ${nc.priorityAddressed}` : '',
      list('🗣️ APERTURAS DE TÓPICO', nc.suggestedOpeners),
      list('❓ PREGUNTAS DIRIGIDAS', nc.guidingQuestions),
      `\n✏️ FOCO DE CORRECCIÓN\n${'-'.repeat(50)}\n${nc.correctionFocus}`,
      nc.challenge ? `\n🏆 TU DESAFÍO\n${'-'.repeat(50)}\n${nc.challenge}` : '',
      `\n📌 NOTAS PARA EL PROFESOR\n${'-'.repeat(50)}\n${nc.teacherNotes}`,
      nc.connectionToPrevious ? `\n🔗 CONEXIÓN CON LA CLASE ANTERIOR\n${nc.connectionToPrevious}` : '',
    ].filter(Boolean).join('\n');
  }

  const block = (icon: string, b?: { title: string; duration: string; content: string }) =>
    b ? `\n${icon} ${b.title.toUpperCase()}${b.duration ? ` (${b.duration})` : ''}\n${'-'.repeat(50)}\n${b.content}\n` : '';

  return [
    ...header,
    nc.objectives?.length ? `\n🎯 OBJETIVOS\n${nc.objectives.map(o => `  • ${o}`).join('\n')}\n` : '',
    block('🔥', nc.warmUp),
    block('📚', nc.mainContent),
    block('✍️', nc.practiceActivity),
    block('🎯', nc.closing),
    nc.challenge ? `\n🏆 TU DESAFÍO\n${'-'.repeat(50)}\n${nc.challenge}` : '',
    `\n📌 NOTAS PARA EL PROFESOR\n${'-'.repeat(50)}\n${nc.teacherNotes}`,
    nc.connectionToPrevious ? `\n🔗 CONEXIÓN CON LA CLASE ANTERIOR\n${nc.connectionToPrevious}` : '',
  ].filter(Boolean).join('\n');
}

// ── Ficha en markdown (formato anterior) ──────────────────────────────────────
export function FichaMarkdown({ text }: { text: string }) {
  return (
    <div style={panelBox}>
      {text.split('\n').map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} style={{ height: 8 }} />;
        if (line.startsWith('## ')) return <div key={i} style={{ fontSize: 15, fontWeight: 800, color: DRC.green, margin: '10px 0 6px' }}>{line.slice(3)}</div>;
        if (line.startsWith('# ')) return <div key={i} style={{ fontSize: 16, fontWeight: 800, color: '#111827', margin: '10px 0 6px' }}>{line.slice(2)}</div>;
        if (/^\s*[-*]\s+/.test(line)) {
          return (
            <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, paddingLeft: 14, position: 'relative' }}>
              <span style={{ position: 'absolute', left: 0, color: DRC.green }}>•</span>{line.replace(/^\s*[-*]\s+/, '')}
            </div>
          );
        }
        return <div key={i} style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.5, margin: '2px 0' }}>{line}</div>;
      })}
    </div>
  );
}
