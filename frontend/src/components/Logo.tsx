// DiskSleuth logo: hexagon (evidence/integrity) + magnifier lens + a spark in the middle (the detail that was found)
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="ds-logo-g" x1="10" y1="6" x2="54" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6aa6ff" />
          <stop offset="1" stopColor="#1f5fbf" />
        </linearGradient>
      </defs>
      <path d="M32 4 56.2 18v28L32 60 7.8 46V18Z" fill="#131a26" stroke="url(#ds-logo-g)" strokeWidth="4" strokeLinejoin="round" />
      <circle cx="29" cy="29" r="12" fill="none" stroke="url(#ds-logo-g)" strokeWidth="4.2" />
      <path d="M37.6 37.6 46 46" stroke="url(#ds-logo-g)" strokeWidth="5" strokeLinecap="round" />
      <circle cx="29" cy="29" r="3.6" fill="#ffd166" />
      <path d="M22.5 24.2a8 8 0 0 1 4.6-3.8" stroke="#fff" strokeOpacity=".55" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  )
}
