import { Button, buttonVariants } from '@/components/ui/button';
import { useLogout, useMe } from '@/hooks/use-me';
import { loginUrl } from '@/lib/auth-urls';

export function UserMenu() {
  const { data: user, isPending } = useMe();
  const logout = useLogout();

  if (isPending) return null;

  if (!user) {
    return (
      <a href={loginUrl()} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Sign in with GitHub
      </a>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {user.avatarUrl && (
        <img src={user.avatarUrl} alt="" className="size-6 rounded-full" width={24} height={24} />
      )}
      <span className="text-sm">{user.login}</span>
      <Button
        variant="ghost"
        size="sm"
        disabled={logout.isPending}
        onClick={() => {
          logout.mutate();
        }}
      >
        Sign out
      </Button>
    </div>
  );
}
