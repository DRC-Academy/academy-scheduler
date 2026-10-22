'use client';
import { AuthProvider } from '@/lib/AuthContext';
import { TeachersProvider } from '@/lib/TeachersContext';
import { HistorialHorariosProvider } from '@/lib/HistorialHorariosContext';
import { OnboardingProvider } from '@/lib/OnboardingContext';
import { OnboardingTour } from '@/components/OnboardingTour';
import { PenaltyGuideBanner } from '@/components/PenaltyGuideBanner';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TeachersProvider>
        <HistorialHorariosProvider>
        <OnboardingProvider>
          {children}
          {/* El recorrido se monta UNA vez acá, no dentro del NavBar: así el
              resaltado sobrevive a los cambios de ruta y el overlay queda por
              encima de todo (portal a <body>). */}
          <OnboardingTour />
          {/* Aviso de la guía de penalizaciones (solo profesores, hasta el 01/11/2026). */}
          <PenaltyGuideBanner />
        </OnboardingProvider>
        </HistorialHorariosProvider>
      </TeachersProvider>
    </AuthProvider>
  );
}
