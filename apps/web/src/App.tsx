import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ComparePage } from '@/pages/ComparePage';
import { HealthPage } from '@/pages/HealthPage';
import { HomePage } from '@/pages/HomePage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { RepoPage } from '@/pages/RepoPage';
import { SavedPage } from '@/pages/SavedPage';
import { SearchPage } from '@/pages/SearchPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TrendingPage } from '@/pages/TrendingPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="trending" element={<TrendingPage />} />
        <Route path="repo/:owner/:name" element={<RepoPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="health" element={<HealthPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="saved" element={<SavedPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
