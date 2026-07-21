'use client';

// Centro de ayuda del profesor: FAQ con búsqueda, filtro por categoría y
// acordeones. Contenido en lib/helpFaq.ts.

import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import {
  HELP_CATEGORIES, HELP_ITEMS, RATE_TABLE, haystack,
  type HelpCategory, type HelpItem,
} from '@/lib/helpFaq';

type Filter = 'all' | HelpCategory;

function AyudaContent() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // Acordeón abierto (uno a la vez) cuando NO hay búsqueda.
  const [open, setOpen] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const results = useMemo(() => {
    return HELP_ITEMS.filter(item => {
      if (searching) return haystack(item).includes(q);
      return filter === 'all' || item.category === filter;
    });
  }, [q, searching, filter]);

  // Agrupar por categoría, respetando el orden de HELP_CATEGORIES.
  const grouped = useMemo(() => (
    HELP_CATEGORIES
      .map(cat => ({ cat, items: results.filter(r => r.category === cat.id) }))
      .filter(g => g.items.length > 0)
  ), [results]);

  const isOpen = (item: HelpItem) => (searching ? true : open === item.id);

  function toggle(item: HelpItem) {
    if (searching) return;                 // en búsqueda están todas abiertas
    setOpen(prev => (prev === item.id ? null : item.id));
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F7F7F5' }}>
      <NavBar />
      <div className="help">
        <button className="help-back" onClick={() => router.back()}>
          <span aria-hidden>←</span> Volver
        </button>

        <header className="help-head">
          <h1 className="help-title">Centro de ayuda</h1>
          <p className="help-sub">Encuentra respuestas a las preguntas más frecuentes</p>
        </header>

        <div className="help-search">
          <span className="help-search-icon" aria-hidden>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Busca una pregunta..."
            aria-label="Buscar en el centro de ayuda"
          />
        </div>

        {/* Los chips no tienen sentido durante la búsqueda: se ocultan. */}
        {!searching && (
          <div className="help-chips" role="group" aria-label="Filtrar por categoría">
            {([{ id: 'all', label: 'Todas' }, ...HELP_CATEGORIES] as Array<{ id: Filter; label: string }>).map(c => (
              <button
                key={c.id}
                className="help-chip"
                aria-pressed={filter === c.id}
                onClick={() => { setFilter(c.id); setOpen(null); }}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {grouped.length === 0 ? (
          <div className="help-empty">
            No encontramos resultados para «{query.trim()}». Contacta con el equipo si
            necesitas ayuda adicional.
          </div>
        ) : (
          grouped.map(({ cat, items }) => (
            <section key={cat.id} className="help-cat">
              <div className="help-cat-title">{cat.label}</div>
              <div className="help-acc">
                {items.map(item => (
                  <div key={item.id} className="help-item">
                    <button
                      className="help-q"
                      aria-expanded={isOpen(item)}
                      onClick={() => toggle(item)}
                    >
                      <span className="help-q-text">{highlight(item.question, q)}</span>
                      <span className={`help-q-caret${isOpen(item) ? ' is-open' : ''}`} aria-hidden>▸</span>
                    </button>
                    {isOpen(item) && (
                      <div className="help-a">
                        {item.table
                          ? <RateTable query={q} />
                          : <p>{highlight(item.answer, q)}</p>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

// Tabla de tarifas (P10). El texto también se resalta si coincide con la búsqueda.
function RateTable({ query }: { query: string }) {
  return (
    <table className="help-table">
      <thead>
        <tr>{RATE_TABLE.head.map(h => <th key={h}>{highlight(h, query)}</th>)}</tr>
      </thead>
      <tbody>
        {RATE_TABLE.rows.map((row, i) => (
          <tr key={i}>{row.map((cell, j) => <td key={j}>{highlight(cell, query)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

// Envuelve en <mark> las coincidencias de `query` dentro de `text`.
function highlight(text: string, query: string): ReactNode {
  if (!query) return text;
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase()
      ? <mark key={i}>{part}</mark>
      : <span key={i}>{part}</span>,
  );
}

export default function AyudaPage() {
  return (
    <AuthGuard allowedRoles={['teacher']}>
      <AyudaContent />
    </AuthGuard>
  );
}
