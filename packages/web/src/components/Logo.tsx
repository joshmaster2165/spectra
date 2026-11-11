/**
 * Spectra mark: dispersion. A single point of origin throwing a fan of rays —
 * one line of sight split into the signals the second seat reads. Sharp, open,
 * not a ring. The spread runs the app's own status colours.
 */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="logo-mark">
      <g strokeWidth="1.6" strokeLinecap="round">
        <path d="M4 20 16.2 5.4" stroke="var(--active)" />
        <path d="M4 20 19.4 8.8" stroke="currentColor" />
        <path d="M4 20 21.6 12.9" stroke="currentColor" />
        <path d="M4 20 22.8 17.4" stroke="var(--accent)" />
      </g>
      <circle cx="4" cy="20" r="1.7" fill="currentColor" />
    </svg>
  );
}
