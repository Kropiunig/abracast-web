// Lightweight inline-SVG icon set. All icons inherit `currentColor`, so they
// match whatever text color the surrounding element uses. Purely presentational.

const PATHS = {
  trendUp: (
    <>
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="15 7 21 7 21 13" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="6" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  news: (
    <>
      <path d="M4 5h13v15H6a2 2 0 0 1-2-2z" />
      <path d="M17 9h3v9a2 2 0 0 1-2 2" />
      <path d="M8 9h6M8 13h6M8 17h4" />
    </>
  ),
  bars: (
    <>
      <path d="M4 4v16h16" />
      <path d="M8 16v-3M12 16V9M16 16v-6" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 4 21 9 16 9" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 21h8M12 17v4" />
      <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
      <path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  droplet: <path d="M12 3c3 3.5 6 7 6 10.5a6 6 0 0 1-12 0C6 10 9 6.5 12 3z" />,
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M14.5 9.3A2.2 2.2 0 0 0 12.5 8.5h-1.2a1.6 1.6 0 0 0 0 3.2h1.4a1.6 1.6 0 0 1 0 3.2h-1.4a2.2 2.2 0 0 1-2-1" />
    </>
  ),
  bank: (
    <>
      <path d="M4 10l8-5 8 5" />
      <path d="M6 10v8M10 10v8M14 10v8M18 10v8" />
      <path d="M3 21h18" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
      <circle cx="10" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="11" r="1" fill="currentColor" stroke="none" />
      <path d="M9.5 15h5" />
    </>
  ),
  hourglass: (
    <>
      <path d="M6 3h12M6 21h12" />
      <path d="M7 3c0 4 5 5 5 9s-5 5-5 9M17 3c0 4-5 5-5 9s5 5 5 9" />
    </>
  ),
  check: <polyline points="20 6 9 17 4 12" />,
  alert: (
    <>
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="8.5 12.5 11 15 15.5 10" />
    </>
  ),
  xCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />,
  spark: <path d="M12 3l1.7 5L19 9.7l-5.3 1.7L12 16l-1.7-4.6L5 9.7l5.3-1.7z" />,
};

export function Icon({ name, size = 16, style }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {PATHS[name] || null}
    </svg>
  );
}

// Brand mark: a gradient crystal ball with a sparkle — replaces the 🔮 emoji.
export function Logo({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="abracast-orb" x1="4" y1="3" x2="28" y2="27" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a855f7" />
          <stop offset="1" stopColor="#06b6d4" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="14" r="8.5" fill="url(#abracast-orb)" opacity="0.18" />
      <circle cx="16" cy="14" r="8.5" stroke="url(#abracast-orb)" strokeWidth="2" />
      <path d="M11.5 16.5a4.5 4.5 0 0 1 3.5-6.5" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
      <path d="M9 25.5h14" stroke="url(#abracast-orb)" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M24 5l.7 2.1L27 7.8l-2.3.7L24 11l-.7-2.5L21 7.8l2.3-.7z" fill="#ffffff" />
    </svg>
  );
}
