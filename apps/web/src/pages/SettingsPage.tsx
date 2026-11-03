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
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={preferences.allowPrivateRepoLlm}
              onChange={(event) => {
                update.mutate({ allowPrivateRepoLlm: event.target.checked });
              }}
            />
            <span>
              Let repository chat send private repository content to model providers.
              <span className="text-muted-foreground block">
                Only providers that do not train on inputs are used for private content; free tiers
                that may train on it are skipped.
              </span>
            </span>
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
          <div className="space-y-1 border-t pt-3">
            <p className="font-medium">Documentation pull requests</p>
            {user.docsWriteScope ? (
              <p className="text-muted-foreground">
                Allowed. Pull requests are only opened when you confirm them, as drafts on a new
                branch.
              </p>
            ) : (
              <p className="text-muted-foreground">
                Generated documentation can be proposed as a draft pull request. GitHub will ask you
                to grant write access to your repositories.{' '}
                <a className="underline" href={loginUrl(preferences.privateRepoAccess, true)}>
                  Allow documentation pull requests
                </a>
              </p>
            )}
          </div>
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
