import { useEffect, useState } from 'react';

/** True while the viewport is in the phone band (≤560px). */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 560px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(max-width: 560px)');
    const apply = () => setIsPhone(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);
  return isPhone;
}
