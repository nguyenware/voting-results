import { useState, type FormEvent } from 'react';

interface Props {
  onSearch: (zip: string) => void;
  initialValue?: string;
  busy?: boolean;
}

/**
 * Examples chosen to show the cases the site exists to handle, not just a
 * happy path: one clean single-county ZIP, one that splits across a county
 * line, and one whose area and population disagree about which county it is in.
 */
const EXAMPLES: Array<{ zip: string; note: string }> = [
  { zip: '98101', note: 'Seattle — one county' },
  { zip: '98022', note: 'Enumclaw — splits King/Pierce' },
  { zip: '98944', note: 'Sunnyside — area vs. population' },
];

export function ZipSearch({ onSearch, initialValue = '', busy = false }: Props) {
  const [value, setValue] = useState(initialValue);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSearch(value);
  }

  function pick(zip: string) {
    setValue(zip);
    onSearch(zip);
  }

  return (
    <form className="zip-search" onSubmit={submit}>
      <label className="zip-search__label" htmlFor="zip">
        Enter a Washington ZIP code
      </label>
      <div className="zip-search__row">
        <input
          id="zip"
          className="zip-search__input"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="98101"
          maxLength={10}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="zip-hint"
        />
        <button className="zip-search__button" type="submit" disabled={busy}>
          {busy ? 'Loading…' : 'Show results'}
        </button>
      </div>
      <p id="zip-hint" className="zip-search__hint">
        Washington reports results by county, not by ZIP code. We map your ZIP to the counties it
        covers and show the contests on those ballots.
      </p>
      <div className="zip-search__examples">
        <span className="zip-search__examples-label">Try:</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.zip}
            type="button"
            className="chip"
            onClick={() => pick(example.zip)}
          >
            <strong>{example.zip}</strong>
            <span>{example.note}</span>
          </button>
        ))}
      </div>
    </form>
  );
}
