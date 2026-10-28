/** Search qualifiers for each trending list. Edit here to add a technology or use case. */
export interface TrendingTopic {
  id: string;
  label: string;
  qualifier: string;
}

export const TECHNOLOGIES: TrendingTopic[] = [
  { id: 'java', label: 'Java', qualifier: 'language:java' },
  { id: 'react', label: 'React', qualifier: 'topic:react' },
  { id: 'python', label: 'Python', qualifier: 'language:python' },
  { id: 'ai', label: 'AI', qualifier: 'topic:artificial-intelligence' },
  { id: 'llm', label: 'LLM', qualifier: 'topic:llm' },
];

export const USE_CASES: TrendingTopic[] = [
  { id: 'automation', label: 'Automation', qualifier: 'topic:automation' },
  { id: 'security', label: 'Security', qualifier: 'topic:security' },
  { id: 'rag', label: 'RAG', qualifier: 'topic:rag' },
  { id: 'agents', label: 'Agents', qualifier: 'topic:ai-agents' },
  { id: 'developer-tools', label: 'Developer tools', qualifier: 'topic:developer-tools' },
];

export const ALL_TOPICS: TrendingTopic[] = [...TECHNOLOGIES, ...USE_CASES];

/** Key used for the list that is not narrowed to any topic. */
export const OVERALL = 'all';
