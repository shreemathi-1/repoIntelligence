import { Link } from 'react-router-dom';
import { buttonVariants } from '@/components/ui/button';

export function HomePage() {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Understand any GitHub repository</h1>
      <p className="text-muted-foreground max-w-2xl">
        RepoIntelligence will score repository health, map architecture and answer questions with
        citations. This build is the foundation: the API and worker are wired up and reporting their
        status.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to="/search" className={buttonVariants()}>
          Search repositories
        </Link>
        <Link to="/trending" className={buttonVariants({ variant: 'outline' })}>
          See what is trending
        </Link>
        <Link to="/health" className={buttonVariants({ variant: 'ghost' })}>
          System health
        </Link>
      </div>
    </section>
  );
}
