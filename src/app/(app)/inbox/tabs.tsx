import { TabLinks } from "@/components/ui";

/** Replies | Sent, above both inbox pages. */
export function InboxTabs({ active }: { active: "replies" | "sent" }) {
  return (
    <TabLinks items={[
      { href: "/inbox", label: "Replies", active: active === "replies" },
      { href: "/inbox/sent", label: "Sent", active: active === "sent" },
    ]} />
  );
}
