import type { Preferences } from '@repointelligence/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMe, useUpdatePreferences } from '@/hooks/use-me';
import { loginUrl } from '@/lib/auth-urls';
import { useThemeStore } from '@/stores/theme-store';

const THEMES: Preferences['theme'][] = ['system', 'light', 'dark'];

export function SettingsPage() {
  const { data: user } = useMe();
  const update = useUpdatePreferences();
  const setPreference = useThemeStore((state) => state.setPreference);

  if (!user) return null;
  const { preferences } = user;
  const needsReauth = preferences.privateRepoAccess && !user.privateRepoScope;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Theme</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2">
          {THEMES.map((theme) => (
            <Button
              key={theme}
              variant={preferences.theme === theme ? 'default' : 'outline'}
              size="sm"
              aria-pressed={preferences.theme === theme}
              onClick={() => {
                setPreference(theme);
                update.mutate({ theme });
              }}
            >
              {theme}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Private repositories</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={preferences.privateRepoAccess}
              onChange={(event) => {
                update.mutate({ privateRepoAccess: event.target.checked });
              }}
            />
            Allow access to my private repositories
          </label>
          {needsReauth && (
            <p className="text-muted-foreground">
              GitHub has not granted private access yet.{' '}
              <a className="underline" href={loginUrl(true)}>
                Sign in again to grant it
              </a>
              .
            </p>
          )}
          {update.isError && (
            <p role="alert" className="text-destructive">
              Could not save your settings.
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
