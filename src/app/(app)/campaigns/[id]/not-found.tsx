import { ArrowLeft, FileQuestion } from "lucide-react";
import { ButtonLink, Card, Empty } from "@/components/ui";

export default function CampaignNotFound() {
  return (
    <Card className="fade-in">
      <Empty icon={<FileQuestion size={28} />} title="Campaign not found"
        action={<ButtonLink href="/campaigns" variant="primary"><ArrowLeft size={15} />Back to campaigns</ButtonLink>}>
        This campaign doesn&apos;t exist or was deleted.
      </Empty>
    </Card>
  );
}
