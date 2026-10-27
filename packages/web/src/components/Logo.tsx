/**
 * Spectra mark: an aperture. A ring split into three bands around a fixed
 * point — a lens that watches, and light broken into its components.
 */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className="logo-mark">
      <g strokeWidth="2.4" strokeLinecap="butt">
        <path d="M13.56 3.14 A9 9 0 0 1 20.46 15.08" stroke="var(--active)" />
        <path d="M18.89 17.79 A9 9 0 0 1 5.11 17.79" stroke="currentColor" />
        <path d="M3.54 15.08 A9 9 0 0 1 10.44 3.14" stroke="currentColor" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
