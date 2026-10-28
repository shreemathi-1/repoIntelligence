import { Outlet } from 'react-router-dom';
import { buttonVariants } from '@/components/ui/button';
import { useMe } from '@/hooks/use-me';
import { loginUrl } from '@/lib/auth-urls';

export function ProtectedRoute() {
  const { data: user, isPending } = useMe();

  if (isPending) return <p className="text-muted-foreground">Loading…</p>;
  if (!user) {
    return (
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Sign in required</h1>
        <p className="text-muted-foreground">You need to sign in with GitHub to see this page.</p>
        <a href={loginUrl()} className={buttonVariants()}>
          Sign in with GitHub
        </a>
      </section>
    );
  }
  return <Outlet />;
}
