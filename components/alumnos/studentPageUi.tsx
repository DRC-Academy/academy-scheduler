'use client';

// Piezas compartidas por la página del alumno (/mis-alumnos/[studentId]) y la
// página pública de progreso (/progreso/[token]).

import { useState, type ReactNode } from 'react';

/**
 * La IA devuelve los puntos fuertes / errores como texto libre: a veces con
 * guiones o numeración, a veces como párrafo con frases separadas por punto.
 * Esto lo normaliza a una lista para poder pintarlo con viñetas.
 */
export function toBullets(text: string | null | undefined): string[] {
  const raw = (text ?? '').trim();
  if (!raw) return [];

  // 1) Si ya viene como lista (saltos de línea con guión/número/viñeta), la respetamos.
  const lines = raw.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
  const marked = lines.filter(l => /^([-–—*•]|\d+[.)])\s+/.test(l));
  if (marked.length >= 2) {
    return marked.map(l => l.replace(/^([-–—*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  }
  if (lines.length >= 2) return lines;

  // 2) Párrafo corrido: cortamos por punto/;  evitando abreviaturas obvias.
  const parts = raw.split(/(?<=[.;])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts.map(s => s.replace(/[.;]$/, '')) : [raw];
}

export function BulletList({ items, variant = 'ok' }: {
  items: string[]; variant?: 'ok' | 'warn' | 'error';
}) {
  if (items.length === 0) return null;
  const mark = variant === 'error' ? '✕' : '•';
  return (
    <ul className="sp-list">
      {items.map((t, i) => (
        <li key={i}>
          <span className={`sp-li-mark is-${variant}`} aria-hidden>{mark}</span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );
}

/** Acordeón: fila completa clickeable, cerrado por defecto. */
export function Accordion({ title, meta, defaultOpen = false, children }: {
  title: string; meta?: string; defaultOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sp-acc">
      <button className="sp-acc-trigger" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span>
          {title}
          {meta && <span style={{ fontWeight: 400, color: 'var(--sp-t3)' }}> · {meta}</span>}
        </span>
        <span className={`sp-acc-caret${open ? ' is-open' : ''}`} aria-hidden>▸</span>
      </button>
      {open && <div className="sp-acc-panel">{children}</div>}
    </div>
  );
}

/** Texto largo con "Ver más" (recorta a 3 líneas mientras está colapsado). */
export function ClampText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div>
      <div className={`sp-body${open ? '' : ' sp-clamp'}`}>{text}</div>
      {text.length > 180 && (
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            border: 'none', background: 'transparent', padding: '6px 0 0',
            color: '#1E9E3A', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {open ? 'Ver menos' : 'Ver más'}
        </button>
      )}
    </div>
  );
}

/**
 * "Progreso" en formato comparación. El texto de la IA suele mezclar lo que
 * mejoró con lo que sigue pendiente; separamos por palabras clave y, si no se
 * puede, mostramos el texto tal cual (nunca se pierde información).
 */
export function ProgressCompare({ text }: { text: string | null | undefined }) {
  const raw = (text ?? '').trim();
  if (!raw) return null;

  const bullets = toBullets(raw);
  const improved = bullets.filter(b => /mejor|avanz|logr|consigu|progres|domin/i.test(b));
  const pending  = bullets.filter(b => /pendiente|sigue|todav|aún|falta|cuesta|persist/i.test(b) && !improved.includes(b));

  if (improved.length === 0 && pending.length === 0) {
    return <div className="sp-body">{raw}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {improved.length > 0 && (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1E9E3A', marginBottom: 5 }}>Mejoró</div>
          <BulletList items={improved} />
        </div>
      )}
      {pending.length > 0 && (
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: '#9a6516', marginBottom: 5 }}>Pendiente</div>
          <BulletList items={pending} />
        </div>
      )}
    </div>
  );
}
