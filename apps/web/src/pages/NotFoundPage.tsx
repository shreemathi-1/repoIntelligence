import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <section className="space-y-2">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link to="/" className="text-sm underline">
        Back to home
      </Link>
    </section>
  );
}
