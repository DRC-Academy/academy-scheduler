'use client';

// Render de una clase generada, en secciones colapsables.

import type { NextClassIA } from '@/lib/aiTypes';
import { Collapsible, bodyTextStyle, DRC_GREEN } from '@/components/alumnos/ui';

export function ClassContent({ nc }: { nc: NextClassIA }) {
  return (
    <div>
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

function Block({ title, block }: { title: string; block?: { title: string; duration: string; content: string } }) {
  if (!block) return null;
  return (
    <Collapsible title={block.title || title} meta={block.duration}>
      <div style={bodyTextStyle}>{block.content}</div>
    </Collapsible>
  );
}

/** Card de la clase con borde izquierdo verde. */
export function ClassCard({ nc, children }: { nc: NextClassIA; children?: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderLeft: `4px solid ${DRC_GREEN}`, borderRadius: 12, padding: 20,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 2 }}>
        Clase {nc.classNumber}
      </div>
      <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 14 }}>
        {nc.classTitle}
      </div>
      <ClassContent nc={nc} />
      {children}
    </div>
  );
}

/** Texto plano para copiar al portapapeles. */
export function classToText(nc: NextClassIA, studentName: string): string {
  const b = (label: string, x?: { title: string; duration: string; content: string }) =>
    x ? `\n${(x.title || label).toUpperCase()}${x.duration ? ` · ${x.duration}` : ''}\n${'-'.repeat(48)}\n${x.content}\n` : '';
  return [
    nc.classTitle,
    `Clase ${nc.classNumber} — ${studentName}${nc.duration ? ` · ${nc.duration}` : ''}`,
    '='.repeat(48),
    nc.objectives?.length ? `\nOBJETIVOS\n${nc.objectives.map(o => `  - ${o}`).join('\n')}\n` : '',
    b('Warm-up', nc.warmUp),
    b('Contenido principal', nc.mainContent),
    b('Práctica', nc.practiceActivity),
    b('Cierre', nc.closing),
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
