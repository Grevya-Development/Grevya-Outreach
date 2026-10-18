import { FileQuestion } from "lucide-react";
import { ButtonLink, Card, Empty } from "@/components/ui";

// Unmatched URLs render here, inside the root layout only (no sidebar), so centre it on the page.
export default function NotFound() {
  return (
    <main className="min-h-screen bg-bg grid place-items-center px-4 py-10">
      <Card className="w-full max-w-md fade-in">
        <Empty icon={<FileQuestion size={28} />} title="Page not found" action={<ButtonLink href="/" variant="primary">Go to Home</ButtonLink>}>
          This page doesn&apos;t exist or was deleted.
        </Empty>
      </Card>
    </main>
  );
}
