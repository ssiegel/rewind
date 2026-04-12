import { redirect } from "next/navigation";

export default async function SessionRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/?session=${encodeURIComponent(id)}`);
}
