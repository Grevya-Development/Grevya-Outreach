"use client";

import clsx from "clsx";
import { Inbox, LayoutDashboard, LogOut, Mail, MailCheck, Send, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logout } from "@/app/actions/auth";

const items = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campaigns", label: "Campaigns", icon: Send },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/verifier", label: "E-mail Verifier", icon: MailCheck },
  { href: "/mailboxes", label: "Mailboxes", icon: Mail },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const path = usePathname();
  return <NavList active={(href) => (href === "/" ? path === "/" : path.startsWith(href))} />;
}

export function NavList({ active = () => false }: { active?: (href: string) => boolean }) {
  return (
    <nav className="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={clsx(
            "flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13.5px] whitespace-nowrap transition-colors duration-100",
            active(href) ? "bg-panel text-ink font-medium shadow-[0_0_0_1px_var(--line)]" : "text-muted hover:text-ink hover:bg-panel-2",
          )}
        >
          <Icon size={16} strokeWidth={active(href) ? 2.2 : 1.8} />
          <span className="hidden sm:inline">{label}</span>
        </Link>
      ))}
      <form action={logout} className="md:mt-2 md:pt-2 md:border-t md:border-line">
        <button className="flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-[13.5px] text-muted hover:text-ink hover:bg-panel-2 w-full">
          <LogOut size={16} strokeWidth={1.8} />
          <span className="hidden sm:inline">Log out</span>
        </button>
      </form>
    </nav>
  );
}
