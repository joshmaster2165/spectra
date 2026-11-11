/** Spectra mark: the prism from the brand artwork (docs/banner.webp), cropped. */
export function Logo({ size = 22 }: { size?: number }) {
  return <img src="/logo-mark.png" alt="" aria-hidden height={size} width={size * 2} className="logo-mark" />;
}
