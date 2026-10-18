import Image from "next/image";
import { cx } from "./ui";

/**
 * Grevya logo. Switches to the light-wordmark version in dark mode. Callers set the height and may
 * set the display (e.g. "hidden md:inline-block"); cx lets theirs replace the inline-block default.
 */
export function Logo({ className, priority }: { className?: string; priority?: boolean }) {
  return (
    <span className={cx("relative inline-block", className)}>
      <Image src="/brand/grevya-logo.png" alt="Grevya" width={720} height={260} priority={priority} className="h-full w-auto dark:hidden" />
      <Image src="/brand/grevya-logo-dark.png" alt="Grevya" width={720} height={260} priority={priority} className="h-full w-auto hidden dark:block" />
    </span>
  );
}

/** Just the square coloured mark (for tight spaces). */
export function LogoMark({ className }: { className?: string }) {
  return <Image src="/brand/grevya-mark.png" alt="Grevya" width={64} height={64} className={cx("h-7 w-7 object-contain shrink-0", className)} />;
}
