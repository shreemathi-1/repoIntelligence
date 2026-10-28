import { Moon, Sun } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { UserMenu } from '@/components/layout/UserMenu';
import { useThemeStore } from '@/stores/theme-store';

const links = [
  { to: '/', label: 'Home', end: true },
  { to: '/search', label: 'Search', end: false },
  { to: '/trending', label: 'Trending', end: false },
  { to: '/compare', label: 'Compare', end: false },
  { to: '/saved', label: 'Saved', end: false },
  { to: '/health', label: 'Health', end: false },
  { to: '/settings', label: 'Settings', end: false },
];

export function AppLayout() {
  const { theme, toggle } = useThemeStore();

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <span className="font-semibold">RepoIntelligence</span>
          <nav className="flex items-center gap-1" aria-label="Main">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 text-sm',
                    isActive ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50',
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <UserMenu />
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
