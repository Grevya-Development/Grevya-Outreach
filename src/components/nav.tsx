"use client";

import { Inbox, LayoutDashboard, LogOut, Mail, Send, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { logout } from "@/app/actions/auth";
import { cx } from "./ui";

const items = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/campaigns", label: "Campaigns", icon: Send },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/leads", label: "Leads", icon: Users }, // also /leads/find
  { href: "/mailboxes", label: "Email accounts", icon: Mail },
  { href: "/settings", label: "Settings", icon: Settings },
];

type Badges = { inboxCount?: number; accountProblem?: boolean };

// Inbox writes don't refresh the route, so the layout's To do count would go stale while you work
// through the Inbox. The Inbox publishes its live count here; the sidebar shows it until the
// layout renders a newer count from the server.
type LiveTodo = { value: number | null; ver: number };
const INITIAL_TODO: LiveTodo = { value: null, ver: 0 };
let liveTodo = INITIAL_TODO;
const todoListeners = new Set<() => void>();
const subscribeTodo = (fn: () => void) => { todoListeners.add(fn); return () => { todoListeners.delete(fn); }; };

/** Called by the Inbox whenever its To do count changes. */
export function publishTodoCount(n: number) {
  if (liveTodo.value === n) return;
  liveTodo = { value: n, ver: liveTodo.ver + 1 };
  todoListeners.forEach((fn) => fn());
}

export function Nav({ inboxCount = 0, accountProblem }: Badges) {
  const path = usePathname();
  const live = useSyncExternalStore(subscribeTodo, () => liveTodo, () => INITIAL_TODO);
  // A new server count wins over anything the Inbox published before it arrived.
  const [base, setBase] = useState({ count: inboxCount, ver: live.ver });
  if (base.count !== inboxCount) setBase({ count: inboxCount, ver: live.ver });
  const count = live.value != null && live.ver > base.ver ? live.value : inboxCount;
  return <NavList inboxCount={count} accountProblem={accountProblem} active={(href) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`))} />;
}

/** Icon-only row on phones; labelled column with Log out on desktop. Also the Suspense fallback (no badges). */
export function NavList({ active = () => false, inboxCount = 0, accountProblem = false }: Badges & { active?: (href: string) => boolean }) {
  return (
    <nav className="flex min-w-0 items-center justify-between md:justify-start md:flex-col md:items-stretch gap-0.5">
      {items.map(({ href, label, icon: Icon }) => {
        const on = active(href);
        const count = href === "/inbox" ? inboxCount : 0;
        const dot = href === "/mailboxes" && accountProblem;
        return (
          <Link
            key={href}
            href={href}
            aria-label={count ? `${label}, ${count} to do` : dot ? `${label}, needs attention` : label}
            aria-current={on ? "page" : undefined}
            className={cx(
              "relative flex shrink-0 items-center justify-center md:justify-start gap-2.5 size-9 md:size-auto md:h-8 md:px-2.5 rounded-lg text-[13.5px] whitespace-nowrap transition-colors duration-100",
              on ? "bg-panel text-ink font-medium shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink hover:bg-panel-2",
            )}
          >
            <Icon size={16} strokeWidth={on ? 2.2 : 1.8} className="shrink-0" />
            <span className="sr-only md:not-sr-only">{label}</span>
            {count > 0 && (
              <span className="absolute -top-0.5 -right-0.5 md:static md:ml-auto inline-flex items-center justify-center min-w-4 h-4 md:min-w-5 md:h-[18px] px-1 rounded-full bg-accent text-accent-ink text-[10px] md:text-[11px] font-semibold tabular-nums leading-none">
                {count > 99 ? "99+" : count}
              </span>
            )}
            {dot && <span className="absolute top-1.5 right-1.5 md:static md:ml-auto size-2 rounded-full bg-bad" />}
          </Link>
        );
      })}
      {/* On phones Log out lives in Settings, so the top bar never overflows. */}
      <form action={logout} className="hidden md:block md:mt-2 md:pt-2 md:border-t md:border-line">
        <button className="flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13.5px] text-muted hover:text-ink hover:bg-panel-2 w-full">
          <LogOut size={16} strokeWidth={1.8} />
          <span>Log out</span>
        </button>
      </form>
    </nav>
  );
}
