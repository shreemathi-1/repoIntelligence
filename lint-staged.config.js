export default {
  '*.{ts,tsx,js,jsx}': ['eslint --max-warnings 0 --fix', 'prettier --write'],
  '*.{json,md,yml,yaml,css}': ['prettier --write'],
  'services/worker/**/*.py': [
    'services/worker/.venv/bin/ruff check --fix',
    'services/worker/.venv/bin/ruff format',
  ],
};
