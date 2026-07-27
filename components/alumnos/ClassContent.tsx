'use client';

// Render de una clase generada, en secciones colapsables.

import { isConversacionGuiada, type ConversacionGuiadaIA, type GeneratedClassIA } from '@/lib/aiTypes';
import { Collapsible, bodyTextStyle, DRC_GREEN } from '@/components/alumnos/ui';
import { classSegments } from '@/lib/studentViz';

export function ClassContent({ nc }: { nc: GeneratedClassIA }) {
  if (isConversacionGuiada(nc)) return <ConversacionGuiadaContent nc={nc} />;

  // Barra de tiempo: los minutos salen del `duration` de cada bloque. Si alguno
  // no los declara, classSegments devuelve null y no se pinta nada (mejor eso
  // que repartir proporciones inventadas).
  const segments = classSegments([
    { key: 'warmUp', title: nc.warmUp?.title || 'Warm-up', duration: nc.warmUp?.duration ?? '' },
    { key: 'main', title: nc.mainContent?.title || 'Contenido principal', duration: nc.mainContent?.duration ?? '' },
    { key: 'practice', title: nc.practiceActivity?.title || 'Práctica', duration: nc.practiceActivity?.duration ?? '' },
    { key: 'closing', title: nc.closing?.title || 'Cierre', duration: nc.closing?.duration ?? '' },
  ]);

  return (
    <div>
      {segments && (
        <div style={{ marginBottom: 18 }}>
          <div className="sp-card-title">Estructura de la clase</div>
          <div className="sp-timebar" role="img"
            aria-label={segments.map(s => `${s.title}: ${s.minutes} minutos`).join('. ')}>
            {segments.map(s => (
              <span key={s.key} className="sp-timebar-seg"
                style={{ width: `${s.pct}%`, background: s.color }} />
            ))}
          </div>
          <div className="sp-seglist">
            {segments.map(s => (
              <div key={s.key} className="sp-seg">
                <span className="sp-seg-dot" style={{ background: s.color }} />
                <span className="sp-seg-title">{s.title}</span>
                <span className="sp-seg-min">{s.minutes} min</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {nc.objectives?.length > 0 && (
        <Collapsible title="Objetivos">
          <ul style={{ margin: 0, paddingLeft: 18, ...bodyTextStyle }}>
            {nc.objectives.map((o, i) => <li key={i} style={{ marginBottom: 4 }}>{o}</li>)}
          </ul>
        </Collapsible>
      )}
      <Block title="Warm-up" block={nc.warmUp} />
      <Block title="Contenido principal" block={nc.mainContent} />
      <Block title="Práctica" block={nc.practiceActivity} />
      <Block title="Cierre" block={nc.closing} />
      {nc.challenge && <ChallengeBlock challenge={nc.challenge} />}
      {nc.teacherNotes && (
        <Collapsible title="Notas para el profesor">
          <div style={bodyTextStyle}>{nc.teacherNotes}</div>
        </Collapsible>
      )}
      {nc.connectionToPrevious && (
        <Collapsible title="Conexión con clase anterior">
          <div style={bodyTextStyle}>{nc.connectionToPrevious}</div>
        </Collapsible>
      )}
    </div>
  );
}

function ConversacionGuiadaContent({ nc }: { nc: ConversacionGuiadaIA }) {
  return (
    <div>
      <Collapsible title="Tipo de clase">
        <div style={bodyTextStyle}>Conversación guiada: charla continua. El tópico lo elige el alumno; vos sostenés la habilidad preparada y corregís en vivo.</div>
      </Collapsible>
      <Collapsible title="Habilidad a trabajar" defaultOpen>
        <div style={bodyTextStyle}>{nc.skillObjective}</div>
        {nc.priorityAddressed && <div style={{ ...bodyTextStyle, marginTop: 8, fontStyle: 'italic' }}>Prioridad del diagnóstico: {nc.priorityAddressed}</div>}
      </Collapsible>
      {nc.suggestedOpeners?.length > 0 && (
        <Collapsible title="Aperturas de tópico">
          <ul style={{ margin: 0, paddingLeft: 18, ...bodyTextStyle }}>
            {nc.suggestedOpeners.map((o, i) => <li key={i} style={{ marginBottom: 4 }}>{o}</li>)}
          </ul>
        </Collapsible>
      )}
      {nc.guidingQuestions?.length > 0 && (
        <Collapsible title="Preguntas dirigidas">
          <ul style={{ margin: 0, paddingLeft: 18, ...bodyTextStyle }}>
            {nc.guidingQuestions.map((q, i) => <li key={i} style={{ marginBottom: 4 }}>{q}</li>)}
          </ul>
        </Collapsible>
      )}
      {nc.correctionFocus && (
        <Collapsible title="Foco de corrección">
          <div style={bodyTextStyle}>{nc.correctionFocus}</div>
        </Collapsible>
      )}
      {nc.challenge && <ChallengeBlock challenge={nc.challenge} />}
      {nc.teacherNotes && (
        <Collapsible title="Notas para el profesor">
          <div style={bodyTextStyle}>{nc.teacherNotes}</div>
        </Collapsible>
      )}
      {nc.connectionToPrevious && (
        <Collapsible title="Conexión con clase anterior">
          <div style={bodyTextStyle}>{nc.connectionToPrevious}</div>
        </Collapsible>
      )}
    </div>
  );
}

function ChallengeBlock({ challenge }: { challenge: string }) {
  return (
    <div className="sp-challenge" style={{ margin: '14px 0' }}>
      <div className="sp-card-title">Tu desafío</div>
      <div className="sp-challenge-body" style={{ whiteSpace: 'pre-wrap' }}>{challenge}</div>
    </div>
  );
}

function Block({ title, block }: { title: string; block?: { title: string; duration: string; content: string } }) {
  if (!block) return null;
  return (
    <Collapsible title={block.title || title} meta={block.duration}>
      <div style={bodyTextStyle}>{block.content}</div>
    </Collapsible>
  );
}

/** Card de la clase con borde izquierdo verde. */
export function ClassCard({ nc, level, children }: { nc: GeneratedClassIA; level?: string | null; children?: React.ReactNode }) {
  const conversacion = isConversacionGuiada(nc);
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderLeft: `4px solid ${DRC_GREEN}`, borderRadius: 12, padding: 20,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 2 }}>
        Clase {nc.classNumber}{nc.duration ? ` · ${nc.duration}` : ''}
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
        {nc.classTitle}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <ClassBadge>{conversacion ? 'Conversación guiada' : 'Metodología aplicada'}</ClassBadge>
        {level && <ClassBadge>Nivel {level}</ClassBadge>}
      </div>
      <ClassContent nc={nc} />
      {children}
    </div>
  );
}

function ClassBadge({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 700, color: DRC_GREEN,
      background: 'rgba(30,158,58,0.1)', border: '1px solid rgba(30,158,58,0.35)',
      borderRadius: 20, padding: '2px 10px',
    }}>
      {children}
    </span>
  );
}

