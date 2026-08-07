'use client';
// Lectura LIGERA de las fichas de alumno para las pantallas de admin y setter.
//
// Trae solo las cuatro columnas del semáforo (progreso y riesgo), nunca los
// transcripts ni la ficha completa: la usan "Próximos a cancelar" y "Alumnos"
// para pintar un badge por fila, no para mostrar la ficha entera. Cargar
// `select('*')` de student_profiles ahí serían cientos de KB de texto por una
// bolita de color.
//
// No la usa el profesor: él tiene lib/misAlumnos, que sí necesita la ficha
// completa de SUS alumnos.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { EndingProfileRow } from '@/lib/endingPlans';

const COLS = 'student_id, student_name, progress_score, risk_signal';

export function useStudentProfiles(): { profiles: EndingProfileRow[]; loading: boolean } {
  const [profiles, setProfiles] = useState<EndingProfileRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.from('student_profiles').select(COLS);
      if (cancelled) return;
      if (error) {
        // Sin fichas la pantalla funciona igual: el semáforo dice "sin datos",
        // que es la verdad. No se rompe la vista por un badge.
        console.error('[useStudentProfiles] No se pudieron leer las fichas:', error);
        setProfiles([]);
      } else {
        setProfiles((data ?? []) as unknown as EndingProfileRow[]);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  return { profiles, loading };
}
