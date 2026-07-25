import { requireUser } from "@/lib/auth/session";
import { WelcomeScreen } from "@/components/welcome-screen";

export default async function HomePage() {
  const user = await requireUser();
  return <WelcomeScreen displayName={user.displayName} />;
}