/** Texto plano para copiar al portapapeles. */
export function classToText(nc: GeneratedClassIA, studentName: string): string {
  const header = [
    nc.classTitle,
    `Clase ${nc.classNumber} — ${studentName}${nc.duration ? ` · ${nc.duration}` : ''}`,
    '='.repeat(48),
  ];

  if (isConversacionGuiada(nc)) {
    const list = (title: string, items: string[]) =>
      items?.length ? `\n${title}\n${items.map(i => `  - ${i}`).join('\n')}\n` : '';
    return [
      ...header,
      '\nCONVERSACIÓN GUIADA — charla continua; el tópico lo elige el alumno.',
      `\nHABILIDAD A TRABAJAR\n${'-'.repeat(48)}\n${nc.skillObjective}`,
      nc.priorityAddressed ? `\nPrioridad del diagnóstico: ${nc.priorityAddressed}` : '',
      list('APERTURAS DE TÓPICO', nc.suggestedOpeners),
      list('PREGUNTAS DIRIGIDAS', nc.guidingQuestions),
      nc.correctionFocus ? `\nFOCO DE CORRECCIÓN\n${'-'.repeat(48)}\n${nc.correctionFocus}` : '',
      nc.challenge ? `\nTU DESAFÍO\n${'-'.repeat(48)}\n${nc.challenge}` : '',
      nc.teacherNotes ? `\nNOTAS PARA EL PROFESOR\n${'-'.repeat(48)}\n${nc.teacherNotes}` : '',
      nc.connectionToPrevious ? `\nCONEXIÓN CON LA CLASE ANTERIOR\n${nc.connectionToPrevious}` : '',
    ].filter(Boolean).join('\n');
  }

  const b = (label: string, x?: { title: string; duration: string; content: string }) =>
    x ? `\n${(x.title || label).toUpperCase()}${x.duration ? ` · ${x.duration}` : ''}\n${'-'.repeat(48)}\n${x.content}\n` : '';
  return [
    ...header,
    nc.objectives?.length ? `\nOBJETIVOS\n${nc.objectives.map(o => `  - ${o}`).join('\n')}\n` : '',
    b('Warm-up', nc.warmUp),
    b('Contenido principal', nc.mainContent),
    b('Práctica', nc.practiceActivity),
    b('Cierre', nc.closing),
    nc.challenge ? `\nTU DESAFÍO\n${'-'.repeat(48)}\n${nc.challenge}` : '',
    nc.teacherNotes ? `\nNOTAS PARA EL PROFESOR\n${'-'.repeat(48)}\n${nc.teacherNotes}` : '',
    nc.connectionToPrevious ? `\nCONEXIÓN CON LA CLASE ANTERIOR\n${nc.connectionToPrevious}` : '',
  ].filter(Boolean).join('\n');
}

/** Copia con fallback para navegadores sin permiso de portapapeles. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* nada más que hacer */ }
    document.body.removeChild(ta);
  }
}
