'use client';

// ── Desplegable de secciones de /admin (escritorio, ≥ 768 px) ────────────────
//
// Reemplaza la fila de pestañas, que con dieciséis secciones ya no entraba y
// obligaba a deslizar de costado. En el teléfono no se pinta: ahí manda la
// barra inferior de AdminNavMovil (que oculta `.asm` por debajo de 768 px).
//
//   · Cerrado: "Sección: <la actual> ▾". Un puntito amarillo avisa si Validación,
//     Riesgo o Enlaces tienen pendientes, aunque el menú esté cerrado.
//   · Abierto: buscador arriba y las secciones agrupadas por tema (la misma lista
//     que el teléfono: components/admin/adminSecciones). Cada una con su
//     contador; la activa en verde con ✓. Próximos a cancelar es un enlace a otra
//     página y lo dice con un icono.
//   · Se cierra al elegir, al tocar afuera o con Escape. Flechas, Inicio/Fin y
//     Enter para moverse sin mouse. Scroll vertical interno, nunca horizontal.
//
// No decide qué se muestra: recibe la sección activa y los contadores, y avisa
// con `onSelect`. El contenido de cada sección sigue siendo el de la página.

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Check, ChevronDown, Search } from 'lucide-react';
import {
  GRUPOS_ADMIN, LABEL_DE, contadorDe, seccionVisible,
  type AdminContadores, type AdminTabId, type SeccionAdmin, type TonoContador,
} from '@/components/admin/adminSecciones';

/** Secciones cuyo contador se muestra en el escritorio (y enciende el puntito). */
const CON_CONTADOR = new Set<string>(['validacion', 'ai', 'emails']);

/** Sin tildes ni mayúsculas, para que "validacion" encuentre "Validación". */
const normal = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function Contador({ n, tono, titulo }: { n: number | null | undefined; tono: TonoContador; titulo?: string }) {
  if (!n) return null;
  return <span className={`asm-badge is-${tono}`} title={titulo}>{n}</span>;
}

