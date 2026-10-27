/** Spectra mark: a prism splitting one beam into three. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="logo-mark">
      <path d="M1 12.5 H8.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3.5 L20.5 19.5 H3.5 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="miter" />
      <path d="M15.2 11.2 L23 7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15.8 12.6 L23 12.6" stroke="var(--active)" strokeWidth="1.5" />
      <path d="M16.4 14 L23 17.7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
