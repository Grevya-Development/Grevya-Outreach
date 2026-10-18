import { FileQuestion } from "lucide-react";
import { ButtonLink, Card, Empty } from "@/components/ui";

export default function NotFound() {
  return (
    <Card className="fade-in">
      <Empty icon={<FileQuestion size={28} />} title="Page not found" action={<ButtonLink href="/" variant="primary">Go to Home</ButtonLink>}>
        This page doesn&apos;t exist or was deleted.
      </Empty>
    </Card>
  );
}
