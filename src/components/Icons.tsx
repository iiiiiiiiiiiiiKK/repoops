/** Inline SVG icon set — no icon font, no runtime dependency. */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const IconSearch = ({ size = 15, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </svg>
);

export const IconX = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </svg>
);

export const IconRefresh = ({ size = 15, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M13.5 7a5.5 5.5 0 1 0-1.6 4.3" />
    <path d="M13.5 2.5V7H9" />
  </svg>
);

export const IconMenu = ({ size = 17, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </svg>
);

export const IconPlus = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const IconExternal = ({ size = 12, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M9.5 2.5H13.5V6.5" />
    <path d="M13.5 2.5 7.5 8.5" />
    <path d="M12 9.5v3a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4h3" />
  </svg>
);

export const IconIssue = ({ size = 12, ...p }: P) => (
  <svg {...base(size)} {...p} strokeWidth={1.7}>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);

export const IconPull = ({ size = 12, ...p }: P) => (
  <svg {...base(size)} {...p} strokeWidth={1.7}>
    <circle cx="4.5" cy="3.5" r="1.8" />
    <circle cx="4.5" cy="12.5" r="1.8" />
    <circle cx="11.5" cy="12.5" r="1.8" />
    <path d="M4.5 5.3v5.4" />
    <path d="M11.5 10.7V6.5a2 2 0 0 0-2-2h-1" />
    <path d="M9.5 3 8 4.5 9.5 6" />
  </svg>
);

export const IconMoon = ({ size = 15, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" />
  </svg>
);

export const IconSun = ({ size = 15, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="3.2" />
    <path d="M8 1.5v1.6M8 12.9v1.6M2.4 8h1.6M12 8h1.6M4.2 4.2l1.1 1.1M10.7 10.7l1.1 1.1M11.8 4.2l-1.1 1.1M5.3 10.7l-1.1 1.1" />
  </svg>
);

export const IconCopy = ({ size = 13, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-1A1.5 1.5 0 0 0 9 3H3.5A1.5 1.5 0 0 0 2 4.5V10a1.5 1.5 0 0 0 1.5 1.5h1" />
  </svg>
);

export const IconCheck = ({ size = 13, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2.8 8.4l3 3 7.4-7.4" />
  </svg>
);

export const IconChart = ({ size = 15, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M2.5 13.5h11" />
    <rect x="3.5" y="8" width="2.6" height="5.5" rx="0.6" />
    <rect x="7" y="4" width="2.6" height="9.5" rx="0.6" />
    <rect x="10.5" y="6" width="2.6" height="7.5" rx="0.6" />
  </svg>
);

export const IconSettings = ({ size = 15, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.4M8 12.8v1.4M2.4 8h1.4M12.2 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M5 11l-1 1" />
  </svg>
);

export const IconLink = ({ size = 13, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7 4.5 8.4 3a2.4 2.4 0 0 1 3.4 3.4L10.4 7.8" />
    <path d="M9 11.5 7.6 13A2.4 2.4 0 0 1 4.2 9.6L5.6 8.2" />
  </svg>
);

export const IconWarn = ({ size = 14, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 2.5 14 13H2L8 2.5Z" />
    <path d="M8 6.2v3.2" />
    <circle cx="8" cy="11.2" r="0.5" fill="currentColor" />
  </svg>
);

export const IconClock = ({ size = 12, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 4.8V8l2.2 1.6" />
  </svg>
);

export const IconGithub = ({ size = 15, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden {...p}>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

/** The X (Twitter) glyph used top-right of the workspace. */
export const IconXSocial = ({ size = 15, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden {...p}>
    <path d="M12.6 1.5h2.3l-5 5.72L16 14.5h-4.63l-3.62-4.74-4.15 4.74H1.3l5.36-6.12L.5 1.5h4.75l3.27 4.33L12.6 1.5Zm-.81 11.62h1.28L4.27 2.8H2.9l8.89 10.32Z" />
  </svg>
);

export const IconSpinner = ({ size = 14, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden {...p}>
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.75s" repeatCount="indefinite" />
    </path>
  </svg>
);
