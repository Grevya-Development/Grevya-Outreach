import { connection } from "next/server";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui";
import { getProfile } from "@/lib/profile";
import { ProfileForm } from "./settings-client";

export const metadata = { title: "Company profile" };

export default function CompanyProfilePage() {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <Profile />
    </Suspense>
  );
}

function ProfileSkeleton() {
  return (
    <div className="grid gap-4">
      <Skeleton className="h-12 rounded-xl" />
      <Skeleton className="h-[420px] rounded-xl" />
      <Skeleton className="h-[180px] rounded-xl" />
    </div>
  );
}

async function Profile() {
  await connection(); // always the saved profile, never prerendered
  return <ProfileForm initial={await getProfile()} />;
}
