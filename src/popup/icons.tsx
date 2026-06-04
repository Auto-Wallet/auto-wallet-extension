import React from 'react';

// Shared line-icon family (Lucide). Stroke-only, currentColor.
// Default size 16 unless overridden — most usages render at 12–18px.

interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
}

function Svg({
  size = 16,
  className,
  strokeWidth = 2,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function SendIcon(p: IconProps) {
  return <Svg {...p}><path d="M7 7h10v10M7 17L17 7"/></Svg>;
}

export function ReceiveIcon(p: IconProps) {
  return <Svg {...p}><path d="M17 7L7 17m10 0H7V7"/></Svg>;
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12a9 9 0 0 1 9-9a9.75 9.75 0 0 1 6.74 2.74L21 8"/>
      <path d="M21 3v5h-5"/>
      <path d="M21 12a9 9 0 0 1-9 9a9.75 9.75 0 0 1-6.74-2.74L3 16"/>
      <path d="M8 16H3v5"/>
    </Svg>
  );
}

export function ChevronDownIcon(p: IconProps) {
  return <Svg {...p}><path d="m6 9l6 6l6-6"/></Svg>;
}

export function ExternalLinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 3h6v6"/>
      <path d="M10 14L21 3"/>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    </Svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21l-4.34-4.34"/>
    </Svg>
  );
}

export function CloseIcon(p: IconProps) {
  return <Svg {...p}><path d="M18 6L6 18M6 6l12 12"/></Svg>;
}

export function QrCodeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="5" height="5" x="3" y="3" rx="1"/>
      <rect width="5" height="5" x="16" y="3" rx="1"/>
      <rect width="5" height="5" x="3" y="16" rx="1"/>
      <path d="M21 16h-3a2 2 0 0 0-2 2v3"/>
      <path d="M21 21v.01"/>
      <path d="M12 7v3a2 2 0 0 1-2 2H7"/>
      <path d="M3 12h.01"/>
      <path d="M12 3h.01"/>
      <path d="M12 16v.01"/>
      <path d="M16 12h1"/>
      <path d="M21 12v.01"/>
      <path d="M12 21v-1"/>
    </Svg>
  );
}

export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return <Svg {...p}><path d="M20 6L9 17l-5-5"/></Svg>;
}

export function WalletIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/>
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>
    </Svg>
  );
}

export function ShieldCheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
      <path d="m9 12l2 2l4-4"/>
    </Svg>
  );
}

export function LinkIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 17H7A5 5 0 0 1 7 7h2"/>
      <path d="M15 7h2a5 5 0 1 1 0 10h-2"/>
      <path d="M8 12h8"/>
    </Svg>
  );
}

export function ScrollIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 12h-5"/>
      <path d="M15 8h-5"/>
      <path d="M19 17V5a2 2 0 0 0-2-2H4"/>
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>
    </Svg>
  );
}

export function HistoryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
      <path d="M3 3v5h5"/>
      <path d="M12 7v5l4 2"/>
    </Svg>
  );
}

export function ZapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
    </Svg>
  );
}

export function BanIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10"/>
      <path d="m4.9 4.9 14.2 14.2"/>
    </Svg>
  );
}

export function SettingsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0a2.34 2.34 0 0 0 3.319 1.915a2.34 2.34 0 0 1 2.33 4.033a2.34 2.34 0 0 0 0 3.831a2.34 2.34 0 0 1-2.33 4.033a2.34 2.34 0 0 0-3.319 1.915a2.34 2.34 0 0 1-4.659 0a2.34 2.34 0 0 0-3.32-1.915a2.34 2.34 0 0 1-2.33-4.033a2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/>
      <circle cx="12" cy="12" r="3"/>
    </Svg>
  );
}

export function EyeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0"/>
      <circle cx="12" cy="12" r="3"/>
    </Svg>
  );
}

export function EyeOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575a1 1 0 0 1 0 .696a10.8 10.8 0 0 1-1.444 2.49"/>
      <path d="m14.084 14.158a3 3 0 0 1-4.242-4.242"/>
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 4.446-5.143"/>
      <path d="M2 2l20 20"/>
    </Svg>
  );
}

export function SunIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2"/>
      <path d="M12 20v2"/>
      <path d="M4.93 4.93l1.41 1.41"/>
      <path d="M17.66 17.66l1.41 1.41"/>
      <path d="M2 12h2"/>
      <path d="M20 12h2"/>
      <path d="M6.34 17.66l-1.41 1.41"/>
      <path d="M19.07 4.93l-1.41 1.41"/>
    </Svg>
  );
}

export function MoonIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>
    </Svg>
  );
}

export function MonitorIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect width="20" height="14" x="2" y="3" rx="2"/>
      <path d="M8 21h8"/>
      <path d="M12 17v4"/>
    </Svg>
  );
}

export function PlusIcon(p: IconProps) {
  return <Svg {...p}><path d="M12 5v14M5 12h14"/></Svg>;
}

export function SwapIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 7h13"/>
      <path d="M12 3l4 4l-4 4"/>
      <path d="M21 17H8"/>
      <path d="M12 21l-4-4l4-4"/>
    </Svg>
  );
}

export function StarIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 2l2.85 6.95l7.15.65l-5.4 4.7l1.65 7.7L12 17.77L5.75 22l1.65-7.7l-5.4-4.7l7.15-.65z"/>
    </Svg>
  );
}

export function ArrowDownIcon(p: IconProps) {
  return <Svg {...p}><path d="M12 5v14"/><path d="m6 13l6 6l6-6"/></Svg>;
}

export function GlobeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 2a14.5 14.5 0 0 0 0 20a14.5 14.5 0 0 0 0-20"/>
      <path d="M2 12h20"/>
    </Svg>
  );
}

export function GithubIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5c.08-1.25-.27-2.48-1-3.5c.28-1.15.28-2.35 0-3.5c0 0-1 0-3 1.5c-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5c-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/>
      <path d="M9 18c-4.51 2-5-2-7-2"/>
    </Svg>
  );
}

export function XIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m13.081 10.712l-4.786-6.71a.6.6 0 0 0-.489-.252H5.28a.6.6 0 0 0-.488.948l6.127 8.59m2.162-2.576l6.127 8.59a.6.6 0 0 1-.488.948h-2.526a.6.6 0 0 1-.489-.252l-4.786-6.71m2.162-2.576l5.842-6.962m-8.004 9.538L5.077 20.25"/>
    </Svg>
  );
}
