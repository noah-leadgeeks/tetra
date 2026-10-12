import { redirect } from "next/navigation";

import { CalendarView } from "@/components/calendar/calendar-view";
import { auth } from "@/server/auth";

export const metadata = {
  title: "Calendar — TETRA",
  description: "Schedule events, generate Google Meet calls, and sync with Google Calendar.",
};

const FALLBACK_TIMEZONE = "Asia/Jakarta";

export default async function CalendarPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const timeZone = session.user.timezone || FALLBACK_TIMEZONE;

  return (
    <div className="container mx-auto px-4 py-6 max-w-6xl">
      <CalendarView timezone={timeZone} hasGoogleAuth={session.hasGoogleAuth ?? false} />
    </div>
  );
}
