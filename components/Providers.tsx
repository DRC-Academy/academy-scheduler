'use client';
import { AuthProvider } from '@/lib/AuthContext';
import { TeachersProvider } from '@/lib/TeachersContext';
import { OnboardingProvider } from '@/lib/OnboardingContext';
import { OnboardingTour } from '@/components/OnboardingTour';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <TeachersProvider>
        <OnboardingProvider>
          {children}
          {/* El recorrido se monta UNA vez acá, no dentro del NavBar: así el
              resaltado sobrevive a los cambios de ruta y el overlay queda por
              encima de todo (portal a <body>). */}
          <OnboardingTour />
        </OnboardingProvider>
      </TeachersProvider>
    </AuthProvider>
  );
}
