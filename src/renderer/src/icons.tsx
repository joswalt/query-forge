/** Small inline icon set — stroke icons inherit `currentColor` so they follow
 * both themes. Decorative by default; pass a `title` to expose one. */
interface IconProps {
  size?: number
  title?: string
}

function Svg({
  size = 16,
  title,
  children
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {children}
    </svg>
  )
}

export const SunIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
  </Svg>
)

export const MoonIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
  </Svg>
)

export const PlusIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)

export const PlayIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="M4.5 2.8v10.4L13 8 4.5 2.8Z" fill="currentColor" />
  </Svg>
)

export const LockIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.6" />
    <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
  </Svg>
)

export const ChevronIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Svg>
)

export const CloseIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
)

export const DatabaseIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <ellipse cx="8" cy="3.8" rx="5" ry="2" />
    <path d="M3 3.8v8.4c0 1.1 2.2 2 5 2s5-.9 5-2V3.8M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
  </Svg>
)

/** Cosmos DB: documents orbiting a core — distinct from the SQL barrel. */
export const CosmosIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="1.6" />
    <ellipse cx="8" cy="8" rx="6.2" ry="2.8" transform="rotate(-30 8 8)" />
    <ellipse cx="8" cy="8" rx="6.2" ry="2.8" transform="rotate(30 8 8)" />
  </Svg>
)

export const MoreIcon = (p: IconProps): React.JSX.Element => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="0.6" />
    <circle cx="8" cy="8" r="0.6" />
    <circle cx="12.5" cy="8" r="0.6" />
  </Svg>
)
