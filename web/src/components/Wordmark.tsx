import { site } from "@/lib/site";

/** A cloche in one stroke: dome, lip, knob. */
export function ClocheMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <path d="M4 22c0-7.2 5.4-12.5 12-12.5S28 14.8 28 22" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M2.5 22.5h27" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="16" cy="7" r="2.6" fill="currentColor" />
      <path d="M16 9.5v1.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <ClocheMark className="text-gold" />
      <span className="display text-[1.15rem] tracking-[-0.02em]">{site.name}</span>
    </span>
  );
}
