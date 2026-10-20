import type { ReactNode } from "react";

function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {children}
    </svg>
  );
}

export const PinIcon = () => (
  <Icon>
    <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </Icon>
);
export const ClockIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);
export const SearchIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
  </Icon>
);
export const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
);
export const DropIcon = () => (
  <Icon>
    <path d="M12 3s6 6.3 6 11a6 6 0 0 1-12 0c0-4.7 6-11 6-11Z" />
  </Icon>
);
export const OutIcon = () => (
  <Icon>
    <path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9" />
  </Icon>
);
export const PeopleIcon = () => (
  <Icon>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20c.8-3.3 3.3-5 6-5s5.2 1.7 6 5" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21 20c-.5-2.2-1.7-3.7-3.3-4.5" />
  </Icon>
);
export const ChartIcon = () => (
  <Icon>
    <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
  </Icon>
);
export const ListIcon = () => (
  <Icon>
    <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
  </Icon>
);
export const CalendarIcon = () => (
  <Icon>
    <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" />
    <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
  </Icon>
);
export const CameraIcon = () => (
  <Icon>
    <path d="M4 8h3l1.5-2h7L17 8h3v11H4Z" />
    <circle cx="12" cy="13.5" r="3.2" />
  </Icon>
);
export const ChatIcon = () => (
  <Icon>
    <path d="M4 5h16v11H9l-5 4Z" />
  </Icon>
);
export const InboxIcon = () => (
  <Icon>
    <path d="M4 13 6.5 5h11L20 13M4 13v6h16v-6M4 13h5l1 2h4l1-2h5" />
  </Icon>
);
export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3 5 6v5.5c0 4.2 2.8 7.5 7 9.5 4.2-2 7-5.3 7-9.5V6Z" />
    <path d="m9.5 12 2 2 3.5-4" />
  </Icon>
);
