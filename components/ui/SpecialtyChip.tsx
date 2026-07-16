'use client';
import { Badge } from './Badge';

// La especialidad es una CATEGORÍA, no un estado: no lleva color propio.
// Antes cada una tenía el suyo (Adultos azul, Niños naranja, Exámenes violeta),
// lo que pintaba de colores cada fila de las tablas sin comunicar nada — el
// label ya dice cuál es.
export function SpecialtyChip({ specialty }: { specialty: string }) {
  return <Badge tone="neutral">{specialty}</Badge>;
}
