'use client';

// Hook compartido de autocompletado del alumno a partir del email, usado por los
// formularios de asignación (setter, teacher). Al escribir un email válido:
//   1) Busca en la tabla `students` (dbGetStudentByEmail) — alumno ya existente.
//   2) Consulta WooCommerce vía /api/check-subscription?...&full=1.
// Devuelve los datos detectados (nombre, nivel, plan, fecha de inicio de
// suscripción, horas, clasificación) para que el formulario los precargue.

import { useEffect, useState } from 'react';
import { dbGetStudentByEmail } from '@/lib/db';
import { classifyPlan, detectWeeklyHours, type PlanClassification, type DetectionResult } from '@/lib/productUtils';
import type { Student } from '@/types';

export interface WooAutofill {
  productFullName: string | null;
  productType: 'subscription' | 'one_time' | null;
  billingName: string | null;
  detectedLevel: string | null;          // nivel A1–C2 detectado, o null
  subscriptionStartDate: string | null;  // 'YYYY-MM-DD'
  status: string | null;
  active: boolean | null;
  hoursFromApi: number | null;
}

export interface StudentAutofill {
  loading: boolean;
  existing: Student | null;              // alumno ya en la tabla students
  woo: WooAutofill | null;               // datos de WooCommerce (si hay producto)
  classification: PlanClassification | null;
  detection: DetectionResult | null;     // horas semanales sugeridas
  // Valores resueltos listos para precargar (existing tiene prioridad sobre woo).
  name: string | null;
  level: string | null;
  plan: string | null;
  startDate: string | null;
}

const EMPTY: StudentAutofill = {
  loading: false, existing: null, woo: null, classification: null, detection: null,
  name: null, level: null, plan: null, startDate: null,
};

export function useStudentAutofill(email: string, enabled = true): StudentAutofill {
  const [state, setState] = useState<StudentAutofill>(EMPTY);
  const norm = email.trim().toLowerCase();

  useEffect(() => {
    if (!enabled || !norm.includes('@')) { setState(EMPTY); return; }
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));

    const timer = setTimeout(async () => {
      try {
        const [existing, res] = await Promise.all([
          dbGetStudentByEmail(norm).catch(() => null),
          fetch(`/api/check-subscription?email=${encodeURIComponent(norm)}&full=1`).then(r => r.json()).catch(() => null),
        ]);
        if (cancelled) return;

        let woo: WooAutofill | null = null;
        let detection: DetectionResult | null = null;
        if (res) {
          woo = {
            productFullName:       res.productFullName ?? res.productName ?? null,
            productType:           res.productType ?? null,
            billingName:           res.billingName ?? null,
            detectedLevel:         res.detectedLevel ?? null,
            subscriptionStartDate: res.subscriptionStartDate ?? null,
            status:                res.status ?? null,
            active:                res.active ?? null,
            hoursFromApi:          res.hoursFromApi ?? null,
          };
          detection = await detectWeeklyHours(res.productName ?? '', res.productVariation ?? null, res.metaData ?? null, res.hoursFromApi ?? null);
        }

        // Plan/clasificación: producto real de Woo (principal) → plan local.
        const planText = woo?.productFullName ?? existing?.plan ?? null;
        const classification = (planText || existing)
          ? classifyPlan({ studentPlan: existing?.plan ?? null, productName: woo?.productFullName ?? null })
          : null;

        setState({
          loading: false,
          existing,
          woo,
          classification,
          detection,
          // existing tiene prioridad (dato ya confirmado en la academia).
          name:      existing?.name ?? woo?.billingName ?? null,
          level:     existing?.level ?? woo?.detectedLevel ?? null,
          plan:      planText,
          startDate: woo?.subscriptionStartDate ?? null,
        });
      } catch {
        if (!cancelled) setState(EMPTY);
      }
    }, 450);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [norm, enabled]);

  return state;
}
