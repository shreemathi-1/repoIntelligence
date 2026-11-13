import type { FactSource, Interpretation } from '@repointelligence/shared';
import { Database, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { sourceLabel } from '@/lib/evolution-format';

interface FactsProps {
  sources: FactSource[];
  retrievedAt: string;
  notes: string[];
}

/** Says where a block of numbers came from. Facts are never written by a model. */
export function FactsSource({ sources, retrievedAt, notes }: FactsProps) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {sources.map((s) => (
          <Badge key={s} variant="outline" data-kind="fact">
            <Database aria-hidden />
            {sourceLabel(s)}
          </Badge>
        ))}
        <span className="text-muted-foreground text-xs">
          as of {new Date(retrievedAt).toLocaleString()}
        </span>
      </div>
      {notes.length > 0 && (
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface InterpretationProps {
  interpretation: Interpretation | null;
  note: string | null;
}

/** A model's reading of the facts, set apart from them and labelled with the model's name. */
export function InterpretationBox({ interpretation, note }: InterpretationProps) {
  if (!interpretation) {
    return note ? <p className="text-muted-foreground text-sm">{note}</p> : null;
  }
  return (
    <section
      aria-label="AI interpretation"
      className="space-y-2 rounded-lg border border-dashed border-violet-400/60 bg-violet-50/60 p-3 text-sm dark:bg-violet-950/30"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" data-kind="interpretation">
          <Sparkles aria-hidden />
          AI interpretation
        </Badge>
        <span className="text-muted-foreground text-xs">
          Written by {interpretation.writtenBy} from the facts shown; check it before relying on it.
        </span>
      </div>
      <p>{interpretation.summary}</p>
      {interpretation.highlights.length > 0 && (
        <div>
          <p className="font-medium">Highlights</p>
          <ul className="list-disc pl-5">
            {interpretation.highlights.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
      {interpretation.risks.length > 0 && (
        <div>
          <p className="font-medium">Upgrade risks</p>
          <ul className="list-disc pl-5">
            {interpretation.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
