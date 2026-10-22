'use client';

// Centro de ayuda del profesor: FAQ con búsqueda, filtro por categoría y
// acordeones. Contenido en lib/helpFaq.ts.
//
// Arriba de todo, la sección "Cancelaciones, recuperaciones y faltas" (contenido
// en lib/penaltyGuide.ts): reglas, casos y el botón que abre la guía paso a paso,
// siempre disponible, también después de que deje de salir el panel inferior.

import { useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { NavBar } from '@/components/NavBar';
import { AuthGuard } from '@/components/AuthGuard';
import {
  HELP_CATEGORIES, HELP_ITEMS, RATE_TABLE, haystack,
  type HelpCategory, type HelpItem,
} from '@/lib/helpFaq';
import {
  GUIDE_HELP_TITLE, GUIDE_RULES, GUIDE_CASES, GUIDE_BANNER, TEAM_WHATSAPP_URL,
} from '@/lib/penaltyGuide';
import { useOnboardingActions } from '@/lib/OnboardingContext';

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

  // La sección de la guía también responde al buscador: se filtran sus casos.
  const guideCases = useMemo(() => (
    searching
      ? GUIDE_CASES.filter(c => `${c.situation} ${c.action}`.toLowerCase().includes(q))
      : GUIDE_CASES
  ), [q, searching]);
  const showGuide = !searching || guideCases.length > 0 || GUIDE_HELP_TITLE.toLowerCase().includes(q);

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

        {showGuide && <GuideSection cases={guideCases} query={q} searching={searching} />}

        {grouped.length === 0 ? (
          showGuide ? null : (
          <div className="help-empty">
            No encontramos resultados para «{query.trim()}». Contacta con el equipo si
            necesitas ayuda adicional.
          </div>
          )
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

// Sección "Cancelaciones, recuperaciones y faltas": botón de la guía, reglas y
// casos (situación → qué hacer). En búsqueda solo quedan los casos que coinciden.
function GuideSection({ cases, query, searching }: {
  cases: typeof GUIDE_CASES; query: string; searching: boolean;
}) {
  const { openPenaltyGuide } = useOnboardingActions();
  return (
    <section className="help-guide" aria-labelledby="help-guide-title">
      <div className="help-guide-head">
        <div>
          <span className="help-guide-tag">{GUIDE_BANNER.tag}</span>
          <h2 id="help-guide-title" className="help-guide-title">{GUIDE_HELP_TITLE}</h2>
          <p className="help-guide-sub">Las reglas en corto y qué hacer en cada caso. La guía paso a paso te lo enseña sobre tu pantalla.</p>
        </div>
        <button type="button" className="help-guide-btn" onClick={openPenaltyGuide}>{GUIDE_BANNER.start}</button>
      </div>

      {!searching && (
        <table className="help-table help-guide-rules">
          <thead><tr>{GUIDE_RULES.head.map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {GUIDE_RULES.rows.map(([a, b]) => <tr key={a}><td>{a}</td><td>{b}</td></tr>)}
          </tbody>
        </table>
      )}

      {cases.length > 0 && (
        <>
          <div className="help-guide-cases-title">Qué hacer si…</div>
          <ul className="help-guide-cases">
            {cases.map(c => (
              <li key={c.id} className="help-guide-case">
                <span className="help-guide-sit">{highlight(c.situation, query)}</span>
                <span className="help-guide-act">{highlight(c.action, query)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {TEAM_WHATSAPP_URL && (
        <a className="help-guide-wa" href={TEAM_WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
          Escríbenos por WhatsApp
        </a>
      )}
    </section>
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
