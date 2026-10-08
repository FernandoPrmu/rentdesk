import { companyInitials } from "@/lib/branding/logo";
import { cn } from "@/lib/utils";

/** Company logo (signed URL) or, without one, the company's initials (BRD-02). */
export function BrandLogo({ name, logoUrl, className }: { name: string; logoUrl: string | null; className?: string }) {
  if (logoUrl) {
    return (
      // A short-lived signed URL from private storage: plain <img>, no image optimiser.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt={`${name} logo`} className={cn("size-9 shrink-0 rounded-md object-contain", className)} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground",
        className,
      )}
    >
      {companyInitials(name)}
    </span>
  );
}

export function BrandBadge({ name, logoUrl, subtitle }: { name: string; logoUrl: string | null; subtitle?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <BrandLogo name={name} logoUrl={logoUrl} />
      <div className="min-w-0 leading-tight">
        <p className="truncate font-semibold">{name}</p>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}