export function AdminSeccionMenu({ activeTab, contadores, onSelect, tituloValidacion }: {
  activeTab: AdminTabId;
  contadores: AdminContadores;
  onSelect: (tab: AdminTabId) => void;
  /** Explicación del contador de Validación (cantidad y antigüedad), como el title de la pestaña vieja. */
  tituloValidacion?: string;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [resaltado, setResaltado] = useState(0);
  const raiz = useRef<HTMLDivElement>(null);
  const boton = useRef<HTMLButtonElement>(null);
  const buscador = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLDivElement>(null);
  const idLista = useId();

  // Los grupos con las secciones visibles que coinciden con la búsqueda, y la
  // misma lista aplanada para moverse con las flechas.
  const grupos = useMemo(() => {
    const q = normal(busqueda);
    return GRUPOS_ADMIN
      .map(g => ({
        nombre: g.nombre,
        secciones: g.secciones.filter(s => seccionVisible(s) && (!q || normal(s.label).includes(q) || normal(g.nombre).includes(q))),
      }))
      .filter(g => g.secciones.length > 0);
  }, [busqueda]);
  const plana = useMemo(() => grupos.flatMap(g => g.secciones), [grupos]);
  const indice = useMemo(() => new Map(plana.map((s, i) => [s.id, i])), [plana]);

  const contador = (id: string) => (CON_CONTADOR.has(id) ? contadorDe(id, contadores) : null);
  const hayPendientes = [...CON_CONTADOR].some(id => (contadorDe(id, contadores)?.n ?? 0) > 0);

  function abrir() {
    setBusqueda('');
    // Arranca resaltada la sección actual, así Enter sin moverse no cambia nada.
    const visibles = GRUPOS_ADMIN.flatMap(g => g.secciones.filter(seccionVisible));
    setResaltado(Math.max(0, visibles.findIndex(s => s.id === activeTab)));
    setAbierto(true);
  }

  function cerrar(devolverFoco = true) {
    setAbierto(false);
    if (devolverFoco) boton.current?.focus();
  }

  function elegir(s: SeccionAdmin) {
    cerrar();
    if (s.href) router.push(s.href);
    else onSelect(s.id as AdminTabId);
  }

  // Al abrir, el foco va al buscador.
  useEffect(() => { if (abierto) buscador.current?.focus(); }, [abierto]);

  // Clic afuera cierra (sin robarle el foco a lo que se tocó).
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: PointerEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAbierto(false);
    };
    document.addEventListener('pointerdown', fuera);
    return () => document.removeEventListener('pointerdown', fuera);
  }, [abierto]);

  // La opción resaltada siempre a la vista dentro del scroll del menú.
  useEffect(() => {
    if (!abierto) return;
    lista.current?.querySelector<HTMLElement>(`[data-idx="${resaltado}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [resaltado, abierto]);

  function teclas(e: React.KeyboardEvent) {
    const n = plana.length;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (n) setResaltado(i => (i + 1) % n); break;
      case 'ArrowUp':   e.preventDefault(); if (n) setResaltado(i => (i - 1 + n) % n); break;
      case 'Home':      if (n) { e.preventDefault(); setResaltado(0); } break;
      case 'End':       if (n) { e.preventDefault(); setResaltado(n - 1); } break;
      case 'Enter':     e.preventDefault(); { const s = plana.at(resaltado); if (s) elegir(s); } break;
      case 'Escape':    e.preventDefault(); cerrar(); break;
      case 'Tab':       cerrar(false); break;
    }
  }

  const idOpcion = (i: number) => `${idLista}-op-${i}`;

  return (
    <div className="asm" ref={raiz}>
      <button ref={boton} type="button" className={`asm-btn${abierto ? ' is-open' : ''}`}
        aria-haspopup="listbox" aria-expanded={abierto} aria-controls={abierto ? idLista : undefined}
        onClick={() => (abierto ? cerrar() : abrir())}
        onKeyDown={e => { if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !abierto) { e.preventDefault(); abrir(); } }}>
        <span className="asm-btn-k">Sección:</span>
        <span className="asm-btn-v">{LABEL_DE[activeTab] ?? activeTab}</span>
        {hayPendientes && <span className="asm-dot" aria-label="Hay secciones con pendientes" title="Hay secciones con pendientes" />}
        <ChevronDown size={16} strokeWidth={2.25} aria-hidden className="asm-chev" />
      </button>

      {abierto && (
        <div className="asm-pop" onKeyDown={teclas}>
          <label className="asm-search">
            <Search size={15} strokeWidth={2} aria-hidden />
            <input ref={buscador} type="text" value={busqueda} placeholder="Buscar sección…"
              role="combobox" aria-expanded="true" aria-controls={idLista} aria-autocomplete="list"
              aria-activedescendant={plana.length ? idOpcion(resaltado) : undefined}
              aria-label="Buscar sección"
              onChange={e => { setBusqueda(e.target.value); setResaltado(0); }} />
          </label>

          <div className="asm-list" id={idLista} role="listbox" aria-label="Secciones de Admin" ref={lista}>
            {grupos.length === 0 && <p className="asm-empty">Ninguna sección coincide.</p>}
            {grupos.map(g => (
              <div key={g.nombre} role="group" aria-label={g.nombre}>
                <p className="asm-grp" aria-hidden>{g.nombre}</p>
                {g.secciones.map(s => {
                  const i = indice.get(s.id) ?? 0;
                  const activa = s.id === activeTab;
                  const c = contador(s.id);
                  const clase = `asm-opt${activa ? ' is-cur' : ''}${i === resaltado ? ' is-hi' : ''}`;
                  const inner = (
                    <>
                      <span className="asm-check" aria-hidden>{activa && <Check size={15} strokeWidth={2.5} />}</span>
                      <span className="asm-opt-l">{s.label}</span>
                      {c && <Contador n={c.n} tono={c.tono} titulo={s.id === 'validacion' ? tituloValidacion : undefined} />}
                      {s.href && <ArrowUpRight size={15} strokeWidth={2} className="asm-ext" aria-label="abre otra página" />}
                    </>
                  );
                  const comun = {
                    id: idOpcion(i), role: 'option' as const, 'aria-selected': activa, 'data-idx': i, className: clase,
                    onMouseEnter: () => setResaltado(i),
                  };
                  return s.href
                    ? <Link key={s.id} href={s.href} {...comun} tabIndex={-1} onClick={() => cerrar(false)}>{inner}</Link>
                    : <div key={s.id} {...comun} onClick={() => elegir(s)}>{inner}</div>;
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
