'use client';

// ── Diploma: tarjeta compacta junto al saludo ─────────────────────────────────
//
// Desde el 30/09/2026 es el diploma de la ficha del alumno (sustituye al banner
// de components/DiplomaCalendario). Lo monta components/ProgresoFichaV2 por
// `diplomaSlot`, desde las dos rutas:
//   · /progreso/[token]  → DiplomaV2FromToken (el navegador pide /api/progreso/diploma);
//   · /progreso-cuenta   → DiplomaV2FromPromise (el servidor pasa la promesa del LMS).
//
// QUÉ SE ENSEÑA lo decide lib/diplomaCalendario.bannerDe: conseguido, vencido,
// hoy, días, meses, o nada sin fecha de inicio. Aquí solo se redacta
// ("2 meses y 5 días" · "para tu diploma · 38 de 168 lecciones") y se pinta.
// Mientras el LMS no contesta se cuenta por fecha; la segunda línea existe
// siempre, así que nada salta cuando llega.
//
// TODA LA TARJETA ES EL ENLACE a la plataforma (el mismo destino de siempre).

import { use, useEffect, useState } from 'react';
import type { Diploma } from '@/lib/diplomaTypes';
import { bannerDe, type DiplomaEstadoSlot } from '@/lib/diplomaCalendario';
import { madridToday } from '@/lib/subscriptionAccess';
import { LMS_PUBLIC_URL } from '@/lib/lmsUrl';

/** Ficha embebida (/progreso-cuenta): el servidor pasa la promesa sin esperarla. */
export function DiplomaV2FromPromise({ promise, startDate = null }: { promise: Promise<Diploma | null>; startDate?: string | null }) {
  const diploma = use(promise);
  return <DiplomaBannerV2 diploma={diploma} startDate={startDate} />;
}

/** Ficha pública (/progreso/[token]): se pide a /api/progreso/diploma desde el navegador. */
export function DiplomaV2FromToken({ token, startDate = null }: { token: string | null; startDate?: string | null }) {
  const [diploma, setDiploma] = useState<DiplomaEstadoSlot>(token ? 'cargando' : null);

  useEffect(() => {
    if (!token) return;
    let cancelado = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    fetch(`/api/progreso/diploma?token=${encodeURIComponent(token)}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then((j: { diploma?: Diploma | null } | null) => {
        if (cancelado) return;
        const d = j?.diploma ?? null;
        setDiploma(d && typeof d.estado === 'string' ? d : null);
      })
      .catch(() => { if (!cancelado) setDiploma(null); })
      .finally(() => clearTimeout(timer));
    return () => { cancelado = true; ctrl.abort(); clearTimeout(timer); };
  }, [token]);

  return <DiplomaBannerV2 diploma={diploma} startDate={startDate} />;
}

/** Quita la flecha y el ✓ de los textos compartidos: aquí los pone el dibujo. */
const limpio = (s: string) => s.replace(/\s*[→✓]\s*$/u, '');

export function DiplomaBannerV2({ diploma, startDate = null }: { diploma: DiplomaEstadoSlot; startDate?: string | null }) {
  const b = bannerDe(diploma, startDate, madridToday());
  if (!b) return null;

  const conseguido = b.tipo === 'conseguido';
  const cuenta = b.cifras.map(c => `${c.valor} ${c.unidad.toLowerCase()}`).join(' y ');

  return (
    <a className="p2-dip" href={LMS_PUBLIC_URL} target="_blank" rel="noopener">
      <span className="p2-dip-ico" aria-hidden>
        {conseguido ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" fill="#1E9E3A" />
            <path d="M7.5 12.5l3 3 6-6.5" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 3l2.6 2 3.3-.2.8 3.2 2.6 2-1.4 3 .4 3.3-3.2.9-1.9 2.7L12 18.4 8.8 19.9 6.9 17.2l-3.2-.9.4-3.3-1.4-3 2.6-2 .8-3.2 3.3.2z" stroke="#0E5A23" strokeWidth="1.8" strokeLinejoin="round" />
            <circle cx="12" cy="11.5" r="3" fill="#FFC400" />
          </svg>
        )}
      </span>
      <span className="p2-dip-texto">
        {b.tipo === 'cuenta' ? (
          <span className="p2-dip-cifra">{cuenta}</span>
        ) : b.tipo === 'hoy' ? (
          <span className="p2-dip-cifra">{b.titular} {b.leyenda}</span>
        ) : (
          <span className="p2-dip-titular">
            <span className="p2-solo-ancho">{limpio(b.titular ?? '')}</span>
            <span className="p2-solo-movil">{limpio(b.titularCorto ?? b.titular ?? '')}</span>
          </span>
        )}
        {/* La segunda línea existe siempre (con cuenta dice "para tu diploma"; sin
            ella queda reservada hasta que contesta el LMS): nada salta cuando llega. */}
        <span className="p2-dip-lecciones">
          {[b.tipo === 'cuenta' ? b.leyenda : null, b.lecciones].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="p2-dip-accion">
        <span className="p2-dip-accion-txt">{limpio(b.enlace)}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </a>
  );
}
