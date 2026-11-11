/** Spectra mark: the prism traced from the brand artwork, on a transparent background. */
export function Logo({ size = 26 }: { size?: number }) {
  return <img src="/logo.svg" alt="" aria-hidden height={size} width={Math.round((size * 1040) / 540)} className="logo-mark" />;
}
