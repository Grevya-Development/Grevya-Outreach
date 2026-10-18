import Image from "next/image";
import clsx from "clsx";

/** Grevya logo. Switches to the light-wordmark version in dark mode. */
export function Logo({ className, priority }: { className?: string; priority?: boolean }) {
  return (
    <span className={clsx("relative inline-block", className)}>
      <Image src="/brand/grevya-logo.png" alt="Grevya" width={720} height={260} priority={priority} className="h-full w-auto dark:hidden" />
      <Image src="/brand/grevya-logo-dark.png" alt="Grevya" width={720} height={260} priority={priority} className="h-full w-auto hidden dark:block" />
    </span>
  );
}

/** Just the coloured mark (for tight spaces). */
export function LogoMark({ className }: { className?: string }) {
  return <Image src="/brand/grevya-mark.png" alt="Grevya" width={64} height={64} className={clsx("w-auto", className)} />;
}
